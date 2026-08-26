#!/usr/bin/env bash
# Download a branch into a clean directory and run its Docker default-profile benchmark.
# Usage: ./benchmarks/runtime/run-branch-on-vm.sh <repository-url> <branch> [directory]
set -Eeuo pipefail

REPOSITORY_URL="${1:?Usage: $0 <repository-url> <branch> [directory>}"
BRANCH="${2:?Usage: $0 <repository-url> <branch> [directory>}"
SAFE_BRANCH="$(printf '%s' "$BRANCH" | tr '/' '-')"
WORK_DIR="${3:-$PWD/logtide-benchmark-$SAFE_BRANCH}"
START_NS="$(date +%s%N)"

command -v git >/dev/null || { echo 'Git is required.' >&2; exit 1; }
[[ ! -e "$WORK_DIR" ]] || { echo "Refusing to overwrite existing directory: $WORK_DIR" >&2; exit 1; }

echo "Cloning $BRANCH from $REPOSITORY_URL into $WORK_DIR"
git clone --depth 1 --branch "$BRANCH" "$REPOSITORY_URL" "$WORK_DIR"
END_NS="$(date +%s%N)"
CLONE_SECONDS="$(awk -v start="$START_NS" -v end="$END_NS" 'BEGIN { printf "%.3f", (end-start)/1000000000 }')"

cd "$WORK_DIR"
BENCH_CLONE_SECONDS="$CLONE_SECONDS" ./benchmarks/runtime/run-vm-benchmark.sh
