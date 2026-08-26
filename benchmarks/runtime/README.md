# Node vs Bun backend benchmark

This harness compares the production backend from two Git branches on two otherwise identical Linux VMs. It uses the branch's own `packages/backend/Dockerfile`, so the measured runtime is Node on the pnpm branch and Bun on the migration branch. PostgreSQL/TimescaleDB and Redis are started locally in fresh disposable containers for every run.

## What it measures

- **Throughput:** `requests_per_second` and `logs_ingested` under a fixed arrival rate.
- **Latency:** HTTP p50/p90/p95/p99, max, plus ingestion p95/p99.
- **Reliability:** failed request rate, failed checks, and `dropped_iterations` (the load generator could not sustain the target rate).
- **Memory:** Docker cgroup memory at one-second intervals: start, end, peak, net growth, and least-squares memory-growth rate per hour. A positive sustained slope/end growth is a leak signal; repeat a longer run to confirm it.

The output is deliberately JSON so results from the two VMs can be diffed without manually transcribing terminal output.

## Fair-comparison rules

1. Use the same VM image, CPU/RAM/disk class, Docker version, region and architecture. Do not place both backends on the same VM.
2. Use the same commit base apart from the runtime migration, fixed dependency lockfiles, and the same values for `BENCH_*` settings.
3. Stop other CPU- or memory-intensive work. Keep the VMs on AC/performance CPU governor where applicable.
4. Run at least three times per runtime and compare medians. Alternate the order (Node → Bun on one round, Bun → Node on the next) to reduce time-of-day and noisy-neighbour bias.
5. The harness resets containers and volumes before each run. Do not compare results that reuse a database.

## Run on each VM

Prerequisites: Git, Docker Engine with Compose v2, `curl`, Python 3, and outbound access to pull Docker images. No host Node, pnpm, Bun or k6 installation is needed.

```bash
# Node VM
git clone <repository-url> logtide && cd logtide
git switch feat/runtime-benchmarks
BENCH_DURATION=10m BENCH_RATE=100 ./benchmarks/runtime/run-vm-benchmark.sh

# Bun VM
git clone <repository-url> logtide && cd logtide
git switch feat/bun-runtime-migration
BENCH_DURATION=10m BENCH_RATE=100 ./benchmarks/runtime/run-vm-benchmark.sh
```

Copy each `benchmark-results/runtime/*/result.json` and its `metadata.json` to one place. The defaults are 100 requests/s, batches of 10 logs, a 30-second warm-up, and a 3-minute measured run. For a memory-leak check use `BENCH_DURATION=30m` or longer. Keep every `BENCH_*` value identical across VMs.

## Interpreting results

For a runtime A relative to baseline B, calculate:

- throughput change: `(A.rps / B.rps - 1) × 100%` — only valid when both have zero dropped iterations;
- latency change: `(A.p95 / B.p95 - 1) × 100%` — lower is better;
- peak-memory change: `(A.peak_mib / B.peak_mib - 1) × 100%` — lower is better;
- leak indication: compare `growth_mib` and `linear_growth_mib_per_hour` from runs long enough to reach steady state;
- correctness gate: `failed_request_rate == 0`, `checks_failed == 0`, and `dropped_iterations == 0` before declaring a performance win.

Container memory is intentionally used instead of `process.memoryUsage()`: it includes native allocations and makes Node and Bun comparable. It does **not** prove a leak on its own; inspect the time series (`container-samples.csv`) and reproduce the slope over multiple long runs.
