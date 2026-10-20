// Direct order-service load (port 8087), bypassing the gateway.
//
// The gateway is a thin proxy, so this scenario measures the service's own
// saga: claim -> risk check/reserve -> matching -> settlement -> outbox +
// read model. It also proves client_order_id idempotency sequentially and
// under 50 concurrent duplicates.
import { check, sleep } from 'k6';
import http from 'k6/http';
import { BASE, DURATION, RUN_ID, SECONDS, SYMBOLS, numberEnv, pick } from './lib/env.js';
import { checkTargets } from './lib/preflight.js';
import { depositRisk, syntheticAccounts } from './lib/accounts.js';
import { seedBook } from './lib/book.js';
import { directGet, internalDelete, internalGet, internalPost } from './lib/gw.js';
import { orderBody, safeJson } from './lib/payloads.js';
import { fetchMetrics, max, sum, sumWhere } from './lib/prom.js';
import {
  duplicateConflicts,
  idempotentReplays,
  invariantPassed,
  promOrderInflight,
  promOrderOutboxAge,
  promOrderOutboxPending,
  promOrderTradesRate,
  promOrderUnknown,
  replaySameOrder,
  unexpectedErrors,
} from './lib/metrics.js';
import { handleSummaryFor, metricValue } from './lib/summary.js';

http.setResponseCallback(http.expectedStatuses(200, 201, 202, 204, 409));

const PLACE_RATE = numberEnv('PLACE_RATE', 20);
const READ_RATE = numberEnv('READ_RATE', 20);
const LIFECYCLE_RATE = numberEnv('LIFECYCLE_RATE', 5);
const REPLAYS = numberEnv('REPLAYS', 300);
const DUPLICATES = numberEnv('DUPLICATES', 50);
const ACCOUNTS = numberEnv('ACCOUNTS', 32);
const ACCOUNT_BASE = numberEnv('ACCOUNT_BASE', 900000 + (Date.now() % 100000));

const SEQ_SYMBOL = ('K6SEQ' + RUN_ID).slice(0, 16).toUpperCase();
const DUP_SYMBOL = ('K6DUP' + RUN_ID).slice(0, 16).toUpperCase();
const SEQ_CLIENT_ID = 'k6-direct-seq-' + RUN_ID;
const DUP_CLIENT_ID = 'k6-direct-dup-' + RUN_ID;

let seqOrderID = null;

