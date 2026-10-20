# Baseline catalog

This file is generated from [`docs/baselines.yaml`](baselines.yaml) by
`scripts/render_baselines.py`. Do not edit the catalog sections by hand.

## How to use the baselines in Grafana

- Open **Trading — Baseline Scorecard** for a PASS/FAIL table with the
  current value, target, severity and a link back to this page.
- Open **Trading — Service Detail** and pick a service: panels carry the
  same thresholds and dashed baseline lines.
- The **Baseline legend** at the top of each service dashboard is generated
  from the `legend: true` entries in `baselines.yaml`.

## The three tiers

| Tier | Examples | Hardware independent? | Use as a dev gate? |
|---|---|---|---|
| Invariant | outbox age, UNKNOWN orders, WS drops, Kafka lag | Yes (correctness) | Yes |
| Ratio | 5xx %, CPU throttle %, memory/limit, GC CPU %, p99/p50 | Yes (normalised) | Yes |
| Absolute | p99 latency, throughput per vCPU | No (needs the same CPU quota) | Only with quota parity |

### Reference numbers used above

| Reference | Number | Source |
|---|---|---|
| 99.5% availability | 3.6 hours/month (18 seconds/hour) | Google SRE availability table |
| 99.9% availability | 43.2 minutes/month (3.6 seconds/hour) | Google SRE availability table |
| Fast burn alert | 14.4x over 1h, 6x over 6h, 1x over 3d | Google SRE Workbook ch.5 |
| HIGH_FAST latency bucket | p90 100ms, p99 200ms at 99.9% | Google SRE Workbook Table 5-10 |
| Matching reference ceiling | 6M orders/s on one thread (LMAX) | Martin Fowler, The LMAX Architecture |
| Fluid interaction | ~100ms response | The Tail at Scale |

## Catalog

### Availability

#### <a id="http_5xx_ratio"></a>HTTP 5xx ratio

- **Baseline:** `<= 0.005 percentunit`
- **Severity:** `critical`
- **Expression:** `service:http_error_ratio5m`
- **Source:** <https://sre.google/sre-book/availability-table/>

5xx ratio <= 0.5%, the error budget of a 99.5% availability SLO.

#### <a id="http_5xx_ratio_burn_fast"></a>Fast error-budget burn (1h)

- **Baseline:** `<= 0.072 percentunit`
- **Severity:** `critical`
- **Expression:** `service:http_error_ratio1h`
- **Source:** <https://sre.google/workbook/alerting-on-slos/>

14.4x burn of a 0.5% budget; both 5m and 1h windows should agree.

#### <a id="scrape_up"></a>Scrape target up

- **Baseline:** `>= 1 short`
- **Severity:** `critical`
- **Expression:** `up{job=~"api-gateway|order-service|risk-engine|market-data-service|matching-engine|clearing-settlement|promotion-service|accounting-tax-service"}`
- **Source:** <https://prometheus.io/docs/practices/alerting/>

Every application scrape target must be reachable.

#### <a id="scrape_duration"></a>Scrape duration

- **Baseline:** `<= 2.5 s`
- **Severity:** `warning`
- **Expression:** `scrape_duration_seconds{job=~"api-gateway|order-service|risk-engine|market-data-service|matching-engine|clearing-settlement|promotion-service|accounting-tax-service"}`
- **Source:** <https://prometheus.io/docs/practices/alerting/>

A 5s scrape interval should finish well under half the interval.

### Latency and tail

#### <a id="order_path_p99"></a>Order path p99

- **Baseline:** `<= 0.5 s`
- **Severity:** `critical`
- **Expression:** `histogram_quantile(0.99, sum by (service, le) (rate(http_request_duration_seconds_bucket{service="order-service",path=~"/orders.*"}[5m])))`
- **Source:** <https://sre.google/workbook/alerting-on-slos/>

p99 order path <= 500ms; the SRE HIGH_FAST bucket targets 200ms.

#### <a id="http_p99"></a>HTTP p99

