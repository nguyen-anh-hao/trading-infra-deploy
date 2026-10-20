// Resting liquidity for scenarios that send IOC orders through the full
// gateway -> order -> matching -> settlement path.
//
// Without a book, an IOC buy has nothing to cross and the order path never
// reaches settlement. The seed uses synthetic accounts far away from the test
// account range so self-trade prevention cannot interfere.
import http from 'k6/http';
import { BASE, SYMBOLS, numberEnv } from './env.js';

const SEED_ACCOUNT_BASE = 5000000;

export function seedBook(depth, quantityPerOrder) {
  const levels = depth || numberEnv('SEED_DEPTH', 25);
  const quantity = quantityPerOrder || numberEnv('SEED_QTY', 2000);
  const requests = [];
  SYMBOLS.forEach((symbol, symbolIndex) => {
    for (let level = 0; level < levels; level++) {
      const bidAccount = SEED_ACCOUNT_BASE + symbolIndex * 1000 + level * 2;
      const askAccount = bidAccount + 1;
      const bid = {
        symbol: symbol,
        side: 'BUY',
        type: 'LIMIT',
        price: '99.00',
        quantity: String(quantity),
        time_in_force: 'GTC',
        client_order_id: 'seed-bid-' + symbol + '-' + level,
        account_id: bidAccount,
      };
      const ask = {
        symbol: symbol,
        side: 'SELL',
        type: 'LIMIT',
        price: '101.00',
        quantity: String(quantity),
        time_in_force: 'GTC',
        client_order_id: 'seed-ask-' + symbol + '-' + level,
        account_id: askAccount,
      };
      requests.push({
        method: 'POST',
        url: BASE.matching + '/orders',
        body: JSON.stringify(bid),
        params: {
          headers: { 'Content-Type': 'application/json' },
          tags: { operation: 'matching_place' },
        },
      });
      requests.push({
        method: 'POST',
        url: BASE.matching + '/orders',
        body: JSON.stringify(ask),
        params: {
          headers: { 'Content-Type': 'application/json' },
          tags: { operation: 'matching_place' },
        },
      });
    }
  });

  let accepted = 0;
  let total = 0;
  for (let offset = 0; offset < requests.length; offset += 50) {
    const responses = http.batch(requests.slice(offset, offset + 50));
    total += responses.length;
    responses.forEach((res) => {
      if (res.status !== 200) {
        return;
      }
      try {
        const body = res.json();
        if (body && body.accepted === true) {
          accepted++;
        }
      } catch (err) {
        // a 200 with a malformed body is not liquidity
      }
    });
  }
  if (accepted < total * 0.9) {
    throw new Error('book seed failed: only ' + accepted + '/' + total + ' orders accepted');
  }
}
