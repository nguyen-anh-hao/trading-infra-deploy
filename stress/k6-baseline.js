// SLO gate for the public order path.
//
// This is the only scenario that must pass before a release: it mixes market
// data reads with IOC orders that actually cross the book, so the full
// gateway -> order -> risk -> matching -> settlement chain is exercised.
//
// Run:
//   k6 run -e RUN_ID=$(date +%s) stress/k6-baseline.js
//
// The fixed CPU quotas in docker-compose.local.yml make the absolute latency
// comparable between runs. Use docker-compose.stress.yml to switch the stack
// to INFO logging before recording numbers for a CV.
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import { DURATION, RUN_ID, SECONDS, SYMBOLS, numberEnv, pick } from './lib/env.js';
import { checkTargets } from './lib/preflight.js';
import { createAccounts, seedGateway } from './lib/accounts.js';
import { seedBook } from './lib/book.js';
import { gwGet, gwPost } from './lib/gw.js';
import { orderBody, safeJson } from './lib/payloads.js';
import {
  orderFillRatio,
  tradesObserved,
  unexpectedErrors,
} from './lib/metrics.js';
import { handleSummaryFor, metricValue } from './lib/summary.js';

const READS = numberEnv('READ_RATE', 50);
const ORDERS = numberEnv('ORDER_RATE', 20);
const ACCOUNTS = numberEnv('ACCOUNTS', 8);

const orderAccepted = new Rate('baseline_order_accepted');

function firstVUs(rate, serviceMs) {
  return Math.max(10, Math.ceil((rate * serviceMs) / 1000));
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  scenarios: {
    reads: {
      executor: 'constant-arrival-rate',
      exec: 'reads',
      rate: READS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: firstVUs(READS, 100),
      maxVUs: firstVUs(READS, 400),
      gracefulStop: '5s',
      tags: { workload: 'reads' },
    },
    orders: {
      executor: 'ramping-arrival-rate',
      exec: 'orders',
      startRate: Math.max(5, Math.floor(ORDERS / 6)),
      timeUnit: '1s',
      stages: [
        {
          duration: Math.max(5, Math.floor(SECONDS / 4)) + 's',
          target: ORDERS,
        },
        {
          duration: Math.max(5, SECONDS - Math.floor(SECONDS / 4)) + 's',
          target: ORDERS,
        },
      ],
      preAllocatedVUs: firstVUs(ORDERS, 250),
      maxVUs: firstVUs(ORDERS, 800),
      gracefulStop: '10s',
      tags: { workload: 'orders' },
    },
  },
  thresholds: {
    'http_req_failed{scenario:orders}': ['rate<0.01'],
    'http_req_failed{scenario:reads}': ['rate<0.01'],
    'http_req_waiting{workload:orders}': ['p(99)<500'],
    'http_req_waiting{workload:reads}': ['p(99)<500'],
    op_ticker_ms: ['p(99)<200'],
    op_place_order_ms: ['p(99)<500'],
    checks: ['rate>0.99'],
    svc_unexpected_errors: ['rate<0.01'],
    baseline_order_accepted: ['rate>0.80'],
  },
};

export function setup() {
  checkTargets(['gateway', 'order', 'matching', 'risk', 'settlement', 'marketData', 'promotion']);
  seedBook();
  const accounts = createAccounts(Math.max(1, Math.min(32, ACCOUNTS)), 'baseline');
  seedGateway(accounts, 1000000, 100000);
  return { accounts: accounts };
}



function checkRead(res, label) {
  const ok = check(res, {
    [label + ' 200']: (r) => r.status === 200,
    [label + ' json']: (r) => {
      try {
        r.json();
        return true;
      } catch (err) {
        return false;
      }
    },
  });
  unexpectedErrors.add(!ok);
  return res;
}

export function reads(data) {
  const account = pick(data.accounts);
  const symbol = pick(SYMBOLS);
  const choice = Math.floor(Math.random() * 10);
  if (choice === 0) {
    checkRead(gwGet(account, '/ticker?symbol=' + symbol, 'ticker'), 'ticker');
  } else if (choice === 1) {
    checkRead(gwGet(account, '/book?symbol=' + symbol + '&depth=10', 'book'), 'book');
  } else if (choice === 2) {
    checkRead(gwGet(account, '/trades-tape?symbol=' + symbol, 'trades_tape'), 'trades-tape');
  } else if (choice === 3) {
    checkRead(
      gwGet(account, '/ohlcv?symbol=' + symbol + '&interval=1m&limit=120', 'ohlcv'),
      'ohlcv'
    );
  } else if (choice === 4) {
    checkRead(gwGet(account, '/balances', 'balances'), 'balances');
  } else if (choice === 5) {
    checkRead(gwGet(account, '/positions', 'positions'), 'positions');
  } else if (choice === 6) {
    checkRead(gwGet(account, '/pnl', 'pnl'), 'pnl');
  } else if (choice === 7) {
    checkRead(gwGet(account, '/buying-power', 'buying_power'), 'buying-power');
  } else if (choice === 8) {
    checkRead(gwGet(account, '/fee-tiers', 'fee_tiers'), 'fee-tiers');
  } else {
    checkRead(gwGet(account, '/leaderboard', 'leaderboard'), 'leaderboard');
  }
}

function referencePrice(account, symbol) {
  const res = gwGet(account, '/ticker?symbol=' + symbol, 'reference_price');
  const body = safeJson(res);
  const ticker = (body && (body.ticker || body)) || {};
  const bid = Number(ticker.best_bid || 0);
  const ask = Number(ticker.best_ask || 0);
  return {
    bid: bid > 0 ? bid : 100,
    ask: ask > 0 ? ask : 100,
  };
}

export function orders(data) {
  const account = pick(data.accounts);
  const symbol = pick(SYMBOLS);
  const ref = referencePrice(account, symbol);
  const side = Math.random() < 0.6 ? 'BUY' : 'SELL';
  const price = side === 'BUY' ? ref.ask * 1.005 : ref.bid * 0.995;
  const quantity = 1 + Math.floor(Math.random() * 5);
  const clientOrderID =
    'k6-baseline-' + RUN_ID + '-' + __VU + '-' + __ITER + '-' + Date.now();
  const body = orderBody(symbol, side, 'LIMIT', price, quantity, 'IOC', clientOrderID);

  const res = gwPost(account, '/orders', body, 'place_order');
  const parsed = safeJson(res);
  const accepted = !!(parsed && parsed.accepted === true);
  const trades = (parsed && parsed.trades) || [];

  const ok = check(res, {
    'place order http 200': (r) => r.status === 200,
    'place order accepted': () => accepted,
    'place order response has status': () => !!(parsed && parsed.status),
  });
  unexpectedErrors.add(!ok);
  orderAccepted.add(accepted);
  orderFillRatio.add(accepted && trades.length > 0 ? 1 : 0);
  tradesObserved.add(trades.length);
}

export default function (data) {
  orders(data);
}

export const handleSummary = handleSummaryFor('baseline', (data) => ({
  http_rps: metricValue(data, 'http_reqs', 'rate'),
  place_order_p99_ms: metricValue(data, 'op_place_order_ms', 'p(99)'),
  ticker_p99_ms: metricValue(data, 'op_ticker_ms', 'p(99)'),
  http_failed_ratio: metricValue(data, 'http_req_failed', 'rate'),
  checks_ratio: metricValue(data, 'checks', 'rate'),
  orders_placed: metricValue(data, 'cnt_place_order_total', 'count'),
}));
