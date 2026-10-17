# Trading Infrastructure & Deployment (`trading-infra-deploy`)

> **Master Orchestration, GitOps Manifests, Observability Stack & Local Integration Hub** for the Trading System.

---

## 1. Primary Responsibility
This repository is the central operations hub managed by the **Tech Lead** and **Platform/SRE Engineers**. It defines how the distributed system is provisioned, containerized, monitored, and scaled across local machines, Staging, and Production Kubernetes clusters.

No application code lives here. Instead, it pulls pre-built container images from GitHub Container Registry (`ghcr.io/nguyen-anh-hao/*`).

---

## 2. Architecture Topology (System Context)

```mermaid
graph TD
    Client[Web UI / Bots] -->|HTTP / WS :8080| Gateway[api-gateway]
    Gateway -->|HTTP/gRPC :9002| Risk[risk-engine]
    Risk -->|Check OK :9001| Engine[matching-engine]
    Engine -->|Execution Event :8083| Settlement[clearing-settlement]
    Gateway -->|Voucher Discount :8084| Promo[promotion-service]

    Settlement --> Postgres[(PostgreSQL :5432)]
    Settlement -->|Outbox (CDC)| Connect[Debezium Connect]
    Connect -->|accounting.* Avro| Kafka[(Redpanda / Kafka)]
    Kafka --> SchemaReg[Schema Registry]
    Kafka -->|Avro| Acct[accounting-tax-service :8086]
    Risk --> Redis[(Redis :6379)]

    Gateway -.-> OTEL[otel-collector :4317]
    Risk -.-> OTEL
    Settlement -.-> OTEL
    OTEL --> Prometheus[Prometheus :9090]
    OTEL --> Jaeger[Jaeger UI :16686]
    Prometheus --> Grafana[Grafana :3000]
```

---

## 3. Quick Start (Run Full Ecosystem in 1 Command)

### Prerequisites
- Docker & Docker Compose v2+
- Make (optional, but recommended)

### 1-Click Launch
```bash
# 1. Create shared network
make net

# 2. Boot infrastructure (Postgres, Redis, pgAdmin, Redpanda, Schema Registry, Debezium Connect + accounting topics)
make infra-up

# 3. Boot telemetry (Prometheus, Grafana, Jaeger, OTel Collector)
make monitor-up

# 4. Pull and run all microservices from GHCR
make app-up
```

### Access Dashboards
| Service | URL | Default Credentials |
| :--- | :--- | :--- |
| **API Gateway** | `http://localhost:8080` | None |
| **Grafana Metrics** | `http://localhost:3000` | `admin` / `admin` |
| **Jaeger Traces** | `http://localhost:16686` | None |
| **Prometheus** | `http://localhost:9090` | None |
| **pgAdmin** | `http://localhost:5050` | `admin@exchange.internal` / `admin` |
| **Kafka Connect REST** | `http://localhost:18083` | None (host port `18083` avoids clashing with clearing-settlement on `8083`) |
| **Kafka UI** | `http://localhost:8090` | None (Redpanda + Schema Registry / Avro) |

> **Kafka / CDC note:** Kafka UI and Schema Registry only show data once an
> accounting event has actually been produced. The pipeline is
> `clearing-settlement` → `outbox` table → Debezium Connect → `accounting.*`
> topics → `accounting-tax-service`. `make infra-up` pre-creates all
> `accounting.*` (+ `.DLT`) topics and upserts the outbox connector on every
> boot. `clearing-settlement` must reach Schema Registry via the in-network
> address `http://schema-registry:8081`; otherwise Avro serialization fails and
> no outbox rows (and therefore no Kafka messages) are ever written.

---

## 4. Architecture Decision Records (ADRs)

To understand *why* architectural decisions were made, refer to:
- [`docs/adr/001-why-cpp-for-matching-engine.md`](docs/adr/001-why-cpp-for-matching-engine.md)
- [`docs/adr/002-why-protobuf-contract-first.md`](docs/adr/002-why-protobuf-contract-first.md)
- [`docs/adr/003-double-entry-accounting-principles.md`](docs/adr/003-double-entry-accounting-principles.md)

---

## 5. Engineering Roadmap (SRE, Platform & GitOps Optimization)

| Version | Phase | Infrastructure Target & SRE Problem |
| :--- | :--- | :--- |
| **v1.0.0** *(Current)* | **Docker Compose Baseline** | Unified local orchestrator using pre-built GHCR images. Full OpenTelemetry tracing pipeline. |
| **v1.1.0** | **GitOps & Ephemeral Environments** | Automate deployment via ArgoCD. Pull Request preview environments deployed dynamically into Kubernetes namespaces for zero-friction end-to-end PR validation. |
| **v1.2.0** | **High-Availability Message Backbone** | Deploy Redpanda / Apache Kafka cluster on K8s (using Strimzi operator). Implement automated PostgreSQL multi-AZ replication with PgBouncer connection pooling. |
| **v2.0.0** | **Bare-Metal NUMA Tuning & Chaos Engineering** | Implement Linux CPU-pinning (cgroups/isolcpus) and NUMA node allocation on K8s for Matching Engine pods to eliminate OS context-switch jitter. Chaos Mesh automated fault injection (simulating node crash, packet loss, disk latency spikes). |

