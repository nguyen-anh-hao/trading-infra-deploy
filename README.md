# trading-infra-deploy

## Purpose

Runs the platform: Docker Compose stacks, Kubernetes manifests, observability configuration, load tests and the operational knowledge needed to bring the exchange up and diagnose it. It contains no application code. It is the only repository that is allowed to describe the whole system, because every other repository documents only its own domain.

## Domain knowledge

The system is a stateless application tier around a single stateful matching core. Redis is shared state rather than a cache, PostgreSQL holds the settlement, order and risk databases, TimescaleDB stores raw ticks, NATS carries executed trades and Kafka carries outbox events relayed by Debezium. The matching engine is the intentional exception: it is in memory, single-writer and cannot be scaled horizontally without splitting the book.

Startup order matters. The network is created first, then the data and messaging backbone, then observability, then the application services. A fresh PostgreSQL volume is required for the initialization SQL to create the order and risk databases and their schemas; reusing an old volume without applying that SQL leaves services unable to start.

Most application services fail fast when a required shared store is unreachable, which is deliberate. Silent fallback to process-local state would split orders, balances or candles across replicas.

Settlement is the exception: it can boot without its database but cannot book anything until the database returns. Redis runs with append-only persistence, and the Kubernetes manifests give it a persistent volume for the same reason.

The outbox pattern is the backbone of asynchronous consistency. Settlement, order and risk each write an outbox row in the same database transaction as their state change, and Debezium publishes the Avro payload to Kafka under the record's fully qualified name. The accounting service consumes those topics, while market data consumes trade events directly from NATS through a durable consumer.

Observability is part of the definition of done. Metrics flow to Prometheus, traces to Jaeger and Tempo, logs to Loki through the collector, and profiles to Pyroscope. Grafana Drilldown works only with Tempo, and service graphs are produced by Tempo rather than by the in-memory Jaeger instance, which is why both trace stores exist.

## Decisions and consequences

**Stateless application tier with shared Redis.** Any replica can serve any request and rolling restarts are safe. The cost is that Redis becomes a critical dependency that must be durable, monitored and backed up.

**Single-writer matching engine.** Determinism and latency win over horizontal scale, so the engine runs with one replica. High availability must come from snapshot and replay, not from replica count.

**Transactional outbox with CDC.** Database state and events commit together, removing dual-write failures. The cost is an outbox table per producer, three Debezium connectors and a schema registry on the critical path.

**Materialized read models.** Order, risk, market-data and accounting views are built for reads rather than recomputed per request. This gives predictable latency at the price of reconciliation logic and bounded staleness.

**Compose baseline with Kubernetes manifests.** Compose is the fast local path, while Kubernetes covers namespace, config, Postgres, Redis, services and autoscaling. The cost is two deployment descriptions that can drift.

**Docker-first observability bundle.** Prometheus, Grafana, Jaeger, Tempo, Loki, Alloy and Pyroscope ship together so every service is observable by default. The cost is a heavy local footprint and more moving parts to keep healthy.

## Operations and known limits

`make up` starts everything from local sources, while `make up-prod` pulls published images; `make infra-up`, `make monitor-up` and `make app-local` allow staged startup. `make down` preserves volumes, `make down-v` wipes them, and `make reset` also removes the shared network. After a reset, a fresh start is required before any service can be trusted.

The usual failure signatures are worth knowing. A gateway request returning 502 usually means the order path cannot reach risk, matching or settlement. A silent WebSocket means the trade spool, NATS consumer or Redis Pub/Sub path is broken.

Empty accounting means the settlement outbox, the Debezium connector or the consumer is stuck. Authentication failures are 401 for an unknown key and 403 for a missing permission, and an internal 401 means the internal token does not match.

Debezium has a sharp edge: the outbox event timestamp field must not point at the created-at column, because the column is a zoned timestamp rather than the required 64-bit integer, and the connector task fails without publishing anything. The Connect REST port is published as 18083 so it does not collide with the settlement service on 8083. Schema registry subjects are record names, not topic-value names.

The observability stack has its own traps. Jaeger all-in-one does not compute dependency links, so the service map panel is empty there; the real service graph lives in Tempo. Grafana Drilldown shows no data without a Tempo data source.

Alerting covers availability, latency, Redis, Kafka, NATS and PostgreSQL health, outbox and journal backlog, WebSocket backpressure and host capacity.

Load tests use k6 with explicit service-level objectives: order HTTP p99 under five hundred milliseconds, failed requests under one percent, matching p99 under five milliseconds, meaningful WebSocket fan-out, outbox age under a minute and risk journal lag under thirty seconds. `make stress-order` and `make stress-ws` run the two scenarios. The environment example file is not authoritative and has drifted before, so compose files and config maps are the source of truth for variables.

## Future direction

Business: the platform roadmap is about reliability and scale rather than new products, because product behavior lives in the services.

Technical: GitOps with preview environments, a highly available Kafka and PostgreSQL backbone, PgBouncer, Redis Sentinel or Cluster, and read replicas for settlement and market data. CPU pinning and NUMA placement for the matching engine, eBPF rate limiting and chaos testing are the low-latency phase.

Boundaries: the WebSocket edge is the first candidate to split into its own deployment, followed by read-only portfolio and reporting services. Kafka on Kubernetes is intended to move from local Redpanda to the Strimzi operator in production.

