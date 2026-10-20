// Market-data service: REST read model, WebSocket fan-out and a trade
// generator that keeps the book moving.
//
// The trade generator sends crossing pairs to the matching engine at a fixed
// rate. That changes the last price, which makes the WebSocket hub emit ticker
// and candle messages even when NATS is not configured. Tape/trade messages
// additionally require the NATS trade spool to be connected.
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { BASE, DURATION, SECONDS, SYMBOLS, numberEnv, pick } from './lib/env.js';
import { checkTargets } from './lib/preflight.js';
import { syntheticAccounts } from './lib/accounts.js';
import { directGet } from './lib/gw.js';
import { orderBody, safeJson } from './lib/payloads.js';
import { counterDelta, fetchMetrics, max } from './lib/prom.js';
import {
  orderFillRatio,
  promMarketDedupeRate,
  promMarketTicksRate,
  promWsConnections,
  promWsDroppedRate,
  promWsSentRate,
  recordOp,
  tradesObserved,
  unexpectedErrors,
} from './lib/metrics.js';
import { runWsLoop } from './lib/ws.js';
import { handleSummaryFor, metricValue } from './lib/summary.js';

const READ_RATE = numberEnv('READ_RATE', 100);
const TRADE_RATE = numberEnv('TRADE_RATE', 30);
const WS_CLIENTS = numberEnv('WS_CLIENTS', 50);
const WS_SYMBOLS = numberEnv('WS_SYMBOLS', 6);
const ACCOUNTS = numberEnv('ACCOUNTS', 1000);
const ACCOUNT_BASE = numberEnv('ACCOUNT_BASE', 7500000);

function vusFor(rate, serviceMs) {
  return Math.max(5, Math.ceil((rate * serviceMs) / 1000));
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  scenarios: {
    rest: {
      executor: 'constant-arrival-rate',
      exec: 'rest',
      rate: READ_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(READ_RATE, 100),
      maxVUs: vusFor(READ_RATE, 500),
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
    ws: {
      executor: 'constant-vus',
      exec: 'wsClients',
      vus: WS_CLIENTS,
      duration: DURATION,
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
    'http_req_failed{scenario:rest}': ['rate<0.01'],
    'http_req_failed{scenario:trade_flow}': ['rate<0.01'],
    op_ticker_ms: ['p(99)<300'],
    op_book_ms: ['p(99)<300'],
    op_trades_tape_ms: ['p(99)<300'],
    op_ohlcv_ms: ['p(99)<300'],
    ws_snapshot_ok: ['rate>0.99'],
    ws_session_errors: ['rate<0.01'],
    prom_ws_dropped_per_s: ['max<1'],
    order_fill_ratio: ['rate>0.95'],
    checks: ['rate>0.99'],
    svc_unexpected_errors: ['rate<0.01'],
  },
};

export function setup() {
  checkTargets(['marketData', 'matching']);
  return {
    accounts: syntheticAccounts(ACCOUNT_BASE, ACCOUNTS),
    wsUrl:
      BASE.marketData.replace(/^http/, 'ws') +
      '/ws?symbols=' +
      SYMBOLS.slice(0, WS_SYMBOLS).join(',') +
      '&channels=ticker,candle,trade',
  };
}

export function rest() {
  const symbol = pick(SYMBOLS);
  const choice = Math.floor(Math.random() * 4);
  let operation = 'ticker';
  let path = '/ticker?symbol=' + symbol;
  if (choice === 1) {
    operation = 'book';
    path = '/book?symbol=' + symbol + '&depth=10';
  } else if (choice === 2) {
    operation = 'trades_tape';
    path = '/trades-tape?symbol=' + symbol;
  } else if (choice === 3) {
    operation = 'ohlcv';
    path = '/ohlcv?symbol=' + symbol + '&interval=1m&limit=120';
  }
  const res = directGet(BASE.marketData + path, operation);
  const ok = check(res, { 'market data read 200': (r) => r.status === 200 });
  unexpectedErrors.add(!ok);
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
    orderBody(symbol, 'SELL', 'LIMIT', price, 1, 'GTC', 'k6-md-s-' + iteration),
    maker.accountId
  );
  const buy = withAccount(
    orderBody(symbol, 'BUY', 'LIMIT', price, 1, 'GTC', 'k6-md-b-' + iteration),
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

export function wsClients(data) {
  runWsLoop(data.wsUrl, {
    durationMs: SECONDS * 1000,
    sessionMs: numberEnv('WS_SESSION_MS', 30000),
  });
}

let previousDropped = null;
let previousSent = null;
let previousTicks = null;
let previousDedupe = null;
let previousTs = 0;

export function poller() {
  const now = Date.now();
  const metrics = fetchMetrics(BASE.marketData + '/metrics');
  if (metrics) {
    const connections = max(metrics, 'trading_ws_connections');
    if (connections !== null) {
      promWsConnections.add(connections);
    }
    if (previousTs > 0) {
      const elapsed = (now - previousTs) / 1000;
      const dropped = counterDelta(metrics, 'trading_ws_dropped_total', previousDropped);
      const sent = counterDelta(metrics, 'trading_ws_messages_sent_total', previousSent);
      const ticks = counterDelta(metrics, 'trading_market_ticks_ingested_total', previousTicks);
      const dedupe = counterDelta(metrics, 'trading_market_dedupe_total', previousDedupe);
      promWsDroppedRate.add(dropped.delta / elapsed);
      promWsSentRate.add(sent.delta / elapsed);
      promMarketTicksRate.add(ticks.delta / elapsed);
      promMarketDedupeRate.add(dedupe.delta / elapsed);
      previousDropped = dropped.next;
      previousSent = sent.next;
      previousTicks = ticks.next;
      previousDedupe = dedupe.next;
    } else {
      previousDropped = counterDelta(metrics, 'trading_ws_dropped_total', null).next;
      previousSent = counterDelta(metrics, 'trading_ws_messages_sent_total', null).next;
      previousTicks = counterDelta(metrics, 'trading_market_ticks_ingested_total', null).next;
      previousDedupe = counterDelta(metrics, 'trading_market_dedupe_total', null).next;
    }
    previousTs = now;
  }
  sleep(1);
}

export default function (data) {
  rest();
}

export const handleSummary = handleSummaryFor('market-data', (data) => ({
  http_rps: metricValue(data, 'http_reqs', 'rate'),
  ticker_p99_ms: metricValue(data, 'op_ticker_ms', 'p(99)'),
  ohlcv_p99_ms: metricValue(data, 'op_ohlcv_ms', 'p(99)'),
  ws_handshake_p95_ms: metricValue(data, 'ws_handshake_ms', 'p(95)'),
  ws_messages_per_s: metricValue(data, 'ws_messages_total', 'rate'),
  ws_messages_total: metricValue(data, 'ws_messages_total', 'count'),
  ws_sessions: metricValue(data, 'ws_sessions_total', 'count'),
  ws_snapshot_ok: metricValue(data, 'ws_snapshot_ok', 'rate'),
  ws_connections_max: metricValue(data, 'prom_ws_connections', 'max'),
  ws_sent_per_s: metricValue(data, 'prom_ws_sent_per_s', 'avg'),
  ws_dropped_per_s: metricValue(data, 'prom_ws_dropped_per_s', 'max'),
  trades_per_s: metricValue(data, 'prom_market_ticks_per_s', 'avg'),
}));
