// Full api-gateway surface.
//
// Scenarios:
//   browse         market-data / portfolio / incentive reads through the edge
//   write          IOC orders through the edge (full downstream chain)
//   auth_negative  401/403 probes: unknown key, bad signature, missing perms
//   rate_limit     only with -e RATE_LIMIT=true; 20 flooding clients + control
//   ws             only with -e WS=true; priceboard subscriptions via the edge
//
// Expected 4xx responses are recorded in dedicated counters, so they never
// poison the http_req_failed SLO thresholds.
import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import {
  API_KEY,
  API_SECRET,
  BASE,
  DURATION,
  RUN_ID,
  SECONDS,
  SYMBOLS,
  boolEnv,
  numberEnv,
  pick,
  wsUrl,
} from './lib/env.js';
import { checkTargets } from './lib/preflight.js';
import { createAccounts, seedGateway } from './lib/accounts.js';
import { seedBook } from './lib/book.js';
import { apiHeaders } from './lib/auth.js';
import { gwGet, gwPost } from './lib/gw.js';
import { orderBody, safeJson } from './lib/payloads.js';
import { recordOp } from './lib/metrics.js';
import {
  gateway400,
  gateway401,
  gateway403,
  gateway429,
  gatewayControlAllowed,
  gatewayFloodAllowed,
  orderFillRatio,
  tradesObserved,
  unexpectedErrors,
} from './lib/metrics.js';
import { runWsLoop } from './lib/ws.js';
import { handleSummaryFor, metricValue } from './lib/summary.js';

// Expected 401/403/404/409/422/429 responses are part of the contract. k6
// counts 4xx as failed by default; declaring them expected keeps
// http_req_failed focused on 5xx and transport errors.
http.setResponseCallback(
  http.expectedStatuses(200, 201, 202, 204, 401, 403, 409, 429)
);

const READ_RATE = numberEnv('READ_RATE', 100);
const WRITE_RATE = numberEnv('WRITE_RATE', 10);
const AUTH_RATE = numberEnv('AUTH_RATE', 10);
const ACCOUNTS = numberEnv('ACCOUNTS', 8);

const RATE_LIMIT = boolEnv('RATE_LIMIT', false);
const LIMIT_PER_SEC = numberEnv('RATE_LIMIT_PER_SEC', 50);
const FLOOD_CLIENTS = numberEnv('FLOOD_CLIENTS', 4);
const FLOOD_MULTIPLIER = numberEnv('FLOOD_MULTIPLIER', 1.2);
const CONTROL_RPS = numberEnv('CONTROL_RPS', 5);
const RATE_LIMIT_SECONDS = numberEnv('RATE_LIMIT_SECONDS', 30);
const LIMIT_TOTAL_RATE =
  Math.round(FLOOD_CLIENTS * LIMIT_PER_SEC * FLOOD_MULTIPLIER) + CONTROL_RPS;
const CONTROL_EVERY = Math.max(
  1,
  Math.floor((FLOOD_CLIENTS * LIMIT_PER_SEC * FLOOD_MULTIPLIER) / CONTROL_RPS)
);

const WS_ENABLED = boolEnv('WS', false);
const WS_CLIENTS = numberEnv('WS_CLIENTS', 100);

function vusFor(rate, serviceMs) {
  return Math.max(5, Math.ceil((rate * serviceMs) / 1000));
}

const thresholds = {};
const scenarioOptions = {};

// The rate-limit run is a dedicated profile: every other scenario would share
// the same client IP and be throttled by the 50 req/s bucket, which would make
// the limiter result meaningless.
if (!RATE_LIMIT) {
  thresholds['http_req_failed{scenario:browse}'] = ['rate<0.01'];
  thresholds['http_req_failed{scenario:write}'] = ['rate<0.02'];
  thresholds.op_place_order_ms = ['p(99)<500'];
  thresholds.op_ticker_ms = ['p(99)<200'];
  thresholds.checks = ['rate>0.99'];
  thresholds.svc_unexpected_errors = ['rate<0.02'];

  scenarioOptions.browse = {
    executor: 'constant-arrival-rate',
    exec: 'browse',
    rate: READ_RATE,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: vusFor(READ_RATE, 150),
    maxVUs: vusFor(READ_RATE, 600),
    gracefulStop: '5s',
  };
  scenarioOptions.write = {
    executor: 'ramping-arrival-rate',
    exec: 'write',
    startRate: Math.max(5, Math.floor(WRITE_RATE / 6)),
    timeUnit: '1s',
    stages: [
      {
        duration: Math.max(5, Math.floor(SECONDS / 4)) + 's',
        target: WRITE_RATE,
      },
      {
        duration: Math.max(5, SECONDS - Math.floor(SECONDS / 4)) + 's',
        target: WRITE_RATE,
      },
    ],
    preAllocatedVUs: vusFor(WRITE_RATE, 400),
    maxVUs: vusFor(WRITE_RATE, 1200),
    gracefulStop: '10s',
  };
  scenarioOptions.auth_negative = {
    executor: 'constant-arrival-rate',
    exec: 'authNegative',
    rate: AUTH_RATE,
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: vusFor(AUTH_RATE, 100),
    maxVUs: vusFor(AUTH_RATE, 400),
    gracefulStop: '5s',
  };
}

