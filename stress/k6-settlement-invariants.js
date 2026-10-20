// Property-style settlement invariant test.
//
// Runs a fixed number of randomized trades (default 10,000) with positive
// buyer/seller fees, then reads the journal through /ledger for every test
// account plus the treasury account (0) and verifies:
//   * every trade_id has exactly one booking and 5 ledger legs;
//   * for every (trade, asset), total debits == total credits.
//
// This is the k6 equivalent of the double-entry property test: a failure
// throws from teardown(), which makes the k6 process exit non-zero.
import { check } from 'k6';
import exec from 'k6/execution';
import { BASE, numberEnv } from './lib/env.js';
import { checkTargets } from './lib/preflight.js';
import { syntheticAccounts } from './lib/accounts.js';
import { directGet, directPost } from './lib/gw.js';
import { safeJson, settleBody } from './lib/payloads.js';
import {
  invariantPassed,
  ledgerBalanced,
  ledgerTradesChecked,
  unexpectedErrors,
} from './lib/metrics.js';
import { handleSummaryFor, metricValue } from './lib/summary.js';

const TRADES = numberEnv('TRADES', 10000);
const VUS = numberEnv('VUS', 32);
const ACCOUNTS = numberEnv('ACCOUNTS', 16);
const ACCOUNT_BASE = numberEnv('ACCOUNT_BASE', 6500000 + (Date.now() % 100000));
const BASE_TRADE_ID = numberEnv('BASE_TRADE_ID', Date.now() * 1000 + 100000);

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  scenarios: {
    properties: {
      executor: 'shared-iterations',
      exec: 'randomTrade',
      vus: VUS,
      iterations: TRADES,
      maxDuration: '15m',
      gracefulStop: '10s',
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.001'],
    op_settle_ms: ['p(99)<1000'],
    ledger_balanced: ['rate==1'],
    ledger_trades_checked_total: ['count>0'],
    invariant_passed: ['rate==1'],
    checks: ['rate>0.999'],
    svc_unexpected_errors: ['rate<0.001'],
  },
};

export function setup() {
  checkTargets(['settlement']);
  return {
    accounts: syntheticAccounts(ACCOUNT_BASE, ACCOUNTS),
    baseTradeId: BASE_TRADE_ID,
  };
}

export function randomTrade(data) {
  const index = exec.scenario.iterationInTest;
  const buyer = data.accounts[(index * 2) % data.accounts.length];
  const seller = data.accounts[(index * 2 + 1) % data.accounts.length];
  const price = 10 + Math.floor(Math.random() * 40000) / 100;
  const quantity = 1 + Math.floor(Math.random() * 100);
  const notional = price * quantity;
  const buyerFee = Math.max(0.01, Math.round(notional * 0.001 * 100) / 100);
  const sellerFee = Math.max(0.01, Math.round(notional * 0.0015 * 100) / 100);

  const body = settleBody({
    tradeId: data.baseTradeId + index,
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
  });

  const res = directPost(BASE.settlement + '/settle', body, 'settle');
  const parsed = safeJson(res);
  const ok = check(res, {
    'property settle 200': (r) => r.status === 200,
    'property settle success': () => !!(parsed && parsed.success === true),
  });
  unexpectedErrors.add(!ok);
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

function addEntry(references, entry) {
  const ref = entry.reference;
  if (!references[ref]) {
    references[ref] = { count: 0, assets: {} };
  }
  const group = references[ref];
  group.count++;
  if (!group.assets[entry.asset]) {
    group.assets[entry.asset] = { debit: 0, credit: 0 };
  }
  group.assets[entry.asset].debit += Number(entry.debit);
  group.assets[entry.asset].credit += Number(entry.credit);
}



export function teardown(data) {
  try {
  const references = {};
  data.accounts.forEach((account) => {
    readLedger(account.accountId).forEach((entry) => addEntry(references, entry));
  });
  readLedger(0).forEach((entry) => addEntry(references, entry));

  const problems = [];
  let checked = 0;
  Object.keys(references).forEach((ref) => {
    const match = /^trade:(\d+)$/.exec(ref);
    if (!match) {
      return;
    }
    const tradeId = Number(match[1]);
    if (tradeId < data.baseTradeId || tradeId >= data.baseTradeId + TRADES) {
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
          ref + ' asset ' + asset + ': debit ' + sums.debit + ' != credit ' + sums.credit
        );
      }
    });
  });

  ledgerTradesChecked.add(checked);
  ledgerBalanced.add(problems.length === 0);
  if (checked !== TRADES) {
    problems.push('expected ' + TRADES + ' trades in the journal, found ' + checked);
  }
  if (problems.length > 0) {
    throw new Error(
      'property test failed: ' + problems.slice(0, 10).join('; ')
    );
  }
  console.log(
    'property test passed: ' +
      checked +
      ' randomized trades, 5 balanced legs each, debits == credits per asset'
  );
  invariantPassed.add(true);
  } catch (err) {
    invariantPassed.add(false);
    throw err;
  }
}

export const handleSummary = handleSummaryFor('settlement-invariants', (data) => ({
  trades_checked: metricValue(data, 'ledger_trades_checked_total', 'count'),
  ledger_balanced: metricValue(data, 'ledger_balanced', 'rate'),
  settle_p99_ms: metricValue(data, 'op_settle_ms', 'p(99)'),
  http_failed_ratio: metricValue(data, 'http_req_failed', 'rate'),
}));
