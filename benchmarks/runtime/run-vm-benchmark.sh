#!/usr/bin/env bash
# Benchmark the checked-out branch as the production Docker default profile.
# Lifecycle timings are recorded separately from load-performance metrics.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker/docker-compose.yml"
PROJECT_NAME="${BENCH_PROJECT_NAME:-logtide-runtime-benchmark}"
BACKEND_CONTAINER="logtide-backend"
RUN_ID="${RUN_ID:-$(git -C "$ROOT_DIR" branch --show-current | tr '/' '-')-$(date -u +%Y%m%dT%H%M%SZ)}"
RESULT_DIR="${BENCH_RESULT_DIR:-$ROOT_DIR/benchmark-results/runtime/$RUN_ID}"
ENV_FILE="$RESULT_DIR/benchmark.env"
RATE="${BENCH_RATE:-100}"
DURATION="${BENCH_DURATION:-3m}"
WARMUP_DURATION="${BENCH_WARMUP_DURATION:-30s}"
BATCH_SIZE="${BENCH_BATCH_SIZE:-10}"
K6_IMAGE="${K6_IMAGE:-grafana/k6:0.54.0}"
BACKEND_IMAGE="logtide-runtime-benchmark/backend:$RUN_ID"
FRONTEND_IMAGE="logtide-runtime-benchmark/frontend:$RUN_ID"
MONITOR_PID=""

require() { command -v "$1" >/dev/null || { echo "Required command not found: $1" >&2; exit 1; }; }
for command in docker curl python3 git awk; do require "$command"; done
docker compose version >/dev/null || { echo 'Docker Compose v2 is required.' >&2; exit 1; }
mkdir -p "$RESULT_DIR"
# Keep the complete Docker build output (including dependency-install and compile steps)
# alongside structured phase timings for later inspection.
exec > >(tee -a "$RESULT_DIR/runner.log") 2>&1

phase() {
  local name="$1"; shift
  local started ended elapsed status=ok
  started="$(date -u +%FT%TZ)"; local started_ns="$(date +%s%N)"
  echo "==> $name"
  if "$@"; then status=ok; else status=failed; fi
  ended="$(date -u +%FT%TZ)"; local ended_ns="$(date +%s%N)"
  elapsed="$(awk -v start="$started_ns" -v end="$ended_ns" 'BEGIN { printf "%.3f", (end-start)/1000000000 }')"
  printf '{"phase":"%s","started_at":"%s","finished_at":"%s","duration_seconds":%s,"status":"%s"}\n' \
    "$name" "$started" "$ended" "$elapsed" "$status" | tee -a "$RESULT_DIR/telemetry.jsonl"
  [[ "$status" == ok ]]
}