if (RATE_LIMIT) {
  thresholds.gateway_flood_allowed = ['rate>0.75', 'rate<0.95'];
  thresholds.gateway_control_allowed = ['rate>0.99'];
  thresholds.gateway_429_total = ['count>0'];
  scenarioOptions.rate_limit = {
    executor: 'constant-arrival-rate',
    exec: 'rateLimit',
    rate: LIMIT_TOTAL_RATE,
    timeUnit: '1s',
    duration: RATE_LIMIT_SECONDS + 's',
    preAllocatedVUs: vusFor(LIMIT_TOTAL_RATE, 400),
    maxVUs: vusFor(LIMIT_TOTAL_RATE, 1200),
    gracefulStop: '5s',
  };
}

if (WS_ENABLED) {
  thresholds.ws_snapshot_ok = ['rate>0.99'];
  thresholds.ws_session_errors = ['rate<0.01'];
  scenarioOptions.ws = {
    executor: 'constant-vus',
    exec: 'wsPriceboard',
    vus: WS_CLIENTS,
    duration: DURATION,
    gracefulStop: '5s',
  };
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  scenarios: scenarioOptions,
  thresholds: thresholds,
};

export function setup() {
  if (RATE_LIMIT) {
    // The limiter profile only needs the edge and the cheap /fee-tiers
    // downstream. Creating and funding accounts here would be throttled by the
    // very bucket under test, so use the built-in demo key.
    checkTargets(['gateway', 'promotion']);
    return {
      accounts: [{ idx: 0, accountId: 1, apiKey: API_KEY, secret: API_SECRET }],
      readOnly: null,
    };
  }

  checkTargets(['gateway', 'order', 'matching', 'risk', 'settlement', 'marketData', 'promotion']);
  seedBook();
  const accounts = createAccounts(Math.max(2, Math.min(32, ACCOUNTS)), 'gateway');
  seedGateway(accounts, 1000000, 100000);

  const readOnlyBody = JSON.stringify({ permissions: ['read_only'] });
  const keyResponse = gwPost(
    accounts[0],
    '/accounts/api-keys',
    readOnlyBody,
    'create_api_key'
  );
  const created = safeJson(keyResponse);
  if (keyResponse.status !== 200 || !created) {
    throw new Error('setup could not create a read-only API key');
  }
  return {
    accounts: accounts,
    readOnly: { apiKey: created.api_key, secret: created.secret_key },
  };
}



export function browse(data) {
  const account = pick(data.accounts);
  const symbol = pick(SYMBOLS);
  const choice = Math.floor(Math.random() * 8);
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
  } else if (choice === 4) {
    operation = 'balances';
    path = '/balances';
  } else if (choice === 5) {
    operation = 'positions';
    path = '/positions';
  } else if (choice === 6) {
    operation = 'fee_tiers';
    path = '/fee-tiers';
  } else if (choice === 7) {
    operation = 'leaderboard';
    path = '/leaderboard';
  }
  const res = gwGet(account, path, operation);
  const ok = check(res, { 'gateway read 200': (r) => r.status === 200 });
  unexpectedErrors.add(!ok);
}

function referencePrice(account, symbol) {
  const res = gwGet(account, '/ticker?symbol=' + symbol, 'reference_price');
  const body = safeJson(res);
  const ticker = (body && (body.ticker || body)) || {};
  const bid = Number(ticker.best_bid || 0);
  const ask = Number(ticker.best_ask || 0);
  return { bid: bid > 0 ? bid : 100, ask: ask > 0 ? ask : 100 };
}

export function write(data) {
  const account = pick(data.accounts);
  const symbol = pick(SYMBOLS);
  const ref = referencePrice(account, symbol);
  const side = Math.random() < 0.6 ? 'BUY' : 'SELL';
  const price = side === 'BUY' ? ref.ask * 1.005 : ref.bid * 0.995;
  const body = orderBody(
    symbol,
    side,
    'LIMIT',
    price,
    1 + Math.floor(Math.random() * 5),
    'IOC',
    'k6-gw-' + RUN_ID + '-' + __VU + '-' + __ITER + '-' + Date.now()
  );
  const res = gwPost(account, '/orders', body, 'place_order');
  const parsed = safeJson(res);
  const accepted = !!(parsed && parsed.accepted === true);
  const trades = (parsed && parsed.trades) || [];
  const ok = check(res, {
    'gateway order 200': (r) => r.status === 200,
    'gateway order accepted': () => accepted,
  });
  unexpectedErrors.add(!ok);
  orderFillRatio.add(accepted && trades.length > 0 ? 1 : 0);
  tradesObserved.add(trades.length);
}

