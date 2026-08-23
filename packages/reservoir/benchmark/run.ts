#!/usr/bin/env node

/**
 * Reservoir Engine Benchmark
 *
 * Compares TimescaleDB, ClickHouse, and MongoDB across all storage operations.
 *
 * Usage:
 *   bun benchmark/run.ts [options]
 *
 * Options:
 *   -v, --volume    Comma-separated volume tiers: 1k,10k,100k,1m,10m,50m (default: all)
 *   -e, --engine    Comma-separated engines: timescale,clickhouse,mongodb (default: all)
 *   -s, --suite     Comma-separated suites: logs,spans,metrics (default: all)
 *   -i, --iterations Number of measured iterations (default: 5)
 *   -w, --warmup    Number of warmup iterations (default: 1)
 *   -o, --output    JSON output file path (default: benchmark-results.json)
 *
 * Examples:
 *   bun benchmark/run.ts
 *   bun benchmark/run.ts -v 1k,10k -e timescale,clickhouse
 *   bun benchmark/run.ts -v 1m -s logs -i 10
 *   bun benchmark/run.ts -v 10m,50m -e clickhouse -s logs,metrics
 */

import { DEFAULT_CONFIG, VOLUME_TIERS, parseCLIArgs } from './config.js';
import type { BenchmarkConfig, BenchmarkResult } from './config.js';
import { createEngines, destroyEngines } from './engines.js';
import type { EngineHandle } from './engines.js';
import { resetSeed } from './data-generators.js';
import { seedLogs, runLogBenchmarks } from './suites/logs.js';
import { seedSpans, runSpanBenchmarks } from './suites/spans.js';
import { seedMetrics, runMetricBenchmarks } from './suites/metrics.js';
import { printFullReport, exportFullReport } from './reporter.js';
import { getMemorySnapshot } from './runner.js';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCLIArgs(process.argv.slice(2));
  const outputPath = args.output ?? 'benchmark-results.json';

  const config: BenchmarkConfig = {
    ...DEFAULT_CONFIG,
    iterations: args.iterations,
    warmup: args.warmup,
  };

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║              RESERVOIR ENGINE BENCHMARK                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Engines:    ${args.engines.join(', ')}`);
  console.log(`  Volumes:    ${args.volumes.map(v => VOLUME_TIERS[v].name).join(', ')}`);
  console.log(`  Suites:     ${args.suites.join(', ')}`);
  console.log(`  Iterations: ${config.iterations} (+ ${config.warmup} warmup)`);
  console.log(`  Output:     ${outputPath}`);

  // Initialize engines
  let handles: EngineHandle[];
  try {
    handles = await createEngines(args.engines);
  } catch (err) {
    console.error(`\nFailed to initialize engines: ${err}`);
    process.exit(1);
  }

  const allResults: BenchmarkResult[] = [];

  try {
    for (const volumeKey of args.volumes) {
      const tier = VOLUME_TIERS[volumeKey];
      console.log('\n' + '━'.repeat(70));
      console.log(`  VOLUME TIER: ${tier.name}`);
      console.log('━'.repeat(70));

      for (const handle of handles) {
        const { type: engineType, engine } = handle;

        // Reset seed for reproducibility across engines
        resetSeed(42);

        // --- LOGS ---
        if (args.suites.includes('logs')) {
          const memBefore = getMemorySnapshot();
          console.log(`\n  [${engineType}] Seeding ${tier.logs.toLocaleString()} logs... (RSS: ${memBefore.rssMB}MB)`);
          const seedStart = Date.now();
          await seedLogs(engine, engineType, tier.logs, config.projectId, config.organizationId);
          const memAfter = getMemorySnapshot();
          console.log(`  [${engineType}] Seeding done in ${((Date.now() - seedStart) / 1000).toFixed(1)}s (RSS: ${memAfter.rssMB}MB, +${(memAfter.rssMB - memBefore.rssMB).toFixed(1)}MB)`);

          console.log(`\n  [${engineType}] Running log benchmarks...`);
          const logResults = await runLogBenchmarks(engine, engineType, tier.name, config);
          allResults.push(...logResults);

          // Cleanup logs for next engine
          try {
            await engine.deleteByTimeRange({
              projectId: config.projectId,
              from: new Date(0),
              to: new Date(Date.now() + 86400000),
            });
          } catch {
            // ClickHouse deletes are async, that's ok
          }
        }

        // --- SPANS ---
        if (args.suites.includes('spans')) {
          const memBefore = getMemorySnapshot();
          console.log(`\n  [${engineType}] Seeding ${tier.spans.toLocaleString()} spans... (RSS: ${memBefore.rssMB}MB)`);
          resetSeed(42);
          const seedStart = Date.now();
          const { traceIds } = await seedSpans(engine, engineType, tier.spans, config.projectId, config.organizationId);
          const memAfter = getMemorySnapshot();
          console.log(`  [${engineType}] Seeding done in ${((Date.now() - seedStart) / 1000).toFixed(1)}s (RSS: ${memAfter.rssMB}MB, +${(memAfter.rssMB - memBefore.rssMB).toFixed(1)}MB)`);

          console.log(`\n  [${engineType}] Running span benchmarks...`);
          const spanResults = await runSpanBenchmarks(engine, engineType, tier.name, config, traceIds);
          allResults.push(...spanResults);

          // Cleanup spans
          try {
            await engine.deleteSpansByTimeRange({
              projectId: config.projectId,
              from: new Date(0),
              to: new Date(Date.now() + 86400000),
            });
          } catch {
            // ok
          }
        }

        // --- METRICS ---
        if (args.suites.includes('metrics')) {
          const memBefore = getMemorySnapshot();
          console.log(`\n  [${engineType}] Seeding ${tier.metrics.toLocaleString()} metrics... (RSS: ${memBefore.rssMB}MB)`);
          resetSeed(42);
          const seedStart = Date.now();
          await seedMetrics(engine, engineType, tier.metrics, config.projectId, config.organizationId);
          const memAfter = getMemorySnapshot();
          console.log(`  [${engineType}] Seeding done in ${((Date.now() - seedStart) / 1000).toFixed(1)}s (RSS: ${memAfter.rssMB}MB, +${(memAfter.rssMB - memBefore.rssMB).toFixed(1)}MB)`);

          console.log(`\n  [${engineType}] Running metric benchmarks...`);
          const metricResults = await runMetricBenchmarks(engine, engineType, tier.name, config);
          allResults.push(...metricResults);

          // Cleanup metrics
          try {
            await engine.deleteMetricsByTimeRange({
              projectId: config.projectId,
              from: new Date(0),
              to: new Date(Date.now() + 86400000),
            });
          } catch {
            // ok
          }
        }
      }
    }

    // Print full report
    printFullReport(allResults, args.engines, args.volumes.map(v => VOLUME_TIERS[v].name));

    // Export JSON
    exportFullReport(allResults, config, args.engines, args.volumes.map(v => VOLUME_TIERS[v].name), outputPath);

  } finally {
    await destroyEngines(handles);
  }

  console.log('\nBenchmark complete.');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