- **Baseline:** `<= 1 s`
- **Severity:** `warning`
- **Expression:** `service:http_request_duration_seconds:p99`
- **Source:** <https://sre.google/workbook/alerting-on-slos/>

Generic HTTP p99 alarm threshold; per-service SLOs are tighter.

#### <a id="matching_p99"></a>Matching engine p99

- **Baseline:** `<= 0.005 s`
- **Severity:** `critical`
- **Expression:** `histogram_quantile(0.99, sum by (service, le) (rate(trading_matching_latency_seconds_bucket[5m])))`
- **Source:** <https://martinfowler.com/articles/lmax.html>

In-memory matching p99 <= 5ms; LMAX demonstrates 6M orders/s on one thread as the reference ceiling.

#### <a id="matching_p999"></a>Matching engine p999

- **Baseline:** `<= 0.01 s`
- **Severity:** `warning`
- **Expression:** `histogram_quantile(0.999, sum by (service, le) (rate(trading_matching_latency_seconds_bucket[5m])))`
- **Source:** <https://research.google/pubs/pub40801/>

Tail events dominate at scale; p999 should stay within 2x of the p99 target.

#### <a id="tail_ratio_p99_p50"></a>HTTP p99/p50 tail ratio

- **Baseline:** `<= 5 short`
- **Severity:** `warning`
- **Expression:** `service:http_request_duration_seconds:p99 / clamp_min(service:http_request_duration_seconds:p50, 0.0001)`
- **Source:** <https://research.google/pubs/pub40801/>

Hardware-independent tail amplification guard; a rising ratio indicates queueing or a slow dependency.

#### <a id="ws_send_p99"></a>Tick -> WebSocket p99

- **Baseline:** `<= 0.1 s`
- **Severity:** `warning`
- **Expression:** `histogram_quantile(0.99, sum by (service, le) (rate(trading_market_ws_send_duration_seconds_bucket[5m])))`
- **Source:** <https://research.google/pubs/pub40801/>

Sub-100ms updates feel fluid; measure server-side enqueue-to-write duration.

### Saturation and runtime

#### <a id="cpu_throttled_ratio"></a>CFS throttled periods ratio

- **Baseline:** `<= 0.01 percentunit`
- **Severity:** `warning`
- **Expression:** `service:cpu:throttled_ratio5m`
- **Source:** <https://www.kernel.org/doc/html/latest/scheduler/sched-bwc.html>

Any sustained CPU throttling means the quota, not the workload, is the bottleneck.

#### <a id="cpu_usage_ratio"></a>CPU usage / quota

- **Baseline:** `<= 0.7 percentunit`
- **Severity:** `warning`
- **Expression:** `service:cpu:usage_ratio5m`
- **Source:** <https://sre.google/sre-book/handling-overload/>

Leave headroom so the service can absorb 2x-10x traffic before degrading.

#### <a id="memory_ratio"></a>Memory working set / limit

- **Baseline:** `<= 0.8 percentunit`
- **Severity:** `warning`
- **Expression:** `service:memory:working_set_ratio`
- **Source:** <https://go.dev/doc/gc-guide>

Keep the live heap below 80% of the limit to avoid OOM and GC death spirals.

#### <a id="go_gc_cpu_fraction"></a>Go GC CPU fraction

- **Baseline:** `<= 0.05 percentunit`
- **Severity:** `warning`
- **Expression:** `go_memstats_gc_cpu_fraction`
- **Source:** <https://go.dev/doc/gc-guide>

GC CPU above 5% is a strong signal of allocation pressure; profile mallocgc/gcAssistAlloc above 15%/5%.

#### <a id="jvm_gc_pause_p99"></a>JVM GC pause p99

- **Baseline:** `<= 0.2 s`
- **Severity:** `warning`
- **Expression:** `histogram_quantile(0.99, sum by (service, le) (rate(jvm_gc_pause_seconds_bucket[5m])))`
- **Source:** <https://docs.oracle.com/en/java/javase/21/gctuning/>

G1 default max pause target is 200ms; sustained pauses above it hurt p99 request latency.

