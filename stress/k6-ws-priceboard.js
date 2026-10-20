// WebSocket-only priceboard test through the public gateway.
//
// Replaces the old "count > 1000" check with per-session evidence:
//   * handshake latency p95;
//   * snapshot delivered on every connection;
//   * message counts by type (ticker / candle / trade);
//   * reconnect until the scenario deadline.
//
// For a sustained message rate, run k6-market-data.js: its trade generator
// moves the last price and keeps ticker/candle messages flowing.
import exec from 'k6/execution';
import http from 'k6/http';
import {
  BASE,
  DURATION,
  SECONDS,
  SYMBOLS,
  numberEnv,
  pick,
  wsUrl,
} from './lib/env.js';
import { checkTargets } from './lib/preflight.js';
import { syntheticAccounts } from './lib/accounts.js';
import { orderBody, safeJson } from './lib/payloads.js';
import {
  orderFillRatio,
  recordOp,
  tradesObserved,
  unexpectedErrors,
} from './lib/metrics.js';
import { runWsLoop } from './lib/ws.js';
import { handleSummaryFor, metricValue } from './lib/summary.js';

const CLIENTS = numberEnv('WS_CLIENTS', 50);
const SYMBOL_COUNT = numberEnv('WS_SYMBOLS', 6);
const SESSION_MS = numberEnv('WS_SESSION_MS', 30000);
const TRADE_RATE = numberEnv('TRADE_RATE', 30);
const ACCOUNT_BASE = numberEnv('ACCOUNT_BASE', 7600000);

function vusFor(rate, serviceMs) {
  return Math.max(5, Math.ceil((rate * serviceMs) / 1000));
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  scenarios: {
    subscribers: {
      executor: 'constant-vus',
      exec: 'subscribers',
      vus: CLIENTS,
      duration: DURATION,
      gracefulStop: '5s',
    },
    trade_flow: {
      executor: 'constant-arrival-rate',
      exec: 'tradeFlow',
      rate: TRADE_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(TRADE_RATE, 100),
      maxVUs: vusFor(TRADE_RATE, 400),
      gracefulStop: '5s',
    },
  },
  thresholds: {
    ws_snapshot_ok: ['rate>0.99'],
    ws_session_errors: ['rate<0.01'],
    ws_handshake_ms: ['p(95)<1000'],
    'http_req_failed{scenario:trade_flow}': ['rate<0.01'],
    order_fill_ratio: ['rate>0.95'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  checkTargets(['gateway', 'marketData', 'matching']);
  return {
    url:
      wsUrl('/ws?symbols=' + SYMBOLS.slice(0, SYMBOL_COUNT).join(',')) +
      '&channels=ticker,candle,trade',
    accounts: syntheticAccounts(ACCOUNT_BASE, 1000),
  };
}

export function subscribers(data) {
  runWsLoop(data.url, {
    durationMs: SECONDS * 1000,
    sessionMs: SESSION_MS,
  });
}

function withAccount(body, accountID) {
  const parsed = JSON.parse(body);
  parsed.account_id = accountID;
  return JSON.stringify(parsed);
}

export function tradeFlow(data) {
  const iteration = exec.scenario.iterationInTest;
  const maker = data.accounts[(iteration * 2) % data.accounts.length];
  const taker = data.accounts[(iteration * 2 + 1) % data.accounts.length];
  const symbol = pick(SYMBOLS);
  const price = 100 + Math.floor(Math.random() * 2000) / 100;
  const sell = withAccount(
    orderBody(symbol, 'SELL', 'LIMIT', price, 1, 'GTC', 'k6-ws-s-' + iteration),
    maker.accountId
  );
  const buy = withAccount(
    orderBody(symbol, 'BUY', 'LIMIT', price, 1, 'GTC', 'k6-ws-b-' + iteration),
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
    const parsed = safeJson(res);
    if (parsed && parsed.trades) {
      trades += parsed.trades.length;
    }
  });
  tradesObserved.add(trades);
  orderFillRatio.add(trades > 0 ? 1 : 0);
  unexpectedErrors.add(responses[0].status !== 200 || responses[1].status !== 200);
}

export default function (data) {
  subscribers(data);
}

export const handleSummary = handleSummaryFor('ws-priceboard', (data) => ({
  sessions: metricValue(data, 'ws_sessions_total', 'count'),
  reconnects: metricValue(data, 'ws_reconnects_total', 'count'),
  handshake_p95_ms: metricValue(data, 'ws_handshake_ms', 'p(95)'),
  snapshot_ok: metricValue(data, 'ws_snapshot_ok', 'rate'),
  messages_per_s: metricValue(data, 'ws_messages_total', 'rate'),
  messages_total: metricValue(data, 'ws_messages_total', 'count'),
  checks_ratio: metricValue(data, 'checks', 'rate'),
}));
