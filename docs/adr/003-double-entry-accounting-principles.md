# ADR 003: Double-Entry Bookkeeping Principles

## Context
In financial exchanges, balance discrepancies, race conditions, or uncoordinated database updates can lead to money creation out of thin air or catastrophic audit failures.

## Decision
All money and security movements in `clearing-settlement` adhere strictly to **Double-Entry General Ledger Accounting**.

## Rationale
1. **Mathematical Balance Guarantee:** Every single transaction produces an equal amount of debits and credits:
   $$\sum \text{Debits} = \sum \text{Credits}$$
2. **Immutable Audit Trail:** Balances are never modified in-place using `UPDATE accounts SET balance = balance + X`. Instead, every change is recorded as an immutable append-only ledger entry row. Account balances are views or materialized states derived from the ledger.
3. **Idempotency:** Each trade fill has a unique `trade_id`. Re-processing an existing `trade_id` is a guaranteed no-op, preventing double-crediting during network retries.

## Consequences
- Requires additional database write throughput for the append-only ledger.
- Requires batching strategies to handle high-volume trade bursts.