compose() { docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
cleanup() {
  [[ -n "$MONITOR_PID" ]] && kill "$MONITOR_PID" >/dev/null 2>&1 || true
  compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

cat > "$ENV_FILE" <<EOF
DB_NAME=logtide_benchmark
DB_USER=benchmark
DB_PASSWORD=benchmark_password
REDIS_PASSWORD=benchmark_redis_password
API_KEY_SECRET=benchmark_api_key_secret_at_least_32_chars
LOGTIDE_BACKEND_IMAGE=$BACKEND_IMAGE
LOGTIDE_FRONTEND_IMAGE=$FRONTEND_IMAGE
FRONTEND_URL=http://localhost:3000
PUBLIC_API_URL=http://localhost:8080
LOGTIDE_DSN=
PUBLIC_LOGTIDE_DSN=
INTERNAL_LOGGING_ENABLED=false
EOF

echo "Results: $RESULT_DIR"
# --no-cache makes compilation/install timings reproducible and keeps cached layers
# out of the measured build. Image downloads are lifecycle telemetry, not performance.
phase docker_cleanup compose down -v --remove-orphans
phase build_backend docker build --pull --no-cache --progress=plain -t "$BACKEND_IMAGE" -f "$ROOT_DIR/packages/backend/Dockerfile" "$ROOT_DIR"
phase build_frontend docker build --pull --no-cache --progress=plain -t "$FRONTEND_IMAGE" -f "$ROOT_DIR/packages/frontend/Dockerfile" "$ROOT_DIR"
phase start_default_profile compose up -d

ready() {
  for attempt in $(seq 1 120); do
    curl --fail --silent http://127.0.0.1:8080/health >/dev/null && return 0
    sleep 1
  done
  compose logs >&2
  return 1
}
phase backend_ready ready

RUNTIME="$(docker exec "$BACKEND_CONTAINER" sh -c 'command -v bun >/dev/null && echo bun || echo node')"
RUNTIME_VERSION="$(docker exec "$BACKEND_CONTAINER" "$RUNTIME" --version)"
seed_backend() {
  API_KEY="$(docker exec "$BACKEND_CONTAINER" sh -c "$RUNTIME dist/scripts/seed-load-test.js" | tail -n 1)"
  [[ "$API_KEY" == lp_load_* ]]
}
phase seed_fixed_data seed_backend
NETWORK="$(docker inspect "$BACKEND_CONTAINER" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}')"

python3 - "$RESULT_DIR/metadata.json" <<PY
import json, platform, subprocess, sys
result = {
  'git_commit': subprocess.check_output(['git', '-C', '$ROOT_DIR', 'rev-parse', 'HEAD'], text=True).strip(),
  'git_branch': subprocess.check_output(['git', '-C', '$ROOT_DIR', 'branch', '--show-current'], text=True).strip(),
  'backend_runtime': '$RUNTIME', 'backend_runtime_version': '$RUNTIME_VERSION',
  'backend_image': '$BACKEND_IMAGE', 'frontend_image': '$FRONTEND_IMAGE',
  'compose_profile': 'default', 'rate_requests_per_second': $RATE, 'duration': '$DURATION',
  'warmup_duration': '$WARMUP_DURATION', 'batch_size': $BATCH_SIZE, 'k6_image': '$K6_IMAGE',
  'clone_seconds': '${BENCH_CLONE_SECONDS:-}', 'host_platform': platform.platform(),
  'docker_version': subprocess.check_output(['docker', '--version'], text=True).strip(),
}
json.dump(result, open(sys.argv[1], 'w'), indent=2, sort_keys=True); print()
PY

monitor() {
  echo 'epoch_seconds,mem_usage,mem_percent,cpu_percent,pids'
  while true; do
    docker stats --no-stream --format '{{.MemUsage}},{{.MemPerc}},{{.CPUPerc}},{{.PIDs}}' "$BACKEND_CONTAINER" 2>/dev/null \
      | awk -v now="$(date +%s.%N)" 'NF { print now "," $0; fflush() }'
    sleep 1
  done
}
monitor > "$RESULT_DIR/container-samples.csv" & MONITOR_PID=$!

run_k6() {
  local duration="$1" output="$2"
  docker run --rm --network "$NETWORK" -e BASE_URL=http://backend:8080 -e API_KEY="$API_KEY" \
    -e BENCH_RATE="$RATE" -e BENCH_DURATION="$duration" -e BENCH_BATCH_SIZE="$BATCH_SIZE" \
    -v "$ROOT_DIR/benchmarks/runtime/k6:/scripts:ro" -v "$RESULT_DIR:/results" \
    "$K6_IMAGE" run --summary-export "/results/$output" /scripts/ingestion.js
}
phase warmup run_k6 "$WARMUP_DURATION" warmup-k6-summary.json
phase measured_load run_k6 "$DURATION" k6-summary.json | tee "$RESULT_DIR/k6-output.txt"
kill "$MONITOR_PID" >/dev/null 2>&1 || true; wait "$MONITOR_PID" 2>/dev/null || true; MONITOR_PID=""
phase write_report python3 "$ROOT_DIR/benchmarks/runtime/summarize.py" "$RESULT_DIR/k6-summary.json" "$RESULT_DIR/container-samples.csv" "$RESULT_DIR/result.json"

echo "Comparable report: $RESULT_DIR/result.json"
echo "Lifecycle telemetry: $RESULT_DIR/telemetry.jsonl"
echo "Complete build and runtime log: $RESULT_DIR/runner.log"