#### <a id="hikari_pending"></a>Hikari pending connections

- **Baseline:** `<= 0 short`
- **Severity:** `warning`
- **Expression:** `hikaricp_connections_pending`
- **Source:** <https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing>

Sustained pending acquisition means the pool is too small or the database is slow.

#### <a id="postgres_blocked_locks"></a>PostgreSQL blocked locks

- **Baseline:** `<= 0 short`
- **Severity:** `critical`
- **Expression:** `max by (service) (pg_blocked_locks)`
- **Source:** <https://www.postgresql.org/docs/current/monitoring-stats.html>

Blocked locks are a direct saturation/correctness symptom.

#### <a id="postgres_connections"></a>PostgreSQL connections

- **Baseline:** `<= 80 short`
- **Severity:** `warning`
- **Expression:** `max by (service) (pg_connections)`
- **Source:** <https://www.postgresql.org/docs/current/runtime-config-connection.html>

PostgreSQL max_connections defaults to 100; stay below 80% and size pools with cores*2+spindles.

#### <a id="redis_memory_ratio"></a>Redis memory ratio

- **Baseline:** `<= 0.8 percentunit`
- **Severity:** `warning`
- **Expression:** `redis_memory_used_bytes / clamp_min(redis_memory_max_bytes, 1)`
- **Source:** <https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/>

Eviction or OOM starts once Redis approaches its maxmemory limit.

#### <a id="redis_evictions"></a>Redis evictions

- **Baseline:** `<= 0 short`
- **Severity:** `critical`
- **Expression:** `increase(redis_evicted_keys_total[5m])`
- **Source:** <https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/>

Evictions silently destroy shared state; any eviction is an incident.

### Data pipeline

#### <a id="outbox_oldest_age"></a>Outbox oldest age

- **Baseline:** `<= 60 s`
- **Severity:** `critical`
- **Expression:** `max by (service) (trading_outbox_oldest_age_seconds)`
- **Source:** <https://microservices.io/patterns/data/transactional-outbox.html>

Operational diagnostic only: outbox rows are not marked published and have no retention job yet, so this gauge counts all history and is not a k6/CV claim.

#### <a id="outbox_pending"></a>Outbox pending rows

- **Baseline:** `<= 100 short`
- **Severity:** `warning`
- **Expression:** `max by (service) (trading_outbox_pending)`
- **Source:** <https://microservices.io/patterns/data/transactional-outbox.html>

Operational diagnostic only until the outbox has an acknowledged/cleanup path; it is not a k6/CV claim.

#### <a id="risk_journal_lag"></a>Risk journal lag

- **Baseline:** `<= 30 s`
- **Severity:** `critical`
- **Expression:** `max by (service) (trading_risk_journal_lag_seconds)`
- **Source:** <https://redis.io/docs/latest/develop/data-types/streams/>

Risk state must follow the order stream within 30s.

#### <a id="risk_journal_length"></a>Risk journal length

- **Baseline:** `<= 10000 short`
- **Severity:** `warning`
- **Expression:** `max by (service) (trading_risk_journal_length)`
- **Source:** <https://redis.io/docs/latest/develop/data-types/streams/>

An unbounded stream length indicates the consumer is not keeping up.

#### <a id="risk_journal_apply_errors"></a>Risk journal apply errors

- **Baseline:** `<= 0 short`
- **Severity:** `critical`
- **Expression:** `increase(trading_risk_journal_apply_errors_total[5m])`
- **Source:** <https://sre.google/sre-book/monitoring-distributed-systems/>

Any failed apply is a correctness event, not a performance warning.

#### <a id="kafka_consumer_lag"></a>Kafka consumer lag

- **Baseline:** `<= 1000 short`
- **Severity:** `warning`
- **Expression:** `max by (service, consumergroup, topic) (kafka_consumergroup_lag)`
- **Source:** <https://kafka.apache.org/documentation/#monitoring>

A stable lag is fine; a growing lag or drain time > 30s is not.

