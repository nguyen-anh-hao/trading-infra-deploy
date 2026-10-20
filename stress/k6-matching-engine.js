// Direct matching-engine load (port 9001).
//
// The engine is single-writer and closes the TCP connection after each
// response, so HTTP req/s is a ceiling of the adapter, not of matching. The
// authoritative metric is the server-side histogram scraped from /metrics:
// trading_matching_latency_seconds p99/p999.
//
// Each crossing iteration sends one resting GTC sell and one GTC buy at the
// same price from different accounts. Exactly one trade is produced and the
// book does not grow, which keeps a 60s run comparable with the next one.
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { BASE, DURATION, RUN_ID, SYMBOLS, numberEnv, pick } from './lib/env.js';
import { checkTargets } from './lib/preflight.js';
import { syntheticAccounts } from './lib/accounts.js';
import { directDelete, directGet, directPost } from './lib/gw.js';
import { orderBody, safeJson } from './lib/payloads.js';
import {
  counterDelta,
  fetchMetrics,
  histogram,
  quantile,
  subtractHistogram,
} from './lib/prom.js';
import {
  orderFillRatio,
  promMatchingErrorsRate,
  promMatchingP99,
  promMatchingP999,
  promMatchingTradesRate,
  recordOp,
  tradesObserved,
  unexpectedErrors,
} from './lib/metrics.js';
import { handleSummaryFor, metricValue } from './lib/summary.js';

const CROSS_RATE = numberEnv('CROSS_RATE', 100);
const CANCEL_RATE = numberEnv('CANCEL_RATE', 30);
const READ_RATE = numberEnv('READ_RATE', 50);
const ACCOUNTS = numberEnv('ACCOUNTS', 2000);
const ACCOUNT_BASE = numberEnv('ACCOUNT_BASE', 7000000);

function vusFor(rate, serviceMs) {
  return Math.max(5, Math.ceil((rate * serviceMs) / 1000));
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  scenarios: {
    crossing: {
      executor: 'constant-arrival-rate',
      exec: 'crossing',
      rate: CROSS_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(CROSS_RATE, 100),
      maxVUs: vusFor(CROSS_RATE, 500),
      gracefulStop: '5s',
    },
    cancel_churn: {
      executor: 'constant-arrival-rate',
      exec: 'cancelChurn',
      rate: CANCEL_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(CANCEL_RATE, 100),
      maxVUs: vusFor(CANCEL_RATE, 400),
      gracefulStop: '5s',
    },
    reads: {
      executor: 'constant-arrival-rate',
      exec: 'reads',
      rate: READ_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(READ_RATE, 50),
      maxVUs: vusFor(READ_RATE, 300),
      gracefulStop: '5s',
    },
    poller: {
      executor: 'constant-vus',
      exec: 'poller',
      vus: 1,
      duration: DURATION,
      gracefulStop: '2s',
    },
  },
  thresholds: {
    'http_req_failed{scenario:crossing}': ['rate<0.01'],
    'http_req_failed{scenario:cancel_churn}': ['rate<0.01'],
    'http_req_failed{scenario:reads}': ['rate<0.01'],
    op_matching_place_ms: ['p(99)<1000'],
    op_matching_cancel_ms: ['p(99)<1000'],
    prom_matching_p99_ms: ['p(95)<5'],
    prom_matching_p999_ms: ['med<10'],
    order_fill_ratio: ['rate>0.95'],
    checks: ['rate>0.99'],
    svc_unexpected_errors: ['rate<0.01'],
  },
};

export function setup() {
  checkTargets(['matching']);
  return { accounts: syntheticAccounts(ACCOUNT_BASE, ACCOUNTS) };
}

// The engine parses account_id from the JSON body, not from a header.
function withAccount(body, accountID) {
  const parsed = JSON.parse(body);
  parsed.account_id = accountID;
  return JSON.stringify(parsed);
}

