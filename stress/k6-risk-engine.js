// Direct risk-engine load (port 9002).
//
// The overdraw scenario is the important one: one account holds exactly 1,000
// CASH and 50 VUs simultaneously try to reserve 100. A correct Lua-backed
// implementation accepts exactly 10 and rejects 40 with 409, regardless of
// arrival order. teardown() then verifies the account is fully frozen and has
// no spendable balance.
import { check, sleep } from 'k6';
import http from 'k6/http';
import { BASE, DURATION, SECONDS, SYMBOLS, numberEnv, pick } from './lib/env.js';
import { checkTargets } from './lib/preflight.js';
import { depositRisk, syntheticAccounts } from './lib/accounts.js';
import { directGet, directPost } from './lib/gw.js';
import { riskCheckBody, safeJson } from './lib/payloads.js';
import { counterDelta, fetchMetrics, max } from './lib/prom.js';
import {
  overdrawConflict,
  overdrawSuccess,
  invariantPassed,
  promRiskApplyErrorsRate,
  promRiskJournalLag,
  promRiskJournalLength,
  unexpectedErrors,
} from './lib/metrics.js';
import { handleSummaryFor, metricValue } from './lib/summary.js';

http.setResponseCallback(http.expectedStatuses(200, 409));

const CHECK_RATE = numberEnv('CHECK_RATE', 150);
const RESERVE_RATE = numberEnv('RESERVE_RATE', 50);
const READ_RATE = numberEnv('READ_RATE', 50);
const ACCOUNTS = numberEnv('ACCOUNTS', 32);
const ACCOUNT_BASE = numberEnv('ACCOUNT_BASE', 8000000 + (Date.now() % 100000));
const OVERDRAW_AMOUNT = numberEnv('OVERDRAW_AMOUNT', 100);
const OVERDRAW_BALANCE = numberEnv('OVERDRAW_BALANCE', 1000);
const OVERDRAW_VUS = numberEnv('OVERDRAW_VUS', 50);
const EXPECTED_SUCCESS = Math.min(
  OVERDRAW_VUS,
  Math.floor(OVERDRAW_BALANCE / OVERDRAW_AMOUNT)
);
const EXPECTED_CONFLICT = OVERDRAW_VUS - EXPECTED_SUCCESS;
const EXPECTED_FROZEN = EXPECTED_SUCCESS * OVERDRAW_AMOUNT;

