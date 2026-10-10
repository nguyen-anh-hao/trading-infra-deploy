-- =============================================================================
-- System-of-record schema, owned exclusively by the `clearing-settlement`
-- service (PostgreSQL database `settlement`).
--
--   ledger_entries : append-only immutable double-entry journal (source of truth)
--   balances       : materialized read-model derived from ledger_entries
--   trades         : executed fills persisted on settlement
--
-- All monetary values use NUMERIC (fixed precision) to avoid floating point
-- rounding errors.
-- =============================================================================

CREATE TABLE IF NOT EXISTS balances (
    account_id BIGINT NOT NULL,
    asset       VARCHAR(32) NOT NULL,
    total       NUMERIC(30, 8) NOT NULL DEFAULT 0,
    available   NUMERIC(30, 8) NOT NULL DEFAULT 0,
    frozen      NUMERIC(30, 8) NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, asset)
);

CREATE TABLE IF NOT EXISTS trades (
    trade_id         BIGINT PRIMARY KEY,
    symbol           VARCHAR(24) NOT NULL,
    price            NUMERIC(30, 8) NOT NULL,
    quantity         NUMERIC(30, 8) NOT NULL,
    fee              NUMERIC(30, 8) NOT NULL DEFAULT 0,
    maker_order_id   BIGINT NOT NULL,
    taker_order_id   BIGINT NOT NULL,
    maker_account_id BIGINT NOT NULL,
    taker_account_id BIGINT NOT NULL,
    executed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);

-- Append-only immutable journal (double-entry ledger).
CREATE TABLE IF NOT EXISTS ledger_entries (
    entry_id     BIGINT PRIMARY KEY,
    account_id   BIGINT NOT NULL,
    asset        VARCHAR(32) NOT NULL,
    debit        NUMERIC(30, 8) NOT NULL DEFAULT 0,
    credit       NUMERIC(30, 8) NOT NULL DEFAULT 0,
    reference    VARCHAR(64),
    reason       VARCHAR(32),
    timestamp_ns BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id);