export function crossing(data) {
  const iteration = exec.scenario.iterationInTest;
  const maker = data.accounts[(iteration * 2) % data.accounts.length];
  const taker = data.accounts[(iteration * 2 + 1) % data.accounts.length];
  const symbol = pick(SYMBOLS);
  const price = 100 + Math.floor(Math.random() * 2000) / 100;
  const quantity = 1 + Math.floor(Math.random() * 3);
  const sell = withAccount(
    orderBody(symbol, 'SELL', 'LIMIT', price, quantity, 'GTC', 'k6-mk-s-' + iteration),
    maker.accountId
  );
  const buy = withAccount(
    orderBody(symbol, 'BUY', 'LIMIT', price, quantity, 'GTC', 'k6-mk-b-' + iteration),
    taker.accountId
  );

  const responses = http.batch([
    {
      method: 'POST',
      url: BASE.matching + '/orders',
      body: sell,
      params: {
        headers: { 'Content-Type': 'application/json' },
        tags: { operation: 'matching_place' },
      },
    },
    {
      method: 'POST',
      url: BASE.matching + '/orders',
      body: buy,
      params: {
        headers: { 'Content-Type': 'application/json' },
        tags: { operation: 'matching_place' },
      },
    },
  ]);

  let trades = 0;
  responses.forEach((res) => {
    recordOp('matching_place', res);
    const body = safeJson(res);
    if (body && body.trades) {
      trades += body.trades.length;
    }
  });
  const ok = check(responses[0], { 'matching sell responded': (r) => r.status === 200 });
  check(responses[1], { 'matching buy responded': (r) => r.status === 200 });
  orderFillRatio.add(trades > 0 ? 1 : 0);
  tradesObserved.add(trades);
  unexpectedErrors.add(!ok);
}



export function cancelChurn(data) {
  const account = data.accounts[Math.floor(Math.random() * data.accounts.length)];
  const symbol = pick(SYMBOLS);
  const body = orderBody(
    symbol,
    'SELL',
    'LIMIT',
    1000,
    1,
    'GTC',
    'k6-mk-c-' + __VU + '-' + __ITER + '-' + Date.now()
  );
  const placed = directPost(
    BASE.matching + '/orders',
    withAccount(body, account.accountId),
    'matching_place'
  );
  const parsed = safeJson(placed);
  const orderID = parsed && parsed.order_id;
  if (orderID) {
    const res = directDelete(
      BASE.matching + '/orders?id=' + orderID + '&symbol=' + symbol,
      'matching_cancel'
    );
    const ok = check(res, { 'matching cancel 200': (r) => r.status === 200 });
    unexpectedErrors.add(!ok);
  } else {
    unexpectedErrors.add(true);
  }
}

export function reads(data) {
  const symbol = pick(SYMBOLS);
  if (Math.random() < 0.5) {
    const res = directGet(BASE.matching + '/book?symbol=' + symbol + '&depth=10', 'matching_book');
    unexpectedErrors.add(!check(res, { 'matching book 200': (r) => r.status === 200 }));
  } else {
    const res = directGet(BASE.matching + '/ticker?symbol=' + symbol, 'matching_ticker');
    unexpectedErrors.add(!check(res, { 'matching ticker 200': (r) => r.status === 200 }));
  }
}

let previousHistogram = null;
let previousTrades = null;
let previousErrors = null;
let previousTs = 0;

export function poller() {
  const now = Date.now();
  const metrics = fetchMetrics(BASE.matching + '/metrics');
  if (metrics) {
    const current = histogram(metrics, 'trading_matching_latency_seconds');
    if (previousHistogram && current.count > previousHistogram.count) {
      const delta = subtractHistogram(previousHistogram, current);
      const p99 = quantile(delta, 0.99);
      const p999 = quantile(delta, 0.999);
      if (p99 !== null) {
        promMatchingP99.add(p99 * 1000);
      }
      if (p999 !== null) {
        promMatchingP999.add(p999 * 1000);
      }
    }
    previousHistogram = current;

    if (previousTs > 0) {
      const elapsed = (now - previousTs) / 1000;
      const trades = counterDelta(metrics, 'trading_matching_trades_total', previousTrades);
      const errors = counterDelta(metrics, 'trading_matching_errors_total', previousErrors);
      promMatchingTradesRate.add(trades.delta / elapsed);
      promMatchingErrorsRate.add(errors.delta / elapsed);
      previousTrades = trades.next;
      previousErrors = errors.next;
    } else {
      previousTrades = counterDelta(metrics, 'trading_matching_trades_total', null).next;
      previousErrors = counterDelta(metrics, 'trading_matching_errors_total', null).next;
    }
    previousTs = now;
  }
  sleep(1);
}

export const handleSummary = handleSummaryFor('matching-engine', (data) => ({
  http_rps: metricValue(data, 'http_reqs', 'rate'),
  place_p99_ms: metricValue(data, 'op_matching_place_ms', 'p(99)'),
  cancel_p99_ms: metricValue(data, 'op_matching_cancel_ms', 'p(99)'),
  matching_p99_ms: metricValue(data, 'prom_matching_p99_ms', 'p(95)'),
  matching_p999_ms: metricValue(data, 'prom_matching_p999_ms', 'p(95)'),
  trades_per_s: metricValue(data, 'prom_matching_trades_per_s', 'avg'),
  fill_ratio: metricValue(data, 'order_fill_ratio', 'rate'),
}));