function vusFor(rate, serviceMs) {
  return Math.max(5, Math.ceil((rate * serviceMs) / 1000));
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  scenarios: {
    place: {
      executor: 'constant-arrival-rate',
      exec: 'place',
      rate: PLACE_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(PLACE_RATE, 300),
      maxVUs: vusFor(PLACE_RATE, 1200),
      gracefulStop: '10s',
    },
    lifecycle: {
      executor: 'constant-arrival-rate',
      exec: 'lifecycle',
      rate: LIFECYCLE_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(LIFECYCLE_RATE, 700),
      maxVUs: vusFor(LIFECYCLE_RATE, 2000),
      gracefulStop: '10s',
    },
    reads: {
      executor: 'constant-arrival-rate',
      exec: 'reads',
      rate: READ_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(READ_RATE, 150),
      maxVUs: vusFor(READ_RATE, 600),
      gracefulStop: '5s',
    },
    idempotency_seq: {
      executor: 'shared-iterations',
      exec: 'idempotencySeq',
      vus: 1,
      iterations: REPLAYS,
      startTime: '1s',
      maxDuration: '5m',
      gracefulStop: '5s',
    },
    idempotency_concurrent: {
      executor: 'per-vu-iterations',
      exec: 'idempotencyConcurrent',
      vus: DUPLICATES,
      iterations: 1,
      startTime: '5s',
      maxDuration: '30s',
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
    'http_req_failed{scenario:place}': ['rate<0.02'],
    'http_req_failed{scenario:reads}': ['rate<0.01'],
    op_place_order_ms: ['p(99)<500'],
    op_modify_order_ms: ['p(99)<500'],
    op_cancel_order_ms: ['p(99)<500'],
    op_open_orders_ms: ['p(99)<300'],
    replay_same_order: ['rate>0.99'],
    invariant_passed: ['rate==1'],
    checks: ['rate>0.99'],
    svc_unexpected_errors: ['rate<0.02'],
    prom_order_unknown: ['max<1'],
  },
};

export function setup() {
  checkTargets(['order', 'matching', 'risk', 'settlement', 'promotion']);
  seedBook();
  const accounts = syntheticAccounts(ACCOUNT_BASE, Math.max(4, ACCOUNTS));
  depositRisk(accounts, 'CASH', 10000000);
  SYMBOLS.forEach((symbol) => {
    depositRisk(accounts, 'STOCK:' + symbol, 100000);
  });
  return { accounts: accounts, idemAccount: accounts[0] };
}



function referencePrice(symbol) {
  const res = directGet(BASE.matching + '/ticker?symbol=' + symbol, 'matching_ticker');
  const body = safeJson(res);
  const bid = body ? Number(body.best_bid || 0) : 0;
  const ask = body ? Number(body.best_ask || 0) : 0;
  return { bid: bid > 0 ? bid : 100, ask: ask > 0 ? ask : 100 };
}

export function place(data) {
  const account = pick(data.accounts);
  const symbol = pick(SYMBOLS);
  const ref = referencePrice(symbol);
  const side = Math.random() < 0.6 ? 'BUY' : 'SELL';
  const price = side === 'BUY' ? ref.ask * 1.005 : ref.bid * 0.995;
  const body = orderBody(
    symbol,
    side,
    'LIMIT',
    price,
    1 + Math.floor(Math.random() * 5),
    'IOC',
    'k6-direct-' + RUN_ID + '-' + __VU + '-' + __ITER + '-' + Date.now()
  );
  const res = internalPost(account.accountId, '/orders', body, 'place_order');
  const parsed = safeJson(res);
  const accepted = !!(parsed && parsed.accepted === true);
  const ok = check(res, {
    'direct place 200': (r) => r.status === 200,
    'direct place accepted': () => accepted,
    'direct place has status': () => !!(parsed && parsed.status),
  });
  unexpectedErrors.add(!ok);
}

export function lifecycle(data) {
  const account = pick(data.accounts);
  const symbol = pick(SYMBOLS);
  const body = orderBody(
    symbol,
    'BUY',
    'LIMIT',
    50,
    1,
    'GTC',
    'k6-direct-life-' + RUN_ID + '-' + __VU + '-' + __ITER + '-' + Date.now()
  );
  const placed = internalPost(account.accountId, '/orders', body, 'place_order');
  const parsed = safeJson(placed);
  const accepted = !!(parsed && parsed.accepted === true);
  const orderID = parsed && parsed.order_id;
  let ok = check(placed, {
    'direct lifecycle place 200': (r) => r.status === 200,
    'direct lifecycle accepted': () => accepted,
  });

  if (accepted && orderID) {
    const modifyBody = JSON.stringify({ order_id: orderID, new_price: '50.01' });
    const modified = internalPost(account.accountId, '/orders/modify', modifyBody, 'modify_order');
    const modifyJSON = safeJson(modified);
    ok = check(modified, { 'direct lifecycle modify 200': (r) => r.status === 200 }) && ok;
    const cancelID = (modifyJSON && modifyJSON.new_order_id) || orderID;
    const cancelled = internalDelete(
      account.accountId,
      '/orders?id=' + cancelID + '&symbol=' + symbol,
      'cancel_order'
    );
    ok = check(cancelled, { 'direct lifecycle cancel 200': (r) => r.status === 200 }) && ok;
  }

  const open = internalGet(account.accountId, '/orders/open?symbol=' + symbol, 'open_orders');
  ok = check(open, { 'direct lifecycle read 200': (r) => r.status === 200 }) && ok;
  unexpectedErrors.add(!ok);
}

export function reads(data) {
  const account = pick(data.accounts);
  const symbol = pick(SYMBOLS);
  const choice = Math.floor(Math.random() * 3);
  const path =
    choice === 0
      ? '/orders/open?symbol=' + symbol
      : choice === 1
        ? '/orders/history?symbol=' + symbol
        : '/trades?symbol=' + symbol;
  const operation = choice === 0 ? 'open_orders' : choice === 1 ? 'order_history' : 'trades';
  const res = internalGet(account.accountId, path, operation);
  const ok = check(res, { 'direct read 200': (r) => r.status === 200 });
  unexpectedErrors.add(!ok);
}

export function idempotencySeq(data) {
  const account = data.idemAccount;
  const body = orderBody(SEQ_SYMBOL, 'BUY', 'LIMIT', 50, 1, 'GTC', SEQ_CLIENT_ID);
  const res = internalPost(account.accountId, '/orders', body, 'place_order');
  const parsed = safeJson(res);
  const ok = check(res, {
    'direct replay 200': (r) => r.status === 200,
    'direct replay accepted': () => !!(parsed && parsed.accepted === true),
  });
  if (ok && parsed && parsed.order_id) {
    if (seqOrderID === null) {
      seqOrderID = parsed.order_id;
    }
    replaySameOrder.add(parsed.order_id === seqOrderID);
  } else {
    replaySameOrder.add(false);
  }
  idempotentReplays.add(1);
  unexpectedErrors.add(!ok);
}

export function idempotencyConcurrent(data) {
  const account = data.idemAccount;
  const body = orderBody(DUP_SYMBOL, 'BUY', 'LIMIT', 50, 1, 'GTC', DUP_CLIENT_ID);
  const res = internalPost(account.accountId, '/orders', body, 'place_order');
  const parsed = safeJson(res);
  const ok = check(res, {
    'direct duplicate 200 or 409': (r) => r.status === 200 || r.status === 409,
    'direct duplicate meaningful': () =>
      res.status === 409 || !!(parsed && parsed.accepted === true),
  });
  duplicateConflicts.add(res.status === 409 ? 1 : 0);
  unexpectedErrors.add(!ok);
}

let previousTrades = null;
let previousTs = 0;

export function poller() {
  const now = Date.now();
  const metrics = fetchMetrics(BASE.order + '/metrics');
  if (metrics) {
    const outboxAge = max(metrics, 'trading_outbox_oldest_age_seconds');
    const outboxPending = max(metrics, 'trading_outbox_pending');
    const inflight = max(metrics, 'trading_idempotency_inflight');
    const unknown = sumWhere(metrics, 'trading_orders_current', 'status="UNKNOWN"');
    const trades = sum(metrics, 'trades_total');
    if (outboxAge !== null) {
      promOrderOutboxAge.add(outboxAge);
    }
    if (outboxPending !== null) {
      promOrderOutboxPending.add(outboxPending);
    }
    if (inflight !== null) {
      promOrderInflight.add(inflight);
    }
    if (unknown !== null) {
      promOrderUnknown.add(unknown);
    }
    if (trades !== null && previousTrades !== null && previousTs > 0) {
      promOrderTradesRate.add((trades - previousTrades) / ((now - previousTs) / 1000));
    }
    previousTrades = trades;
    previousTs = now;
  }
  sleep(1);
}

export function teardown(data) {
  try {
  const account = data.idemAccount;
  [SEQ_SYMBOL, DUP_SYMBOL].forEach((symbol) => {
    internalPost(
      account.accountId,
      '/orders/bulk-cancel',
      JSON.stringify({ symbol: symbol }),
      'bulk_cancel'
    );
  });

  const problems = [];
  [SEQ_SYMBOL, DUP_SYMBOL].forEach((symbol) => {
    const res = internalGet(account.accountId, '/orders/history?symbol=' + symbol, 'order_history');
    const body = safeJson(res);
    const orders = (body && body.orders) || [];
    if (orders.length !== 1) {
      problems.push(symbol + ': expected exactly 1 order, found ' + orders.length);
    }
  });
  if (problems.length > 0) {
    throw new Error('order-service idempotency invariant failed: ' + problems.join('; '));
  }
  console.log(
    'order-service idempotency invariant passed: ' +
      REPLAYS +
      ' sequential + ' +
      DUPLICATES +
      ' concurrent replays produced one order each'
  );
  invariantPassed.add(true);
  } catch (err) {
    invariantPassed.add(false);
    throw err;
  }
}

export const handleSummary = handleSummaryFor('order-service', (data) => ({
  http_rps: metricValue(data, 'http_reqs', 'rate'),
  place_order_p99_ms: metricValue(data, 'op_place_order_ms', 'p(99)'),
  modify_order_p99_ms: metricValue(data, 'op_modify_order_ms', 'p(99)'),
  cancel_order_p99_ms: metricValue(data, 'op_cancel_order_ms', 'p(99)'),
  place_rate: metricValue(data, 'cnt_place_order_total', 'rate'),
  replay_same_order: metricValue(data, 'replay_same_order', 'rate'),
  duplicate_conflicts: metricValue(data, 'duplicate_conflict_total', 'count'),
}));
