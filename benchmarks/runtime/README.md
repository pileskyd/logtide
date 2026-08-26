# Node vs Bun: cold Docker build and default-profile benchmark

The runner downloads a requested Git branch, builds its **backend and frontend production Docker images**, and starts `docker/docker-compose.yml` with **no profiles enabled**. This is the normal LogTide deployment: TimescaleDB, Redis, backend, worker and frontend. It then executes a deterministic k6 ingestion workload against the backend.

The same scripts live on both comparison branches:

- `feat/runtime-benchmarks`: Node + pnpm baseline from `main`;
- `feat/bun-runtime-migration`: Bun migration.

## Single command per VPS

Run this from any directory on a disposable/dedicated VPS. The script itself is in either branch, so clone the baseline once to invoke it, or download the raw file from GitHub.

```bash
# First VPS: Node baseline
./benchmarks/runtime/run-branch-on-vm.sh \
  git@github.com:pileskyd/logtide.git feat/runtime-benchmarks

# Second (or the same cleaned) VPS: Bun branch
./benchmarks/runtime/run-branch-on-vm.sh \
  git@github.com:pileskyd/logtide.git feat/bun-runtime-migration
```

Optional third argument chooses a clone directory. It refuses to overwrite one. Requirements are Git, Docker Engine with Compose v2, `curl`, Python 3 and `awk`; the host does not need Node, pnpm, Bun or k6.

For a longer leak run, use identical settings before the command:

```bash
BENCH_DURATION=30m BENCH_WARMUP_DURATION=1m BENCH_RATE=100 \
  ./benchmarks/runtime/run-branch-on-vm.sh git@github.com:pileskyd/logtide.git feat/runtime-benchmarks
```

## What is recorded

Every run creates `benchmark-results/runtime/<branch>-<timestamp>/` inside its cloned checkout:

- `metadata.json`: commit, branch, selected runtime **and exact runtime version**, image tags, Docker/k6 versions and workload settings;
- `telemetry.jsonl`: wall-clock duration and status of cleanup, backend build, frontend build, Compose default-profile start, backend readiness, fixed-data seed, warm-up, measured load and report generation;
- `runner.log`: complete Docker build output (including the runtime-specific dependency installation and compilation steps) plus runner output;
- `result.json`: the comparison report;
- `k6-summary.json` and `k6-output.txt`: raw load-generator data;
- `container-samples.csv`: one-second backend container CPU/RSS samples.

`result.json` reports request rate, HTTP and ingestion p50/p90/p95/p99/max, request/check errors, dropped iterations, ingested logs, and memory start/end/peak/growth/slope. Docker build/install/start times are in **telemetry only**; they are not mixed into request latency, throughput or memory metrics.

## Cache handling and a fair comparison

The images are always built with `docker build --pull --no-cache`: no Docker build layer or dependency-install cache contributes to the recorded build phase. Pull/network time can still vary and is therefore only lifecycle telemetry, never a runtime-performance result. The test stack and volumes are destroyed before and after each run, so database/Redis state does not carry over.

Use the same VPS sequentially if that is your comparison method, with the same VM image, Docker version, CPU/RAM/disk class, architecture, region and `BENCH_*` settings. Do at least three alternating runs per runtime and compare medians. A result is valid only if both runs have zero failed requests/checks and zero dropped iterations.

This benchmark evaluates the **deployable migration**, including its Docker base image and runtime-specific dependencies. For an isolated engine-only comparison, use a separately built identical `dist` artifact and launch it under `node` and `bun`; that is deliberately not what this production-image test claims to measure.
