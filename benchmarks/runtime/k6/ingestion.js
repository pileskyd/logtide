import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const baseUrl = __ENV.BASE_URL;
const apiKey = __ENV.API_KEY;
const rate = Number(__ENV.BENCH_RATE || 100);
const duration = __ENV.BENCH_DURATION || '3m';
const batchSize = Number(__ENV.BENCH_BATCH_SIZE || 10);
// Capacity runs may need less eager VU allocation than the conservative default.
// Keep maxVUs above preAllocatedVUs so k6 can still compensate for latency spikes.
const preAllocatedVUs = Number(__ENV.BENCH_PREALLOCATED_VUS || Math.max(20, Math.ceil(rate / 2)));
const maxVUs = Number(__ENV.BENCH_MAX_VUS || Math.max(preAllocatedVUs * 2, rate * 2));

if (!baseUrl || !apiKey) {
  throw new Error('BASE_URL and API_KEY must be set');
}

const logsIngested = new Counter('logs_ingested');
const ingestErrors = new Rate('ingest_errors');
const ingestDuration = new Trend('ingest_duration', true);
const payload = JSON.stringify(Array.from({ length: batchSize }, (_, index) => ({
  timestamp: '2025-01-01T00:00:00.000Z',
  level: index % 10 === 0 ? 'error' : 'info',
  message: `runtime benchmark event ${index}`,
  service: `benchmark-service-${index % 4}`,
  environment: 'benchmark',
  metadata: { requestId: `fixed-request-${index}`, sequence: index },
})));

export const options = {
  discardResponseBodies: true,
  scenarios: {
    ingestion: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration,
      preAllocatedVUs,
      maxVUs,
    },
  },
  // Threshold status is reported by the runner after the raw result is saved.
  // A transient warm-up drop must not discard an otherwise useful benchmark run.
};

export default function () {
  const startedAt = Date.now();
  const response = http.post(`${baseUrl}/api/v1/ingest`, payload, {
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    tags: { endpoint: 'ingest' },
  });
  const ok = check(response, { 'ingestion returned 200': (res) => res.status === 200 });
  ingestDuration.add(Date.now() - startedAt);
  ingestErrors.add(!ok);
  if (ok) logsIngested.add(batchSize);
}
