// Dev/prod baseline gate for the order path.
//
// Thresholds are deliberately hardware-independent where possible:
//   - error ratio and checks are ratios, not absolute timings
//   - order p99 is the SLO target (500ms) and should be run with a fixed CPU
//     quota (see docker-compose.local.yml) so dev and prod are comparable.
//
// Run:
//   k6 run -e GATEWAY=http://localhost:8080 -e API_KEY=demo-key stress/k6-baseline.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const GATEWAY = __ENV.GATEWAY || 'http://localhost:8080';
const API_KEY = __ENV.API_KEY || 'demo-key';
const SYMBOLS = ['AAPL', 'MSFT', 'TSLA', 'NVDA', 'AMD', 'GOOG'];

const orderLatency = new Trend('trading_order_latency_ms', true);
const orderErrors = new Rate('trading_order_errors');

export const options = {
  scenarios: {
    baseline: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 25 },
        { duration: '2m', target: 100 },
        { duration: '2m', target: 100 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.005'],
    http_req_duration: ['p(99)<500'],
    'http_req_duration{operation:place_order}': ['p(99)<500'],
    'http_req_duration{operation:ticker}': ['p(99)<200'],
    checks: ['rate>0.995'],
    trading_order_errors: ['rate<0.005'],
  },
};

export default function () {
  const symbol = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];

  const ticker = http.get(`${GATEWAY}/ticker?symbol=${symbol}`, {
    headers: { 'X-API-Key': API_KEY },
    tags: { operation: 'ticker' },
  });
  check(ticker, { 'ticker 200': (r) => r.status === 200 });

  const side = Math.random() < 0.5 ? 'BUY' : 'SELL';
  const price = (100 + Math.random() * 20).toFixed(2);
  const payload = JSON.stringify({
    symbol,
    side,
    type: 'LIMIT',
    price,
    quantity: '1',
    time_in_force: 'GTC',
    client_order_id: `k6-baseline-${__VU}-${__ITER}-${Date.now()}`,
  });

  const started = Date.now();
  const res = http.post(`${GATEWAY}/orders`, payload, {
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    tags: { operation: 'place_order' },
  });
  orderLatency.add(Date.now() - started);

  const ok = check(res, {
    'order accepted/rejected': (r) => r.status === 200 || r.status === 409,
    'order has response': (r) => r.body && r.body.length > 0,
  });
  orderErrors.add(!ok);

  sleep(0.1 + Math.random() * 0.2);
}

export function handleSummary(data) {
  return {
    'stress/results/baseline-summary.json': JSON.stringify(data, null, 2),
    stdout: JSON.stringify(
      {
        metrics: {
          http_req_failed: data.metrics.http_req_failed?.values,
          http_req_duration: data.metrics.http_req_duration?.values,
          checks: data.metrics.checks?.values,
          trading_order_errors: data.metrics.trading_order_errors?.values,
        },
      },
      null,
      2,
    ),
  };
}
