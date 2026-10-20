// Direct clearing-settlement load (port 8083).
//
// Load: unique trade_id settlement at a fixed arrival rate.
// Correctness: 1,000 sequential replays and 50 concurrent duplicates of the
// same trade_id must produce exactly one set of ledger entries.
//
// teardown() reads /ledger for the test accounts plus the treasury account (0)
// and verifies that every trade in this run produced exactly 5 balanced legs
// (buyer cash, buyer stock, seller cash, seller stock, fee).
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { BASE, DURATION, numberEnv } from './lib/env.js';
import { checkTargets } from './lib/preflight.js';
import { syntheticAccounts } from './lib/accounts.js';
import { directGet, directPost } from './lib/gw.js';
import { safeJson, settleBody } from './lib/payloads.js';
import { counterDeltaWhere, fetchMetrics, max } from './lib/prom.js';
import {
  invariantPassed,
  ledgerBalanced,
  ledgerTradesChecked,
  promSettlementFailedRate,
  promSettlementOutboxAge,
  promSettlementSettledRate,
  unexpectedErrors,
} from './lib/metrics.js';
import { handleSummaryFor, metricValue } from './lib/summary.js';

const SETTLE_RATE = numberEnv('SETTLE_RATE', 20);
const REPLAYS = numberEnv('REPLAYS', 1000);
const DUPLICATES = numberEnv('DUPLICATES', 50);
const ACCOUNTS = numberEnv('ACCOUNTS', 64);
const ACCOUNT_BASE = numberEnv('ACCOUNT_BASE', 6000000 + (Date.now() % 100000));
const BASE_TRADE_ID = numberEnv('BASE_TRADE_ID', Date.now() * 1000);
const REPLAY_ID = BASE_TRADE_ID + 900000;
const DUP_ID = BASE_TRADE_ID + 900001;
const RUN_SPAN = 2000000;