function vusFor(rate, serviceMs) {
  return Math.max(5, Math.ceil((rate * serviceMs) / 1000));
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  scenarios: {
    check: {
      executor: 'constant-arrival-rate',
      exec: 'checkLoad',
      rate: CHECK_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(CHECK_RATE, 50),
      maxVUs: vusFor(CHECK_RATE, 300),
      gracefulStop: '5s',
    },
    reserve_release: {
      executor: 'constant-arrival-rate',
      exec: 'reserveRelease',
      rate: RESERVE_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(RESERVE_RATE, 50),
      maxVUs: vusFor(RESERVE_RATE, 300),
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
    overdraw: {
      executor: 'per-vu-iterations',
      exec: 'overdraw',
      vus: OVERDRAW_VUS,
      iterations: 1,
      startTime: String(SECONDS + 2) + 's',
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
    'http_req_failed{scenario:check}': ['rate<0.01'],
    'http_req_failed{scenario:reserve_release}': ['rate<0.01'],
    'http_req_failed{scenario:reads}': ['rate<0.01'],
    op_risk_check_ms: ['p(99)<50'],
    op_risk_reserve_ms: ['p(99)<50'],
    overdraw_success_total: ['count==' + EXPECTED_SUCCESS],
    overdraw_conflict_total: ['count==' + EXPECTED_CONFLICT],
    invariant_passed: ['rate==1'],
    prom_risk_journal_lag_s: ['p(95)<30'],
    prom_risk_apply_errors_per_s: ['max<1'],
    checks: ['rate>0.99'],
    svc_unexpected_errors: ['rate<0.01'],
  },
};

export function setup() {
  checkTargets(['risk']);
  const accounts = syntheticAccounts(ACCOUNT_BASE, ACCOUNTS);
  depositRisk(accounts, 'CASH', 1000000);
  SYMBOLS.forEach((symbol) => {
    depositRisk(accounts, 'STOCK:' + symbol, 100000);
  });
  const overdrawAccount = syntheticAccounts(ACCOUNT_BASE + ACCOUNTS + 1, 1)[0];
  depositRisk([overdrawAccount], 'CASH', OVERDRAW_BALANCE);
  return { accounts: accounts, overdrawAccount: overdrawAccount };
}



export function checkLoad(data) {
  const account = pick(data.accounts);
  const symbol = pick(SYMBOLS);
  const side = Math.random() < 0.5 ? 'BUY' : 'SELL';
  const body = riskCheckBody(account.accountId, symbol, side, 100, 1, 0.1);
  const res = directPost(BASE.risk + '/check', body, 'risk_check');
  const parsed = safeJson(res);
  const ok = check(res, {
    'risk check 200': (r) => r.status === 200,
    'risk check approved': () => !!(parsed && parsed.approved === true),
  });
  unexpectedErrors.add(!ok);
}

export function reserveRelease(data) {
  const account = pick(data.accounts);
  const symbol = pick(SYMBOLS);
  const body = riskCheckBody(account.accountId, symbol, 'BUY', 1, 10, 0);
  const reserved = directPost(BASE.risk + '/reserve', body, 'risk_reserve');
  const reserveJSON = safeJson(reserved);
  const released = directPost(BASE.risk + '/release', body, 'risk_release');
  const releaseJSON = safeJson(released);
  const ok = check(reserved, {
    'risk reserve 200': (r) => r.status === 200,
    'risk reserve success': () => !!(reserveJSON && reserveJSON.success === true),
  });
  const releasedOk = check(released, {
    'risk release 200': (r) => r.status === 200,
    'risk release success': () => !!(releaseJSON && releaseJSON.success === true),
  });
  unexpectedErrors.add(!(ok && releasedOk));
}

export function overdraw(data) {
  const body = riskCheckBody(
    data.overdrawAccount.accountId,
    'AAPL',
    'BUY',
    1,
    OVERDRAW_AMOUNT,
    0
  );
  const res = directPost(BASE.risk + '/reserve', body, 'risk_reserve');
  if (res.status === 200) {
    overdrawSuccess.add(1);
  } else if (res.status === 409) {
    overdrawConflict.add(1);
  } else {
    unexpectedErrors.add(true);
  }
}

export function reads(data) {
  const account = pick(data.accounts);
  const res = directGet(
    BASE.risk + '/balances?account_id=' + account.accountId,
    'risk_balances'
  );
  const ok = check(res, { 'risk balances 200': (r) => r.status === 200 });
  unexpectedErrors.add(!ok);
}

let previousErrors = null;
let previousTs = 0;

export function poller() {
  const now = Date.now();
  const metrics = fetchMetrics(BASE.risk + '/metrics');
  if (metrics) {
    const lag = max(metrics, 'trading_risk_journal_lag_seconds');
    const length = max(metrics, 'trading_risk_journal_length');
    if (lag !== null) {
      promRiskJournalLag.add(lag);
    }
    if (length !== null) {
      promRiskJournalLength.add(length);
    }
    if (previousTs > 0) {
      const elapsed = (now - previousTs) / 1000;
      const errors = counterDelta(
        metrics,
        'trading_risk_journal_apply_errors_total',
        previousErrors
      );
      promRiskApplyErrorsRate.add(errors.delta / elapsed);
      previousErrors = errors.next;
    } else {
      previousErrors = counterDelta(
        metrics,
        'trading_risk_journal_apply_errors_total',
        null
      ).next;
    }
    previousTs = now;
  }
  sleep(1);
}

export function teardown(data) {
  try {
  const res = directGet(
    BASE.risk + '/balances?account_id=' + data.overdrawAccount.accountId,
    'risk_balances'
  );
  const balances = safeJson(res) || [];
  let cash = null;
  balances.forEach((b) => {
    if (b.asset === 'CASH') {
      cash = b;
    }
  });
  if (!cash) {
    throw new Error('risk overdraw invariant failed: no CASH balance returned');
  }
  const total = Number(cash.total);
  const available = Number(cash.available);
  const frozen = Number(cash.frozen);
  if (
    total !== OVERDRAW_BALANCE ||
    available !== OVERDRAW_BALANCE - EXPECTED_FROZEN ||
    frozen !== EXPECTED_FROZEN
  ) {
    throw new Error(
      'risk overdraw invariant failed: total=' +
        total +
        ' available=' +
        available +
        ' frozen=' +
        frozen +
        ' (expected ' +
        OVERDRAW_BALANCE +
        '/' +
        (OVERDRAW_BALANCE - EXPECTED_FROZEN) +
        '/' +
        EXPECTED_FROZEN +
        ')'
    );
  }
  console.log(
    'risk atomicity invariant passed: ' +
      OVERDRAW_VUS +
      ' concurrent reserves of ' +
      OVERDRAW_AMOUNT +
      ' against ' +
      OVERDRAW_BALANCE +
      ' left available=' +
      (OVERDRAW_BALANCE - EXPECTED_FROZEN) +
      ' frozen=' +
      frozen
  );
  invariantPassed.add(true);
  } catch (err) {
    invariantPassed.add(false);
    throw err;
  }
}

export const handleSummary = handleSummaryFor('risk-engine', (data) => ({
  http_rps: metricValue(data, 'http_reqs', 'rate'),
  check_p99_ms: metricValue(data, 'op_risk_check_ms', 'p(99)'),
  reserve_p99_ms: metricValue(data, 'op_risk_reserve_ms', 'p(99)'),
  overdraw_success: metricValue(data, 'overdraw_success_total', 'count'),
  overdraw_conflict: metricValue(data, 'overdraw_conflict_total', 'count'),
  journal_lag_p95_s: metricValue(data, 'prom_risk_journal_lag_s', 'p(95)'),
}));
