#!/usr/bin/env python3
"""Turn k6 and Docker samples into one portable JSON benchmark result."""
import csv
import json
import math
import platform
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

summary_path, samples_path, output_path = map(Path, sys.argv[1:4])

with summary_path.open() as file:
    summary = json.load(file)


def metric(name, field='value'):
    return summary.get('metrics', {}).get(name, {}).get(field)


def mib(value):
    value = value.strip().split('/')[0].strip()
    number = float(''.join(ch for ch in value if ch.isdigit() or ch == '.'))
    unit = ''.join(ch for ch in value if ch.isalpha()).lower()
    return number * {'b': 1 / 1024 / 1024, 'kib': 1 / 1024, 'kb': 1 / 1000,
                     'mib': 1, 'mb': 1 / 1.048576, 'gib': 1024,
                     'gb': 1000 / 1.048576}.get(unit, 1)

samples = []
with samples_path.open() as file:
    for row in csv.DictReader(file):
        try:
            samples.append((float(row['epoch_seconds']), mib(row['mem_usage'])))
        except (KeyError, ValueError):
            pass

memory = {}
if samples:
    values = [sample[1] for sample in samples]
    memory = {
        'start_mib': round(values[0], 2),
        'end_mib': round(values[-1], 2),
        'peak_mib': round(max(values), 2),
        'growth_mib': round(values[-1] - values[0], 2),
        'sample_count': len(values),
    }
    if len(samples) > 1 and samples[-1][0] > samples[0][0]:
        mean_x = statistics.mean(item[0] for item in samples)
        mean_y = statistics.mean(item[1] for item in samples)
        denominator = sum((item[0] - mean_x) ** 2 for item in samples)
        slope = sum((x - mean_x) * (y - mean_y) for x, y in samples) / denominator if denominator else 0
        memory['linear_growth_mib_per_hour'] = round(slope * 3600, 2)

result = {
    'schema_version': 1,
    'created_at': datetime.now(timezone.utc).isoformat(),
    'host': {'platform': platform.platform(), 'python': platform.python_version()},
    'load': {
        'http_requests': metric('http_reqs'),
        'requests_per_second': metric('http_reqs', 'rate'),
        'failed_request_rate': metric('http_req_failed', 'rate'),
        'dropped_iterations': metric('dropped_iterations'),
        'checks_passed': metric('checks', 'passes'),
        'checks_failed': metric('checks', 'fails'),
        'latency_ms': {
            'avg': metric('http_req_duration', 'avg'),
            'p50': metric('http_req_duration', 'med'),
            'p90': metric('http_req_duration', 'p(90)'),
            'p95': metric('http_req_duration', 'p(95)'),
            'p99': metric('http_req_duration', 'p(99)'),
            'max': metric('http_req_duration', 'max'),
        },
        'ingest_latency_ms': {
            'p95': metric('ingest_duration', 'p(95)'),
            'p99': metric('ingest_duration', 'p(99)'),
        },
        'logs_ingested': metric('logs_ingested'),
    },
    'backend_container_memory': memory,
}

with output_path.open('w') as file:
    json.dump(result, file, indent=2, sort_keys=True)
    file.write('\n')