function expectStatus(res, expected, label) {
  const ok = check(res, {
    [label + ' status ' + expected]: (r) => r.status === expected,
  });
  unexpectedErrors.add(!ok);
  return ok;
}

export function authNegative(data) {
  const account = pick(data.accounts);
  const symbol = pick(SYMBOLS);
  const probe = Math.floor(Math.random() * 4);

  if (probe === 0) {
    const headers = {
      Accept: 'application/json',
      'X-API-Key': 'invalid-' + Date.now() + '-' + Math.floor(Math.random() * 100000),
    };
    const res = http.get(BASE.gateway + '/balances', {
      headers: headers,
      tags: { operation: 'balances', probe: 'unknown_key' },
    });
    recordOp('balances', res);
    if (res.status === 401) {
      gateway401.add(1);
    }
    expectStatus(res, 401, 'unknown key');
  } else if (probe === 1) {
    const headers = apiHeaders('GET', '/balances', null, account);
    headers['X-Signature'] = 'deadbeef';
    const res = http.get(BASE.gateway + '/balances', {
      headers: headers,
      tags: { operation: 'balances', probe: 'bad_signature' },
    });
    recordOp('balances', res);
    if (res.status === 401) {
      gateway401.add(1);
    }
    expectStatus(res, 401, 'bad signature');
  } else if (probe === 2) {
    const body = orderBody(symbol, 'BUY', 'LIMIT', 90, 1, 'GTC', 'k6-neg-' + Date.now());
    const res = http.post(BASE.gateway + '/orders', body, {
      headers: apiHeaders('POST', '/orders', body, data.readOnly),
      tags: { operation: 'place_order', probe: 'missing_trade_permission' },
    });
    recordOp('place_order', res);
    if (res.status === 403) {
      gateway403.add(1);
    } else if (res.status === 400) {
      gateway400.add(1);
    }
    expectStatus(res, 403, 'read-only order');
  } else {
    const body = JSON.stringify({ asset: 'CASH', amount: '1' });
    const res = http.post(BASE.gateway + '/withdraw', body, {
      headers: apiHeaders('POST', '/withdraw', body, data.readOnly),
      tags: { operation: 'withdraw', probe: 'missing_withdraw_permission' },
    });
    recordOp('withdraw', res);
    if (res.status === 403) {
      gateway403.add(1);
    } else if (res.status === 400) {
      gateway400.add(1);
    }
    expectStatus(res, 403, 'read-only withdraw');
  }
}

export function rateLimit(data) {
  const iteration = exec.scenario.iterationInTest;
  const isControl = iteration % CONTROL_EVERY === 0;
  const floodIndex = iteration % FLOOD_CLIENTS;
  const clientIP = isControl ? '10.99.0.1' : '10.42.0.' + (floodIndex + 1);
  const account = data.accounts[floodIndex % data.accounts.length];
  const path = '/fee-tiers';
  const headers = apiHeaders('GET', path, null, account);
  headers['X-Forwarded-For'] = clientIP;
  const res = http.get(BASE.gateway + path, {
    headers: headers,
    responseType: 'none',
    tags: { operation: 'fee_tiers', client: isControl ? 'control' : 'flood' },
  });
  recordOp('fee_tiers', res);
  const allowed = res.status === 200;
  if (isControl) {
    gatewayControlAllowed.add(allowed);
  } else {
    gatewayFloodAllowed.add(allowed);
  }
  if (res.status === 429) {
    gateway429.add(1);
  }
}

export function wsPriceboard() {
  const symbols = SYMBOLS.join(',');
  runWsLoop(wsUrl('/ws?symbols=' + symbols + '&channels=ticker,candle,trade'), {
    durationMs: SECONDS * 1000,
    sessionMs: numberEnv('WS_SESSION_MS', 30000),
  });
}

export default function (data) {
  browse(data);
}

export const handleSummary = handleSummaryFor('gateway', (data) => ({
  http_rps: metricValue(data, 'http_reqs', 'rate'),
  place_order_p99_ms: metricValue(data, 'op_place_order_ms', 'p(99)'),
  ticker_p99_ms: metricValue(data, 'op_ticker_ms', 'p(99)'),
  http_failed_ratio: metricValue(data, 'http_req_failed', 'rate'),
  gateway_flood_allowed: metricValue(data, 'gateway_flood_allowed', 'rate'),
  gateway_control_allowed: metricValue(data, 'gateway_control_allowed', 'rate'),
  gateway_429: metricValue(data, 'gateway_429_total', 'count'),
  limit_per_sec: LIMIT_PER_SEC,
  flood_clients: FLOOD_CLIENTS,
  ws_messages: metricValue(data, 'ws_messages_total', 'count'),
}));