#### <a id="nats_slow_consumers"></a>NATS slow consumers

- **Baseline:** `<= 0 short`
- **Severity:** `critical`
- **Expression:** `max by (service) (nats_varz_slow_consumers)`
- **Source:** <https://docs.nats.io/running-a-nats-service/configuration/slow_consumers>

A slow consumer gets disconnected once the server's write deadline expires.

#### <a id="nats_pending_bytes"></a>NATS pending bytes

- **Baseline:** `<= 10485760 bytes`
- **Severity:** `warning`
- **Expression:** `max by (service) (nats_varz_pending_bytes)`
- **Source:** <https://docs.nats.io/running-a-nats-service/configuration/slow_consumers>

Alert at 10MB against the 64MB default max_pending buffer.

#### <a id="ws_dropped"></a>WebSocket dropped frames

- **Baseline:** `<= 0 short`
- **Severity:** `warning`
- **Expression:** `increase(trading_ws_dropped_total[5m]) or (0 * trading_ws_connections)`
- **Source:** <https://docs.nats.io/running-a-nats-service/configuration/slow_consumers>

Dropping market data is a user-visible correctness failure for a priceboard.

#### <a id="ticks_dedupe_ratio"></a>Market dedupe ratio

- **Baseline:** `<= 0.01 percentunit`
- **Severity:** `warning`
- **Expression:** `rate(trading_market_dedupe_total[5m]) / clamp_min(rate(trading_market_ticks_ingested_total[5m]), 1e-9)`
- **Source:** <https://docs.nats.io/running-a-nats-service/configuration/slow_consumers>

A high duplicate ratio means redelivery or a broken idempotency key.

### Business correctness

#### <a id="order_unknown_state"></a>Orders in UNKNOWN state

- **Baseline:** `<= 0 short`
- **Severity:** `critical`
- **Expression:** `max by (service) (trading_orders_current{status="UNKNOWN"})`
- **Source:** <https://sre.google/sre-book/monitoring-distributed-systems/>

UNKNOWN means the order outcome cannot be proven; operators must investigate.

#### <a id="settlement_failures"></a>Settlement failures

- **Baseline:** `<= 0 short`
- **Severity:** `critical`
- **Expression:** `increase(trading_settlements_total{status="FAILED"}[5m])`
- **Source:** <https://sre.google/sre-book/monitoring-distributed-systems/>

A failed settlement is a money-correctness event.

#### <a id="accounting_errors"></a>Accounting consumer errors

- **Baseline:** `<= 0 short`
- **Severity:** `critical`
- **Expression:** `increase(trading_accounting_errors_total[5m])`
- **Source:** <https://kafka.apache.org/documentation/#monitoring>

Accounting must consume every trade/ledger event exactly once.

#### <a id="promotion_errors"></a>Promotion errors

- **Baseline:** `<= 0 short`
- **Severity:** `warning`
- **Expression:** `increase(trading_promotion_errors_total[5m])`
- **Source:** <https://sre.google/sre-book/monitoring-distributed-systems/>

Voucher/faucet errors should be visible before support tickets arrive.

## Dev gate

1. Pin CPU/memory limits in `deployments/docker/docker-compose.local.yml`
   so absolute latency is comparable between machines.
2. Run `make baseline` (k6). The thresholds fail on error ratio, order p99
   and the ticker p99; server-side invariants are shown on the scorecard.
3. Treat any failing critical baseline as a release blocker. A dev machine
   that fails an invariant/ratio baseline will also fail in production.

## Sources

The source URL is attached to every baseline above. Overview references:

- Google SRE: four golden signals, SLO/availability table, overload, cascading failures
- Google SRE Workbook: multi-window multi-burn-rate alerting, latency buckets
- Brendan Gregg: USE method; Grafana: RED method
- Prometheus: histograms, alerting practices
- The Tail at Scale (Dean & Barroso), LMAX architecture
- HikariCP, PostgreSQL, Redis, Kafka, NATS and Linux CFS documentation
- Go GC guide and Oracle JVM GC tuning guide
