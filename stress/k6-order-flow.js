// End-to-end order lifecycle through the public gateway.
//
// The load scenario places a resting order, modifies it, cancels it and reads
// the order/trade projections. Two correctness scenarios prove that a replay
// of one client_order_id cannot create a second order:
//   * 1 VU replays the same id N times sequentially;
//   * 50 VUs send the same id concurrently.
// teardown() reads the order history and fails the run unless exactly one
// order exists for each idempotency symbol.
import { check, sleep } from 'k6';
import http from 'k6/http';
import { BASE, DURATION, RUN_ID, SECONDS, SYMBOLS, numberEnv, pick } from './lib/env.js';
import { checkTargets } from './lib/preflight.js';
import { createAccounts, seedGateway } from './lib/accounts.js';
import { seedBook } from './lib/book.js';
import { gwDelete, gwGet, gwPost } from './lib/gw.js';
import { orderBody, safeJson } from './lib/payloads.js';
import { fetchMetrics, max, sumWhere } from './lib/prom.js';
import {
  duplicateConflicts,
  idempotentReplays,
  invariantPassed,
  promOrderInflight,
  promOrderOutboxAge,
  promOrderOutboxPending,
  promOrderUnknown,
  replaySameOrder,
  unexpectedErrors,
} from './lib/metrics.js';
import { handleSummaryFor, metricValue } from './lib/summary.js';

http.setResponseCallback(http.expectedStatuses(200, 201, 202, 204, 409));

const LIFECYCLE_RATE = numberEnv('LIFECYCLE_RATE', 10);
const READ_RATE = numberEnv('READ_RATE', 20);
const REPLAYS = numberEnv('REPLAYS', 1000);
const DUPLICATES = numberEnv('DUPLICATES', 50);
const ACCOUNTS = numberEnv('ACCOUNTS', 4);

const SEQ_SYMBOL = ('K6SEQ' + RUN_ID).slice(0, 16).toUpperCase();
const DUP_SYMBOL = ('K6DUP' + RUN_ID).slice(0, 16).toUpperCase();
const SEQ_CLIENT_ID = 'k6-seq-' + RUN_ID;
const DUP_CLIENT_ID = 'k6-dup-' + RUN_ID;

let seqOrderID = null;

function vusFor(rate, serviceMs) {
  return Math.max(5, Math.ceil((rate * serviceMs) / 1000));
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  scenarios: {
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
    'http_req_failed{scenario:lifecycle}': ['rate<0.02'],
    'http_req_failed{scenario:reads}': ['rate<0.01'],
    op_place_order_ms: ['p(99)<500'],
    op_modify_order_ms: ['p(99)<500'],
    op_cancel_order_ms: ['p(99)<500'],
    op_open_orders_ms: ['p(99)<300'],
    replay_same_order: ['rate>0.99'],
    invariant_passed: ['rate==1'],
    checks: ['rate>0.99'],
    svc_unexpected_errors: ['rate<0.02'],
  },
};

export function setup() {
  checkTargets(['gateway', 'order', 'matching', 'risk', 'settlement', 'promotion']);
  seedBook();
  const accounts = createAccounts(Math.max(1, Math.min(8, ACCOUNTS)), 'order-flow');
  seedGateway(accounts, 1000000, 100000);
  return { accounts: accounts, idemAccount: accounts[0] };
}



function referencePrice(account, symbol) {
  const res = gwGet(account, '/ticker?symbol=' + symbol, 'reference_price');
  const body = safeJson(res);
  const ticker = (body && (body.ticker || body)) || {};
  const bid = Number(ticker.best_bid || 0);
  const ask = Number(ticker.best_ask || 0);
  return { bid: bid > 0 ? bid : 100, ask: ask > 0 ? ask : 100 };
}

