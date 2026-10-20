// Account provisioning and balance seeding.
//
// Two modes:
//   * through the gateway (POST /accounts + POST /deposit) for end-to-end
//     scenarios;
//   * direct risk-engine deposits for tests that call internal services
//     directly. Internal services trust X-Account-ID, so synthetic ids are
//     valid and avoid the gateway on purpose.
import http from 'k6/http';
import { check } from 'k6';
import { BASE, SYMBOLS } from './env.js';
import { apiHeaders } from './auth.js';

export function createAccounts(count, tag) {
  const bodyFor = (i) =>
    JSON.stringify({
      name: 'k6-' + tag + '-' + i,
      email: 'k6-' + tag + '-' + i + '@example.test',
    });
  const requests = [];
  for (let i = 0; i < count; i++) {
    requests.push({
      method: 'POST',
      url: BASE.gateway + '/accounts',
      body: bodyFor(i),
      params: {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        tags: { operation: 'create_account' },
      },
    });
  }
  const responses = http.batch(requests);
  const accounts = [];
  responses.forEach((res, i) => {
    const ok = check(res, { 'setup account created': (r) => r.status === 200 });
    if (ok) {
      const body = res.json();
      accounts.push({
        idx: i,
        accountId: body.account_id,
        apiKey: body.api_key,
        secret: body.secret_key,
      });
    }
  });
  if (accounts.length === 0) {
    throw new Error('could not create any account through ' + BASE.gateway + '/accounts');
  }
  return accounts;
}

export function syntheticAccounts(start, count) {
  const accounts = [];
  for (let i = 0; i < count; i++) {
    accounts.push({ idx: i, accountId: start + i, apiKey: '', secret: '' });
  }
  return accounts;
}

// seedGateway gives every account enough cash and stock for IOC orders that
// cross the book. Deposits go through the gateway, so risk and settlement both
// see them (this is what a real funded account looks like).
export function seedGateway(accounts, cash, stockPerSymbol) {
  const requests = [];
  accounts.forEach((account) => {
    const cashBody = JSON.stringify({ asset: 'CASH', amount: String(cash) });
    requests.push({
      method: 'POST',
      url: BASE.gateway + '/deposit',
      body: cashBody,
      params: {
        headers: apiHeaders('POST', '/deposit', cashBody, account),
        tags: { operation: 'deposit' },
      },
    });
    SYMBOLS.forEach((symbol) => {
      const body = JSON.stringify({ asset: 'STOCK:' + symbol, amount: String(stockPerSymbol) });
      requests.push({
        method: 'POST',
        url: BASE.gateway + '/deposit',
        body: body,
        params: {
          headers: apiHeaders('POST', '/deposit', body, account),
          tags: { operation: 'deposit' },
        },
      });
    });
  });
  const responses = http.batch(requests);
  let failed = 0;
  responses.forEach((res) => {
    if (res.status !== 200) {
      failed++;
    }
  });
  if (failed > 0) {
    throw new Error(failed + '/' + responses.length + ' gateway deposits failed during setup');
  }
}

// depositRisk seeds balances directly in the risk engine. Callers must only
// use this for direct-service scenarios, never to fake a gateway result.
export function depositRisk(accounts, asset, amount) {
  const requests = accounts.map((account) => ({
    method: 'POST',
    url: BASE.risk + '/deposit',
    body: JSON.stringify({ account_id: account.accountId, asset: asset, amount: String(amount) }),
    params: {
      headers: { 'Content-Type': 'application/json' },
      tags: { operation: 'risk_deposit' },
    },
  }));
  const responses = http.batch(requests);
  let failed = 0;
  responses.forEach((res) => {
    if (res.status !== 200) {
      failed++;
    }
  });
  if (failed > 0) {
    throw new Error(failed + '/' + responses.length + ' risk deposits failed during setup');
  }
}

export function balancesOf(accountID) {
  return http.get(BASE.risk + '/balances?account_id=' + accountID, {
    tags: { operation: 'risk_balances' },
  });
}
