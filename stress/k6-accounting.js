// Accounting & tax read model.
//
// Load: /accounting/summary and /accounting/trade-counts at a fixed rate.
// Freshness: settle a trade into a unique symbol, then poll /trade-counts
// until the event is visible. That measures the full
// settlement -> outbox -> Debezium -> Kafka -> consumer -> Redis path.
//
// The aggregate is eventually consistent and not replay-safe (see README), so
// this scenario claims freshness and zero consumer errors, never exactly-once.
import { check, sleep } from 'k6';
import { BASE, DURATION, RUN_ID, numberEnv, boolEnv } from './lib/env.js';
import { checkTargets } from './lib/preflight.js';
import { directGet, directPost } from './lib/gw.js';
import { safeJson, settleBody } from './lib/payloads.js';
import { counterDelta, fetchMetrics } from './lib/prom.js';
import {
  accountingLag,
  accountingTimeouts,
  promAccountingErrorsRate,
  unexpectedErrors,
} from './lib/metrics.js';
import { handleSummaryFor, metricValue } from './lib/summary.js';

const READ_RATE = numberEnv('READ_RATE', 50);
const SAMPLES = numberEnv('SAMPLES', 10);
const LAG_SLO_MS = numberEnv('ACCOUNTING_LAG_SLO_MS', 5000);
const FRESHNESS = boolEnv('FRESHNESS', true);
const ACCOUNT_BASE = numberEnv('ACCOUNT_BASE', 950000);
const SYMBOL = ('K6A' + RUN_ID.replace(/[^A-Za-z0-9]/g, '').slice(-8)).toUpperCase();

function vusFor(rate, serviceMs) {
  return Math.max(5, Math.ceil((rate * serviceMs) / 1000));
}

const scenarios = {
  reads: {
    executor: 'constant-arrival-rate',
    exec: 'reads',
    rate: READ_RATE,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: vusFor(READ_RATE, 100),
    maxVUs: vusFor(READ_RATE, 500),
    gracefulStop: '5s',
  },
  poller: {
    executor: 'constant-vus',
    exec: 'poller',
    vus: 1,
    duration: DURATION,
    gracefulStop: '2s',
  },
};

const thresholds = {
  'http_req_failed{scenario:reads}': ['rate<0.01'],
  op_accounting_summary_ms: ['p(99)<500'],
  op_accounting_counts_ms: ['p(99)<500'],
  checks: ['rate>0.99'],
  svc_unexpected_errors: ['rate<0.01'],
};

if (FRESHNESS) {
  scenarios.freshness = {
    executor: 'shared-iterations',
    exec: 'freshness',
    vus: 1,
    iterations: SAMPLES,
    startTime: '2s',
    maxDuration: '10m',
    gracefulStop: '5s',
  };
  thresholds.accounting_lag_ms = ['p(95)<' + LAG_SLO_MS];
  thresholds.accounting_freshness_timeout_total = ['count==0'];
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  scenarios: scenarios,
  thresholds: thresholds,
};

export function setup() {
  if (FRESHNESS) {
    checkTargets(['accounting', 'settlement']);
  } else {
    checkTargets(['accounting']);
  }
  return {
    symbol: SYMBOL,
    baseTradeId: Number('7' + String(Date.now()).slice(-10)),
  };
}



export function reads() {
  if (Math.random() < 0.5) {
    const res = directGet(BASE.accounting + '/accounting/summary', 'accounting_summary');
    const ok = check(res, {
      'accounting summary 200': (r) => r.status === 200,
      'accounting summary has fee revenue': (r) => {
        try {
          return r.json().fee_revenue_by_symbol !== undefined;
        } catch (err) {
          return false;
        }
      },
    });
    unexpectedErrors.add(!ok);
  } else {
    const res = directGet(BASE.accounting + '/accounting/trade-counts', 'accounting_counts');
    const ok = check(res, {
      'accounting counts 200': (r) => r.status === 200,
      'accounting counts is a map': (r) => {
        try {
          return typeof r.json() === 'object';
        } catch (err) {
          return false;
        }
      },
    });
    unexpectedErrors.add(!ok);
  }
}

function tradeCount(symbol) {
  const res = directGet(BASE.accounting + '/accounting/trade-counts', 'accounting_counts');
  if (res.status !== 200) {
    return null;
  }
  const counts = safeJson(res) || {};
  return Number(counts[symbol] || 0);
}

export function freshness(data) {
  const before = tradeCount(data.symbol);
  if (before === null) {
    accountingTimeouts.add(1);
    unexpectedErrors.add(true);
    return;
  }

  const tradeId = data.baseTradeId + __ITER;
  const body = settleBody({
    tradeId: tradeId,
    symbol: data.symbol,
    price: 100,
    quantity: 1,
    buyerFee: 0.1,
    sellerFee: 0.15,
    makerOrderId: tradeId * 2,
    takerOrderId: tradeId * 2 + 1,
    makerAccountId: ACCOUNT_BASE + 1,
    takerAccountId: ACCOUNT_BASE,
    buyerAccountId: ACCOUNT_BASE,
    sellerAccountId: ACCOUNT_BASE + 1,
  });
  const settled = directPost(BASE.settlement + '/settle', body, 'settle');
  const settleOk = check(settled, { 'freshness settle 200': (r) => r.status === 200 });
  if (!settleOk) {
    unexpectedErrors.add(true);
    return;
  }

  const started = Date.now();
  const deadline = started + 10000;
  let observed = before;
  while (Date.now() < deadline) {
    observed = tradeCount(data.symbol);
    if (observed !== null && observed > before) {
      accountingLag.add(Date.now() - started);
      return;
    }
    sleep(0.05);
  }
  accountingTimeouts.add(1);
  unexpectedErrors.add(true);
  check(observed, {
    'accounting event visible within 10s': (value) => value !== null && value > before,
  });
}

let previousErrors = null;
let previousTs = 0;

export function poller() {
  const now = Date.now();
  const metrics = fetchMetrics(BASE.accounting + '/actuator/prometheus');
  if (metrics) {
    if (previousTs > 0) {
      const elapsed = (now - previousTs) / 1000;
      const errors = counterDelta(metrics, 'trading_accounting_errors_total', previousErrors);
      promAccountingErrorsRate.add(errors.delta / elapsed);
      previousErrors = errors.next;
    } else {
      previousErrors = counterDelta(metrics, 'trading_accounting_errors_total', null).next;
    }
    previousTs = now;
  }
  sleep(1);
}

export const handleSummary = handleSummaryFor('accounting', (data) => ({
  http_rps: metricValue(data, 'http_reqs', 'rate'),
  summary_p99_ms: metricValue(data, 'op_accounting_summary_ms', 'p(99)'),
  counts_p99_ms: metricValue(data, 'op_accounting_counts_ms', 'p(99)'),
  freshness_p95_ms: metricValue(data, 'accounting_lag_ms', 'p(95)'),
  freshness_p99_ms: metricValue(data, 'accounting_lag_ms', 'p(99)'),
  freshness_timeouts: metricValue(data, 'accounting_freshness_timeout_total', 'count'),
  errors_per_s: metricValue(data, 'prom_accounting_errors_per_s', 'max'),
}));