export function lifecycle(data) {
  const account = pick(data.accounts);
  const symbol = pick(SYMBOLS);
  const ref = referencePrice(account, symbol);
  const side = Math.random() < 0.5 ? 'BUY' : 'SELL';
  // Rest away from the touch so modify/cancel always have a live order.
  const price = side === 'BUY' ? ref.bid * 0.98 : ref.ask * 1.02;
  const quantity = 1 + Math.floor(Math.random() * 5);
  const clientOrderID = 'k6-life-' + RUN_ID + '-' + __VU + '-' + __ITER + '-' + Date.now();
  const placeBody = orderBody(symbol, side, 'LIMIT', price, quantity, 'GTC', clientOrderID);

  const placed = gwPost(account, '/orders', placeBody, 'place_order');
  const placeJSON = safeJson(placed);
  const accepted = !!(placeJSON && placeJSON.accepted === true);
  const orderID = placeJSON && placeJSON.order_id;
  let ok = check(placed, {
    'lifecycle place 200': (r) => r.status === 200,
    'lifecycle place accepted': () => accepted,
    'lifecycle place has order id': () => !!orderID,
  });

  if (accepted && orderID) {
    const modifyBody = JSON.stringify({
      order_id: orderID,
      new_price: (side === 'BUY' ? price * 0.999 : price * 1.001).toFixed(2),
    });
    const modified = gwPost(account, '/orders/modify', modifyBody, 'modify_order');
    const modifyJSON = safeJson(modified);
    ok = check(modified, { 'lifecycle modify 200': (r) => r.status === 200 }) && ok;
    const cancelID = (modifyJSON && modifyJSON.new_order_id) || orderID;

    const cancelled = gwDelete(
      account,
      '/orders?id=' + cancelID + '&symbol=' + symbol,
      'cancel_order'
    );
    ok = check(cancelled, { 'lifecycle cancel 200': (r) => r.status === 200 }) && ok;
  }

  const open = gwGet(account, '/orders/open?symbol=' + symbol, 'open_orders');
  const history = gwGet(account, '/orders/history?symbol=' + symbol, 'order_history');
  const trades = gwGet(account, '/trades?symbol=' + symbol, 'trades');
  ok =
    check(open, { 'lifecycle open 200': (r) => r.status === 200 }) &&
    check(history, { 'lifecycle history 200': (r) => r.status === 200 }) &&
    check(trades, { 'lifecycle trades 200': (r) => r.status === 200 }) &&
    ok;

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
  const res = gwGet(account, path, operation);
  const ok = check(res, { 'order read 200': (r) => r.status === 200 });
  unexpectedErrors.add(!ok);
}

export function idempotencySeq(data) {
  const account = data.idemAccount;
  const body = orderBody(SEQ_SYMBOL, 'BUY', 'LIMIT', 50, 1, 'GTC', SEQ_CLIENT_ID);
  const res = gwPost(account, '/orders', body, 'place_order');
  const parsed = safeJson(res);
  const ok = check(res, {
    'replay http 200': (r) => r.status === 200,
    'replay accepted': () => !!(parsed && parsed.accepted === true),
    'replay has order id': () => !!(parsed && parsed.order_id),
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
  const res = gwPost(account, '/orders', body, 'place_order');
  const parsed = safeJson(res);
  const ok = check(res, {
    'duplicate returns 200 or 409': (r) => r.status === 200 || r.status === 409,
    'duplicate response is meaningful': () =>
      res.status === 409 || !!(parsed && parsed.accepted === true),
  });
  duplicateConflicts.add(res.status === 409 ? 1 : 0);
  unexpectedErrors.add(!ok);
}


export function poller() {
  const now = Date.now();
  const metrics = fetchMetrics(BASE.order + '/metrics');
  if (metrics) {
    const outboxAge = max(metrics, 'trading_outbox_oldest_age_seconds');
    const outboxPending = max(metrics, 'trading_outbox_pending');
    const inflight = max(metrics, 'trading_idempotency_inflight');
    const unknown = sumWhere(metrics, 'trading_orders_current', 'status="UNKNOWN"');
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
  }
  sleep(1);
}

export function teardown(data) {
  try {
  const account = data.idemAccount;
  [SEQ_SYMBOL, DUP_SYMBOL].forEach((symbol) => {
    gwPost(account, '/orders/bulk-cancel', JSON.stringify({ symbol: symbol }), 'bulk_cancel');
  });

  const problems = [];
  [SEQ_SYMBOL, DUP_SYMBOL].forEach((symbol) => {
    const res = gwGet(account, '/orders/history?symbol=' + symbol, 'order_history');
    const body = safeJson(res);
    const orders = (body && body.orders) || [];
    if (orders.length !== 1) {
      problems.push(symbol + ': expected exactly 1 order, found ' + orders.length);
    }
  });
  if (problems.length > 0) {
    throw new Error('idempotency invariant failed: ' + problems.join('; '));
  }
  console.log(
    'idempotency invariant passed: 1 order for ' +
      SEQ_SYMBOL +
      ' after ' +
      REPLAYS +
      ' sequential replays; 1 order for ' +
      DUP_SYMBOL +
      ' after ' +
      DUPLICATES +
      ' concurrent duplicates'
  );
  invariantPassed.add(true);
  } catch (err) {
    invariantPassed.add(false);
    throw err;
  }
}

export const handleSummary = handleSummaryFor('order-flow', (data) => ({
  http_rps: metricValue(data, 'http_reqs', 'rate'),
  place_order_p99_ms: metricValue(data, 'op_place_order_ms', 'p(99)'),
  modify_order_p99_ms: metricValue(data, 'op_modify_order_ms', 'p(99)'),
  cancel_order_p99_ms: metricValue(data, 'op_cancel_order_ms', 'p(99)'),
  http_failed_ratio: metricValue(data, 'http_req_failed', 'rate'),
  replay_same_order: metricValue(data, 'replay_same_order', 'rate'),
  duplicate_conflicts: metricValue(data, 'duplicate_conflict_total', 'count'),
}));
