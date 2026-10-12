-- =============================================================================
-- Market Data service schema (TimescaleDB `market_data` database).
-- Owned exclusively by `market-data-service`.
--
--   ticks : append-only raw trade executions (time-series source of truth)
--
-- OHLCV candles are pre-aggregated in Redis by the service for the hot path and
-- can be rebuilt from `ticks` via time_bucket() for historical queries.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS ticks (
    trade_id         BIGINT NOT NULL,
    symbol           VARCHAR(24) NOT NULL,
    price            NUMERIC(30, 8) NOT NULL,
    quantity         NUMERIC(30, 8) NOT NULL,
    timestamp_ns     BIGINT NOT NULL,
    ts               TIMESTAMPTZ NOT NULL,
    maker_order_id   BIGINT NOT NULL DEFAULT 0,
    taker_order_id   BIGINT NOT NULL DEFAULT 0,
    maker_account_id BIGINT NOT NULL DEFAULT 0,
    taker_account_id BIGINT NOT NULL DEFAULT 0
);

SELECT create_hypertable('ticks', 'ts', if_not_exists => TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ticks_trade_ts ON ticks(trade_id, ts);
CREATE INDEX IF NOT EXISTS idx_ticks_symbol_ts ON ticks(symbol, ts DESC);
