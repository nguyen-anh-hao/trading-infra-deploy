-- =============================================================================
-- Databases for order-service and risk-engine.
-- The settlement database/outbox remains owned by clearing-settlement.
-- This file runs only on a fresh PostgreSQL volume (docker-entrypoint-initdb).
-- =============================================================================

CREATE DATABASE orders OWNER settlement;
CREATE DATABASE risk OWNER settlement;

\connect orders

CREATE TABLE IF NOT EXISTS orders (
    order_id            BIGINT PRIMARY KEY,
    account_id          BIGINT NOT NULL,
    client_order_id     TEXT,
    symbol              TEXT NOT NULL,
    side                TEXT NOT NULL,
    type                TEXT NOT NULL,
    time_in_force       TEXT NOT NULL,
    price               NUMERIC(30,8) NOT NULL DEFAULT 0,
    quantity            NUMERIC(30,8) NOT NULL,
    executed_quantity   NUMERIC(30,8) NOT NULL DEFAULT 0,
    leaves_quantity     NUMERIC(30,8) NOT NULL DEFAULT 0,
    status              TEXT NOT NULL,
    reject_reason       TEXT,
    version             BIGINT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_client_order
    ON orders(account_id, client_order_id) WHERE client_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_account_status
    ON orders(account_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_idempotency (
    account_id          BIGINT NOT NULL,
    client_order_id     TEXT NOT NULL,
    status              TEXT NOT NULL,
    order_id            BIGINT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, client_order_id)
);

CREATE TABLE IF NOT EXISTS order_fills (
    account_id          BIGINT NOT NULL,
    trade_id            BIGINT NOT NULL,
    order_id            BIGINT NOT NULL,
    counterparty_order  BIGINT,
    symbol              TEXT NOT NULL,
    price               NUMERIC(30,8) NOT NULL,
    quantity            NUMERIC(30,8) NOT NULL,
    fee                 NUMERIC(30,8) NOT NULL DEFAULT 0,
    role                TEXT NOT NULL,
    executed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, trade_id)
);
CREATE INDEX IF NOT EXISTS idx_order_fills_order ON order_fills(order_id);

CREATE TABLE IF NOT EXISTS order_reservations (
    order_id            BIGINT PRIMARY KEY,
    account_id          BIGINT NOT NULL,
    symbol              TEXT NOT NULL,
    side                TEXT NOT NULL,
    price               NUMERIC(30,8) NOT NULL,
    fee_rate            NUMERIC(30,8) NOT NULL,
    quantity            NUMERIC(30,8) NOT NULL,
    status              TEXT NOT NULL DEFAULT 'PENDING',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type      TEXT NOT NULL,
    aggregate_id        TEXT NOT NULL,
    event_type          TEXT NOT NULL,
    payload             BYTEA NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at        TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'PENDING',
    retry_count         INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_order_outbox_pending ON outbox(status, created_at);

\connect risk

CREATE TABLE IF NOT EXISTS risk_balances (
    account_id          BIGINT NOT NULL,
    asset               TEXT NOT NULL,
    total               NUMERIC(30,8) NOT NULL DEFAULT 0,
    available           NUMERIC(30,8) NOT NULL DEFAULT 0,
    frozen              NUMERIC(30,8) NOT NULL DEFAULT 0,
    version             BIGINT NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, asset)
);

CREATE TABLE IF NOT EXISTS risk_reservations (
    order_id            BIGINT PRIMARY KEY,
    account_id          BIGINT NOT NULL,
    asset               TEXT NOT NULL,
    amount              NUMERIC(30,8) NOT NULL,
    status              TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_events (
    event_id            UUID PRIMARY KEY,
    event_type          TEXT NOT NULL,
    payload             JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type      TEXT NOT NULL,
    aggregate_id        TEXT NOT NULL,
    event_type          TEXT NOT NULL,
    payload             BYTEA NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at        TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'PENDING',
    retry_count         INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_risk_outbox_pending ON outbox(status, created_at);

-- Initial demo balances (same values as the old Redis seed).
INSERT INTO risk_balances(account_id, asset, total, available, frozen)
VALUES
    (1, 'CASH',       1000000, 1000000, 0),
    (1, 'STOCK:AAPL',    1000,    1000, 0),
    (1, 'STOCK:MSFT',     500,     500, 0),
    (2, 'CASH',       1000000, 1000000, 0),
    (2, 'STOCK:AAPL',     500,     500, 0),
    (2, 'STOCK:TSLA',     300,     300, 0)
ON CONFLICT (account_id, asset) DO NOTHING;
