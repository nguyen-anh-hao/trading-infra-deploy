// Promotion service: fee tiers, leaderboard, voucher redemption and faucet.
//
// This service is deliberately off the critical trading path. The interesting
// result is not only latency: voucher redemption is not idempotent, so the
// accepted/attempted ratio is reported as a finding instead of being hidden.
import { check, sleep } from 'k6';
import { BASE, DURATION, numberEnv } from './lib/env.js';
import { checkTargets } from './lib/preflight.js';
import { directGet, directPost } from './lib/gw.js';
import { safeJson } from './lib/payloads.js';
import { counterDelta, fetchMetrics } from './lib/prom.js';
import {
  promPromotionErrorsRate,
  promotionAccepted,
  promotionRejected,
  unexpectedErrors,
} from './lib/metrics.js';
import { Rate } from 'k6/metrics';

const feeTierOk = new Rate('promotion_fee_tier_ok');
const leaderboardOk = new Rate('promotion_leaderboard_ok');
const redeemOk = new Rate('promotion_redeem_ok');
const faucetOk = new Rate('promotion_faucet_ok');
import { handleSummaryFor, metricValue } from './lib/summary.js';

const READ_RATE = numberEnv('READ_RATE', 40);
const REDEEM_RATE = numberEnv('REDEEM_RATE', 10);
const FAUCET_RATE = numberEnv('FAUCET_RATE', 5);
const CODES = ['WELCOME50', 'FEE50'];

function vusFor(rate, serviceMs) {
  return Math.max(5, Math.ceil((rate * serviceMs) / 1000));
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  scenarios: {
    reads: {
      executor: 'constant-arrival-rate',
      exec: 'reads',
      rate: READ_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(READ_RATE, 100),
      maxVUs: vusFor(READ_RATE, 500),
      gracefulStop: '5s',
    },
    redeem: {
      executor: 'constant-arrival-rate',
      exec: 'redeem',
      rate: REDEEM_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(REDEEM_RATE, 100),
      maxVUs: vusFor(REDEEM_RATE, 400),
      gracefulStop: '5s',
    },
    faucet: {
      executor: 'constant-arrival-rate',
      exec: 'faucet',
      rate: FAUCET_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: vusFor(FAUCET_RATE, 100),
      maxVUs: vusFor(FAUCET_RATE, 300),
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
    'http_req_failed{scenario:reads}': ['rate<0.01'],
    'http_req_failed{scenario:redeem}': ['rate<0.01'],
    'http_req_failed{scenario:faucet}': ['rate<0.01'],
    op_promotion_fee_tiers_ms: ['p(99)<200'],
    op_promotion_leaderboard_ms: ['p(99)<200'],
    op_promotion_redeem_ms: ['p(99)<200'],
    prom_promotion_errors_per_s: ['max<1'],
    checks: ['rate>0.99'],
    svc_unexpected_errors: ['rate<0.01'],
  },
};

export function setup() {
  checkTargets(['promotion']);
  return {};
}

export function reads() {
  const accountId = 1 + Math.floor(Math.random() * 100);
  if (Math.random() < 0.5) {
    const res = directGet(
      BASE.promotion + '/fee-tiers?account_id=' + accountId,
      'promotion_fee_tiers'
    );
    const ok = check(res, {
      'fee tiers 200': (r) => r.status === 200,
      'fee tiers has maker rate': (r) => {
        try {
          return r.json().maker_fee !== undefined;
        } catch (err) {
          return false;
        }
      },
    });
    feeTierOk.add(ok);
    unexpectedErrors.add(!ok);
  } else {
    const res = directGet(BASE.promotion + '/leaderboard', 'promotion_leaderboard');
    const ok = check(res, { 'leaderboard 200': (r) => r.status === 200 });
    leaderboardOk.add(ok);
    unexpectedErrors.add(!ok);
  }
}

export function redeem() {
  const valid = Math.random() < 0.8;
  const code = valid
    ? CODES[Math.floor(Math.random() * CODES.length)]
    : 'INVALID-' + Math.floor(Math.random() * 100000);
  const body = JSON.stringify({
    account_id: 1 + Math.floor(Math.random() * 100),
    voucher_code: code,
  });
  const res = directPost(BASE.promotion + '/redeem-voucher', body, 'promotion_redeem');
  const parsed = safeJson(res);
  const ok = check(res, {
    'redeem 200/201': (r) => r.status === 200 || r.status === 201,
    'redeem has success flag': () => !!(parsed && typeof parsed.success === 'boolean'),
  });
  if (parsed && parsed.success === true) {
    promotionAccepted.add(1);
  } else {
    promotionAccepted.add(0);
    promotionRejected.add(1);
  }
  redeemOk.add(ok);
  unexpectedErrors.add(!ok);
}

export function faucet() {
  const body = JSON.stringify({
    account_id: 1 + Math.floor(Math.random() * 100),
    amount: '100000',
  });
  const res = directPost(BASE.promotion + '/faucet', body, 'promotion_faucet');
  const ok = check(res, {
    'faucet 200/201': (r) => r.status === 200 || r.status === 201,
  });
  faucetOk.add(ok);
  unexpectedErrors.add(!ok);
}

let previousErrors = null;
let previousTs = 0;

export function poller() {
  const now = Date.now();
  const metrics = fetchMetrics(BASE.promotion + '/metrics');
  if (metrics) {
    if (previousTs > 0) {
      const elapsed = (now - previousTs) / 1000;
      const errors = counterDelta(metrics, 'trading_promotion_errors_total', previousErrors);
      promPromotionErrorsRate.add(errors.delta / elapsed);
      previousErrors = errors.next;
    } else {
      previousErrors = counterDelta(metrics, 'trading_promotion_errors_total', null).next;
    }
    previousTs = now;
  }
  sleep(1);
}

export default function () {
  reads();
}

export const handleSummary = handleSummaryFor('promotion', (data) => ({
  http_rps: metricValue(data, 'http_reqs', 'rate'),
  fee_tiers_p99_ms: metricValue(data, 'op_promotion_fee_tiers_ms', 'p(99)'),
  leaderboard_p99_ms: metricValue(data, 'op_promotion_leaderboard_ms', 'p(99)'),
  redeem_p99_ms: metricValue(data, 'op_promotion_redeem_ms', 'p(99)'),
  redeem_rate: metricValue(data, 'cnt_promotion_redeem_total', 'rate'),
  redeem_accepted_ratio: metricValue(data, 'promotion_redeem_accepted', 'rate'),
  redeem_rejected: metricValue(data, 'promotion_redeem_rejected_total', 'count'),
  fee_tier_ok: metricValue(data, 'promotion_fee_tier_ok', 'rate'),
  leaderboard_ok: metricValue(data, 'promotion_leaderboard_ok', 'rate'),
  redeem_ok: metricValue(data, 'promotion_redeem_ok', 'rate'),
  faucet_ok: metricValue(data, 'promotion_faucet_ok', 'rate'),
}));
