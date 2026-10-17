# ADR 004 — Stateless application tier, shared Redis state

## Status
Accepted

## Context
Several services originally kept business state in process memory. With more
than one replica (and with rolling restarts) this produced split-brain behavior:
orders placed on one replica were invisible on another, reservations could be
lost, and WebSocket clients on different replicas saw different candles.

## Decision
All **application services** are stateless: they keep only disposable caches and
open connections in memory. Durable/shared business state lives in a shared
store:

| Service | Shared state |
| :--- | :--- |
| `api-gateway` | Redis: API keys, account-id sequence, rate-limit buckets |
| `order-service` | Redis: orders, trades, reservations, idempotency keys, fee-rate cache, trade-event spool |
| `risk-engine` | Redis: balances/reservations, mutated by atomic Lua scripts |
| `market-data-service` | Redis: tape + OHLCV candles; Redis Pub/Sub for WS fan-out; TimescaleDB for raw ticks |
| `promotion-service` | Redis: vouchers, fee tiers, leaderboard |
| `accounting-tax-service` | Redis: accounting aggregates (fixed-point integers scaled by 1e8) |
| `clearing-settlement` | PostgreSQL: ledger, balances, trades, positions |

Services now fail fast when their required shared store is unreachable instead
of silently falling back to process-local state. Redis runs with AOF enabled so
a Redis restart does not erase the shared state.

## Intentional exception
`matching-engine` is **stateful by design**. The live limit order book is the
authoritative state of the exchange and must be a single deterministic writer.
It runs with `replicas: 1`; high availability is achieved with active/passive
snapshot + replay, not stateless horizontal scaling. Externalising the book on
every match would destroy the latency guarantee and introduce ordering races.

## Consequences
- Any replica can serve any request; rolling restarts are safe.
- Redis becomes a critical dependency and must be durable, monitored and backed
  up (AOF + PVC in Kubernetes).
- Caches (auth key cache, metrics registries, WebSocket connections) remain
  process-local but are disposable and never authoritative.