function vusFor(rate, serviceMs) {
  return Math.max(5, Math.ceil((rate * serviceMs) / 1000));
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  scenarios: {
    settle: {
      executor: 'constant-arrival-rate',
      exec: 'settle',
      rate: SETTLE_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(SETTLE_RATE, 200),
      maxVUs: vusFor(SETTLE_RATE, 800),
      gracefulStop: '10s',
    },
    replay_seq: {
      executor: 'shared-iterations',
      exec: 'replaySequential',
      vus: 1,
      iterations: REPLAYS,
      startTime: '1s',
      maxDuration: '5m',
      gracefulStop: '5s',
    },
    replay_concurrent: {
      executor: 'per-vu-iterations',
      exec: 'replayConcurrent',
      vus: DUPLICATES,
      iterations: 1,
      startTime: '3s',
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
    'http_req_failed{scenario:settle}': ['rate<0.01'],
    op_settle_ms: ['p(99)<500'],
    ledger_balanced: ['rate==1'],
    ledger_trades_checked_total: ['count>0'],
    invariant_passed: ['rate==1'],
    checks: ['rate>0.99'],
    svc_unexpected_errors: ['rate<0.01'],
    prom_settlement_failed_per_s: ['max<1'],
  },
};

export function setup() {
  checkTargets(['settlement']);
  const accounts = syntheticAccounts(ACCOUNT_BASE, ACCOUNTS);
  return {
    accounts: accounts,
    baseTradeId: BASE_TRADE_ID,
    replayId: REPLAY_ID,
    duplicateId: DUP_ID,
  };
}

function tradeFor(data, tradeId, index, buyerFee, sellerFee) {
  const buyer = data.accounts[(index * 2) % data.accounts.length];
  const seller = data.accounts[(index * 2 + 1) % data.accounts.length];
  const price = 50 + (index % 1000) / 10;
  const quantity = 1 + (index % 10);
  return {
    body: settleBody({
      tradeId: tradeId,
      symbol: 'AAPL',
      price: price,
      quantity: quantity,
      buyerFee: buyerFee,
      sellerFee: sellerFee,
      makerOrderId: index * 2,
      takerOrderId: index * 2 + 1,
      makerAccountId: seller.accountId,
      takerAccountId: buyer.accountId,
      buyerAccountId: buyer.accountId,
      sellerAccountId: seller.accountId,
    }),
    buyer: buyer,
    seller: seller,
  };
}



export function settle(data) {
  const iteration = exec.scenario.iterationInTest;
  const trade = tradeFor(data, data.baseTradeId + iteration, iteration, 0.1, 0.15);
  const res = directPost(BASE.settlement + '/settle', trade.body, 'settle');
  const parsed = safeJson(res);
  const ok = check(res, {
    'settle 200': (r) => r.status === 200,
    'settle success': () => !!(parsed && parsed.success === true),
  });
  unexpectedErrors.add(!ok);
}

export function replaySequential(data) {
  const trade = tradeFor(data, data.replayId, 7, 0.1, 0.15);
  const res = directPost(BASE.settlement + '/settle', trade.body, 'settle');
  const parsed = safeJson(res);
  const ok = check(res, {
    'sequential replay 200': (r) => r.status === 200,
    'sequential replay success': () => !!(parsed && parsed.success === true),
  });
  unexpectedErrors.add(!ok);
}

export function replayConcurrent(data) {
  const trade = tradeFor(data, data.duplicateId, 11, 0.1, 0.15);
  const res = directPost(BASE.settlement + '/settle', trade.body, 'settle');
  const parsed = safeJson(res);
  const ok = check(res, {
    'concurrent replay 200': (r) => r.status === 200,
    'concurrent replay success': () => !!(parsed && parsed.success === true),
  });
  unexpectedErrors.add(!ok);
}

let previousSettled = null;
let previousFailed = null;
let previousTs = 0;

export function poller() {
  const now = Date.now();
  const metrics = fetchMetrics(BASE.settlement + '/actuator/prometheus');
  if (metrics) {
    const outboxAge = max(metrics, 'trading_outbox_oldest_age_seconds');
    if (outboxAge !== null) {
      promSettlementOutboxAge.add(outboxAge);
    }
    if (previousTs > 0) {
      const elapsed = (now - previousTs) / 1000;
      const settled = counterDeltaWhere(
        metrics,
        'trading_settlements_total',
        'status="SETTLED"',
        previousSettled
      );
      const failed = counterDeltaWhere(
        metrics,
        'trading_settlements_total',
        'status="FAILED"',
        previousFailed
      );
      promSettlementSettledRate.add(settled.delta / elapsed);
      promSettlementFailedRate.add(failed.delta / elapsed);
      previousSettled = settled.next;
      previousFailed = failed.next;
    } else {
      previousSettled = counterDeltaWhere(
        metrics,
        'trading_settlements_total',
        'status="SETTLED"',
        null
      ).next;
      previousFailed = counterDeltaWhere(
        metrics,
        'trading_settlements_total',
        'status="FAILED"',
        null
      ).next;
    }
    previousTs = now;
  }
  sleep(1);
}

function readLedger(accountID) {
  const res = directGet(
    BASE.settlement + '/ledger?account_id=' + accountID,
    'settlement_ledger'
  );
  if (res.status !== 200) {
    throw new Error('ledger read failed for account ' + accountID + ': HTTP ' + res.status);
  }
  return safeJson(res) || [];
}

export function teardown(data) {
  try {
  const accountIDs = {};
  data.accounts.forEach((account) => {
    accountIDs[account.accountId] = true;
  });
  accountIDs[0] = true; // treasury / fee account

  const references = {};
  Object.keys(accountIDs).forEach((rawId) => {
    const entries = readLedger(Number(rawId));
    entries.forEach((entry) => {
      const ref = entry.reference;
      if (!references[ref]) {
        references[ref] = { count: 0, assets: {} };
      }
      refs_add(references[ref], entry);
    });
  });

  const problems = [];
  let checked = 0;
  Object.keys(references).forEach((ref) => {
    const match = /^trade:(\d+)$/.exec(ref);
    if (!match) {
      return;
    }
    const tradeId = Number(match[1]);
    if (tradeId < data.baseTradeId || tradeId > data.baseTradeId + RUN_SPAN) {
      return;
    }
    checked++;
    const group = references[ref];
    if (group.count !== 5) {
      problems.push(ref + ': expected 5 legs, found ' + group.count);
      return;
    }
    Object.keys(group.assets).forEach((asset) => {
      const sums = group.assets[asset];
      if (Math.abs(sums.debit - sums.credit) > 1e-6) {
        problems.push(
          ref +
            ' asset ' +
            asset +
            ': debit ' +
            sums.debit +
            ' != credit ' +
            sums.credit
        );
      }
    });
  });

  ledgerTradesChecked.add(checked);
  ledgerBalanced.add(problems.length === 0);
  if (checked === 0) {
    throw new Error('settlement invariant failed: no ledger entries found for this run');
  }
  if (problems.length > 0) {
    throw new Error(
      'settlement invariant failed on ' +
        problems.length +
        ' checks; first problems: ' +
        problems.slice(0, 10).join('; ')
    );
  }
  console.log(
    'settlement invariant passed: ' +
      checked +
      ' trades, 5 legs each, debits == credits per asset; ' +
      REPLAYS +
      ' sequential + ' +
      DUPLICATES +
      ' concurrent replays collapsed to one booking'
  );
  invariantPassed.add(true);
  } catch (err) {
    invariantPassed.add(false);
    throw err;
  }
}

function refs_add(group, entry) {
  group.count++;
  const asset = entry.asset;
  if (!group.assets[asset]) {
    group.assets[asset] = { debit: 0, credit: 0 };
  }
  group.assets[asset].debit += Number(entry.debit);
  group.assets[asset].credit += Number(entry.credit);
}

export const handleSummary = handleSummaryFor('settlement', (data) => ({
  settle_rate: metricValue(data, 'cnt_settle_total', 'rate'),
  settle_p99_ms: metricValue(data, 'op_settle_ms', 'p(99)'),
  http_failed_ratio: metricValue(data, 'http_req_failed', 'rate'),
  invoices_checked: metricValue(data, 'ledger_trades_checked_total', 'count'),
  ledger_balanced: metricValue(data, 'ledger_balanced', 'rate'),
}));
