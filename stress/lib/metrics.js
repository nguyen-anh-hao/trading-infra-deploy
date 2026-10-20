// Central metric registry.
//
// k6's built-in http_req_* metrics aggregate every tag, so the report cannot
// read p99 for a single operation from them. Every operation therefore gets
// two dedicated metrics: op_<name>_ms (Trend) and cnt_<name>_total (Counter).
// The names are stable and consumed by scripts/k6_report.py.
import { Counter, Gauge, Rate, Trend } from 'k6/metrics';

export const OPERATIONS = [
  // gateway / gateway-backed reads
  'ticker',
  'book',
  'trades_tape',
  'ohlcv',
  'balances',
  'positions',
  'pnl',
  'buying_power',
  'fee_tiers',
  'leaderboard',
  'ledger',
  // order lifecycle (gateway or direct)
  'reference_price',
  'place_order',
  'modify_order',
  'cancel_order',
  'bulk_cancel',
  'open_orders',
  'order_history',
  'trades',
  // account/treasury
  'create_account',
  'create_api_key',
  'deposit',
  'withdraw',
  // direct service operations
  'settle',
  'settlement_ledger',
  'risk_check',
  'risk_reserve',
  'risk_release',
  'risk_balances',
  'risk_deposit',
  'matching_place',
  'matching_cancel',
  'matching_book',
  'matching_ticker',
  'accounting_summary',
  'accounting_counts',
  'promotion_fee_tiers',
  'promotion_leaderboard',
  'promotion_redeem',
  'promotion_faucet',
  // infrastructure
  'health',
  'metrics_scrape',
];

export const op = {};
export const cnt = {};
OPERATIONS.forEach((name) => {
  op[name] = new Trend('op_' + name + '_ms', true);
  cnt[name] = new Counter('cnt_' + name + '_total');
});

// Record the server-side latency (time to first byte) for one operation.
export function recordOp(name, res) {
  if (!res || !op[name]) {
    return;
  }
  const value = res.timings && Number.isFinite(res.timings.waiting) ? res.timings.waiting : 0;
  op[name].add(value, { operation: name });
  cnt[name].add(1, { operation: name });
}

export function countOp(name, value) {
  if (cnt[name]) {
    cnt[name].add(value === undefined ? 1 : value, { operation: name });
  }
}

// Expected outcomes in correctness scenarios are not application errors.
export const unexpectedErrors = new Rate('svc_unexpected_errors');

// Correctness / business metrics.
export const replaySameOrder = new Rate('replay_same_order');
export const idempotentReplays = new Counter('idempotent_replays_total');
export const duplicateConflicts = new Counter('duplicate_conflict_total');
export const settlementDuplicateNoops = new Counter('settlement_duplicate_noop_total');
export const invariantPassed = new Rate('invariant_passed');
export const ledgerBalanced = new Rate('ledger_balanced');
export const ledgerTradesChecked = new Counter('ledger_trades_checked_total');
export const tradesObserved = new Counter('trades_observed_total');
export const orderFillRatio = new Rate('order_fill_ratio');

// Risk atomicity.
export const overdrawSuccess = new Counter('overdraw_success_total');
export const overdrawConflict = new Counter('overdraw_conflict_total');

// Gateway security boundary.
export const gatewayFloodAllowed = new Rate('gateway_flood_allowed');
export const gatewayControlAllowed = new Rate('gateway_control_allowed');
export const gateway429 = new Counter('gateway_429_total');
export const gateway401 = new Counter('gateway_401_total');
export const gateway403 = new Counter('gateway_403_total');
export const gateway400 = new Counter('gateway_400_total');

// WebSocket.
export const wsMessages = new Counter('ws_messages_total');
export const wsHandshake = new Trend('ws_handshake_ms', true);
export const wsSnapshotOk = new Rate('ws_snapshot_ok');
export const wsSessionError = new Rate('ws_session_errors');
export const wsSessions = new Counter('ws_sessions_total');
export const wsReconnects = new Counter('ws_reconnects_total');
export const wsConnectionsLive = new Gauge('ws_connections_live');

// Accounting freshness.
export const accountingLag = new Trend('accounting_lag_ms', true);
export const accountingTimeouts = new Counter('accounting_freshness_timeout_total');

// Prometheus-poller trends (server-side truth, scraped from /metrics).
export const promMatchingP99 = new Trend('prom_matching_p99_ms', true);
export const promMatchingP999 = new Trend('prom_matching_p999_ms', true);
export const promMatchingTradesRate = new Trend('prom_matching_trades_per_s');
export const promMatchingErrorsRate = new Trend('prom_matching_errors_per_s');
export const promOrderOutboxAge = new Trend('prom_order_outbox_age_s');
export const promOrderOutboxPending = new Trend('prom_order_outbox_pending');
export const promOrderInflight = new Trend('prom_order_inflight');
export const promOrderUnknown = new Trend('prom_order_unknown');
export const promOrderTradesRate = new Trend('prom_order_trades_per_s');
export const promRiskJournalLag = new Trend('prom_risk_journal_lag_s');
export const promRiskJournalLength = new Trend('prom_risk_journal_length');
export const promRiskApplyErrorsRate = new Trend('prom_risk_apply_errors_per_s');
export const promSettlementOutboxAge = new Trend('prom_settlement_outbox_age_s');
export const promSettlementFailedRate = new Trend('prom_settlement_failed_per_s');
export const promSettlementSettledRate = new Trend('prom_settlement_settled_per_s');
export const promWsConnections = new Trend('prom_ws_connections');
export const promWsDroppedRate = new Trend('prom_ws_dropped_per_s');
export const promWsSentRate = new Trend('prom_ws_sent_per_s');
export const promMarketTicksRate = new Trend('prom_market_ticks_per_s');
export const promMarketDedupeRate = new Trend('prom_market_dedupe_per_s');
export const promAccountingErrorsRate = new Trend('prom_accounting_errors_per_s');
export const promPromotionErrorsRate = new Trend('prom_promotion_errors_per_s');
export const promotionAccepted = new Rate('promotion_redeem_accepted');
export const promotionRejected = new Counter('promotion_redeem_rejected_total');
