#!/usr/bin/env bash
# Run this unchanged on one Node/pnpm VM and one Bun VM. It builds the checked-out
# branch's production backend image, then writes comparable JSON and raw artifacts.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.test.yml"
BACKEND_CONTAINER="logtide-backend-test"
RUN_ID="${RUN_ID:-$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)-$(date -u +%Y%m%dT%H%M%SZ)}"
RESULT_DIR="$ROOT_DIR/benchmark-results/runtime/$RUN_ID"
RATE="${BENCH_RATE:-100}"
DURATION="${BENCH_DURATION:-3m}"
WARMUP_DURATION="${BENCH_WARMUP_DURATION:-30s}"
BATCH_SIZE="${BENCH_BATCH_SIZE:-10}"
K6_IMAGE="${K6_IMAGE:-grafana/k6:0.54.0}"
MONITOR_PID=""

require() { command -v "$1" >/dev/null || { echo "Required command not found: $1" >&2; exit 1; }; }
for command in docker curl python3 git; do require "$command"; done

docker compose version >/dev/null || { echo 'Docker Compose v2 is required.' >&2; exit 1; }
mkdir -p "$RESULT_DIR"

echo "Results: $RESULT_DIR"
echo "Resetting the isolated test stack (database state must not carry between runs)..."
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true

cleanup() {
  [[ -n "$MONITOR_PID" ]] && kill "$MONITOR_PID" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Building and starting backend from $(git -C "$ROOT_DIR" rev-parse --short HEAD)..."
docker compose -f "$COMPOSE_FILE" up -d --build backend-test

for attempt in $(seq 1 90); do
  if curl --fail --silent http://127.0.0.1:3001/health >/dev/null; then break; fi
  if [[ "$attempt" == 90 ]]; then
    docker compose -f "$COMPOSE_FILE" logs backend-test >&2
    exit 1
  fi
  sleep 2
done

RUNTIME="$(docker exec "$BACKEND_CONTAINER" sh -c 'command -v bun >/dev/null && echo bun || echo node')"
API_KEY="$(docker exec "$BACKEND_CONTAINER" sh -c "$RUNTIME dist/scripts/seed-load-test.js" | tail -n 1)"
[[ "$API_KEY" == lp_load_* ]] || { echo "Could not create the benchmark API key." >&2; exit 1; }
NETWORK="$(docker inspect "$BACKEND_CONTAINER" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}')"

cat > "$RESULT_DIR/metadata.json" <<EOF
{
  "git_commit": "$(git -C "$ROOT_DIR" rev-parse HEAD)",
  "git_branch": "$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)",
  "backend_runtime": "$RUNTIME",
  "k6_image": "$K6_IMAGE",
  "rate_requests_per_second": $RATE,
  "duration": "$DURATION",
  "warmup_duration": "$WARMUP_DURATION",
  "batch_size": $BATCH_SIZE,
  "started_at_utc": "$(date -u +%FT%TZ)",
  "docker_version": "$(docker --version | sed 's/"/\\"/g')"
}
EOF

monitor() {
  echo 'epoch_seconds,mem_usage,mem_percent,cpu_percent,pids'
  while true; do
    docker stats --no-stream --format '{{.MemUsage}},{{.MemPerc}},{{.CPUPerc}},{{.PIDs}}' "$BACKEND_CONTAINER" 2>/dev/null \
      | awk -v now="$(date +%s.%N)" 'NF { print now "," $0; fflush() }'
    sleep 1
  done
}
monitor > "$RESULT_DIR/container-samples.csv" &
MONITOR_PID=$!

run_k6() {
  local duration="$1" output="$2"
  docker run --rm --network "$NETWORK" \
    -e BASE_URL=http://backend-test:8080 \
    -e API_KEY="$API_KEY" \
    -e BENCH_RATE="$RATE" \
    -e BENCH_DURATION="$duration" \
    -e BENCH_BATCH_SIZE="$BATCH_SIZE" \
    -v "$ROOT_DIR/benchmarks/runtime/k6:/scripts:ro" \
    -v "$RESULT_DIR:/results" \
    "$K6_IMAGE" run --summary-export "/results/$output" /scripts/ingestion.js
}

echo "Warm-up: ${WARMUP_DURATION} at ${RATE} req/s (discarded from results)"
run_k6 "$WARMUP_DURATION" warmup-k6-summary.json >/dev/null

echo "Measured run: ${DURATION} at ${RATE} req/s"
run_k6 "$DURATION" k6-summary.json | tee "$RESULT_DIR/k6-output.txt"
kill "$MONITOR_PID" >/dev/null 2>&1 || true
wait "$MONITOR_PID" 2>/dev/null || true
MONITOR_PID=""

python3 "$ROOT_DIR/benchmarks/runtime/summarize.py" \
  "$RESULT_DIR/k6-summary.json" "$RESULT_DIR/container-samples.csv" "$RESULT_DIR/result.json"

echo
cat "$RESULT_DIR/result.json"
echo "\nComparable result saved to: $RESULT_DIR/result.json"
