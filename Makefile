SHELL := /bin/bash

# WSL often has Docker Engine with the standalone `docker-compose` binary but no
# `docker compose` CLI plugin. Prefer the plugin, fall back to the standalone.
COMPOSE ?= $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo "docker-compose")
PYTHON ?= $(shell command -v python3 >/dev/null 2>&1 && echo python3 || echo python)
K6 ?= k6
RUN_ID ?= $(shell date -u +%Y%m%dT%H%M%SZ)
PROFILE ?= load
GIT_SHA ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
STRESS_ENV ?= -e RUN_ID=$(RUN_ID) -e PROFILE=$(PROFILE) -e GIT_SHA=$(GIT_SHA) -e GATEWAY=http://localhost:8080

.PHONY: help net infra-up monitor-up app-pull app-up app-local up up-prod down down-v reset k8s-deploy k8s-down logs-app ps stress-order stress-ws check baseline-render baseline-check baseline stress-verify stress-up stress-wait stress-reset stress-build stress-up-ratelimit stress-baseline stress-gateway stress-order-service stress-order-flow stress-matching stress-risk stress-settlement stress-invariants stress-accounting stress-market-data stress-promotion stress-ratelimit stress-all stress-report stress-report-single

help:
	@echo "======================================================================="
	@echo "  Trading System Infrastructure Orchestration (trading-infra-deploy)  "
	@echo "======================================================================="
	@echo "  make up / app-local - Start everything using LOCAL source code & build"
	@echo "  make up-prod        - Start everything using GHCR images (Production mode)"
	@echo "  make down           - Stop all containers (preserves data volumes)"
	@echo "  make down-v         - Stop and wipe all persistent data volumes"
	@echo "  make reset          - Complete teardown and clean network"
	@echo ""
	@echo "  make infra-up       - Boot DB, Cache & Event Backbone (PostgreSQL, Redis, Redpanda, Connect)"
	@echo "  make monitor-up     - Boot Observability (Prometheus, Grafana, Jaeger, Loki, Kafka UI)"
	@echo "  make app-up         - Pull & run microservices from GHCR"
	@echo ""
	@echo "  make logs-app       - Follow logs for microservices (local or prod)"
	@echo "  make ps             - View status of all active containers"
	@echo "  make stress-verify  - k6 inspect every stress script"
	@echo "  make stress-up      - Reset-safe start: infra + app with INFO logging, wait for health"
	@echo "  make stress-build   - Rebuild local service images (legacy builder; run after code changes)"
	@echo "  make stress-wait    - Wait for all services and connectors to be ready"
	@echo "  make stress-reset   - DESTRUCTIVE: wipe volumes, network and all data"
	@echo "  make stress-all     - Run every scenario (3 runs per scenario recommended)"
	@echo "  make stress-baseline - Gateway SLO gate (order path)"
	@echo "  make stress-gateway - Gateway surface, auth negatives and optional rate limit"
	@echo "  make stress-order-flow - End-to-end lifecycle + idempotency through the gateway"
	@echo "  make stress-order-service - Direct order-service saga and outbox"
	@echo "  make stress-matching - Direct matching engine (server-side p99/p999)"
	@echo "  make stress-risk    - Direct risk engine + overdraw atomicity"
	@echo "  make stress-settlement - Direct settlement throughput + replay"
	@echo "  make stress-invariants - 10,000-trade double-entry property test"
	@echo "  make stress-accounting - Accounting reads + settlement-to-aggregate freshness"
	@echo "  make stress-market-data - REST + WebSocket fan-out + trade generator"
	@echo "  make stress-promotion - Fee tiers, leaderboard, vouchers, faucet"
	@echo "  make stress-ratelimit - 50 req/s/client token-bucket scenario"
	@echo "  make stress-report  - Render stress/results/cv-metrics.md + cv-bullets.md"
	@echo "  make baseline-render - Regenerate Prometheus rules + Grafana baseline dashboards"
	@echo "  make baseline-check - Fail if generated baseline artifacts are stale"
	@echo "  make check          - Validate compose files, rules, dashboards and kustomize output"
	@echo "======================================================================="

# Shared docker network for inter-container communication
net:
	@docker network inspect trading-net >/dev/null 2>&1 || docker network create trading-net

# 1. Core Data Infrastructure
infra-up: net
	$(COMPOSE) -f deployments/docker/docker-compose.infra.yml up -d

# 2. Observability & Telemetry
monitor-up: net
	$(COMPOSE) -f deployments/observability/docker-compose.monitor.yml up -d

# 3. Microservices Application Stack (GHCR)
app-pull:
	$(COMPOSE) -f deployments/docker/docker-compose.app.yml pull

app-up: net app-pull
	$(COMPOSE) -f deployments/docker/docker-compose.app.yml up -d

# 4. Microservices Application Stack (Local Build)
app-local: net
	$(COMPOSE) -f deployments/docker/docker-compose.local.yml up -d --build

# 5. Master Commands
up: infra-up monitor-up app-local
	@echo ""
	@echo ">>> Trading System (LOCAL SOURCE mode) is LIVE! <<<"
	@echo "  - API Gateway:    http://localhost:8080"
	@echo "  - Grafana:        http://localhost:3000 (admin / admin)"
	@echo "  - Jaeger UI:      http://localhost:16686"
	@echo "  - Prometheus:     http://localhost:9090"
	@echo "  - Alertmanager:   http://localhost:9093"
	@echo "  - Kafka UI:       http://localhost:8090"
	@echo "  - Kafka Connect:  http://localhost:18083"
	@echo "  - pgAdmin:        http://localhost:5050 (admin@example.com / admin)"
	@echo ""

up-prod: infra-up monitor-up app-up
	@echo ""
	@echo ">>> Trading System (GHCR PRODUCTION mode) is LIVE! <<<"
	@echo "  - API Gateway:    http://localhost:8080"
	@echo "  - Grafana:        http://localhost:3000 (admin / admin)"
	@echo "  - Jaeger UI:      http://localhost:16686"
	@echo "  - Prometheus:     http://localhost:9090"
	@echo "  - Alertmanager:   http://localhost:9093"
	@echo "  - Kafka UI:       http://localhost:8090"
	@echo "  - Kafka Connect:  http://localhost:18083"
	@echo "  - pgAdmin:        http://localhost:5050 (admin@example.com / admin)"
	@echo ""

# 6. Teardown & Maintenance
down:
	$(COMPOSE) -f deployments/docker/docker-compose.local.yml down --remove-orphans 2>/dev/null || true
	$(COMPOSE) -f deployments/docker/docker-compose.app.yml down --remove-orphans 2>/dev/null || true
	$(COMPOSE) -f deployments/observability/docker-compose.monitor.yml down --remove-orphans 2>/dev/null || true
	$(COMPOSE) -f deployments/docker/docker-compose.infra.yml down --remove-orphans 2>/dev/null || true

down-v:
	$(COMPOSE) -f deployments/docker/docker-compose.local.yml down -v --remove-orphans 2>/dev/null || true
	$(COMPOSE) -f deployments/docker/docker-compose.app.yml down -v --remove-orphans 2>/dev/null || true
	$(COMPOSE) -f deployments/observability/docker-compose.monitor.yml down -v --remove-orphans 2>/dev/null || true
	$(COMPOSE) -f deployments/docker/docker-compose.infra.yml down -v --remove-orphans 2>/dev/null || true

reset: down-v
	docker network rm trading-net 2>/dev/null || true

logs-app:
	@if $(COMPOSE) -f deployments/docker/docker-compose.local.yml ps --status running | grep -q "Up"; then \
		$(COMPOSE) -f deployments/docker/docker-compose.local.yml logs -f; \
	else \
		$(COMPOSE) -f deployments/docker/docker-compose.app.yml logs -f; \
	fi

ps:
	$(COMPOSE) -f deployments/docker/docker-compose.infra.yml ps
	$(COMPOSE) -f deployments/observability/docker-compose.monitor.yml ps
	$(COMPOSE) -f deployments/docker/docker-compose.app.yml ps
	$(COMPOSE) -f deployments/docker/docker-compose.local.yml ps

stress-verify:
	@for f in stress/k6-*.js; do \
		"$(K6)" inspect "$$f" >/dev/null || exit 1; \
	done
	@echo "k6 scripts OK"

stress-up: net infra-up
	$(COMPOSE) -f deployments/docker/docker-compose.local.yml \
		-f deployments/docker/docker-compose.stress.yml up -d
	$(MAKE) stress-wait

# Docker Desktop on WSL can have a broken buildx symlink; the legacy builder is
# reliable for this repository's Dockerfiles. Run this after changing service code.
stress-build:
	DOCKER_BUILDKIT=0 docker build -t matching-engine:local ../matching-engine
	DOCKER_BUILDKIT=0 docker build -t risk-engine:local ../risk-engine
	DOCKER_BUILDKIT=0 docker build -t clearing-settlement:local ../clearing-settlement
	DOCKER_BUILDKIT=0 docker build -t promotion-service:local ../promotion-service
	DOCKER_BUILDKIT=0 docker build -t market-data-service:local ../market-data-service
	DOCKER_BUILDKIT=0 docker build -t order-service:local ../order-service
	DOCKER_BUILDKIT=0 docker build -t api-gateway:local ../api-gateway
	DOCKER_BUILDKIT=0 docker build -t accounting-tax-service:local ../accounting-tax-service

stress-wait:
	bash scripts/wait_for_stack.sh

stress-reset:
	@echo "WARNING: wiping all local volumes (outbox, journal, Kafka, Postgres, Redis)."
	$(MAKE) reset

stress-up-ratelimit: net
	$(COMPOSE) -f deployments/docker/docker-compose.local.yml \
		-f deployments/docker/docker-compose.stress.yml \
		-f deployments/docker/docker-compose.stress-ratelimit.yml up -d api-gateway
	$(MAKE) stress-wait
	@$(COMPOSE) -f deployments/docker/docker-compose.local.yml \
		-f deployments/docker/docker-compose.stress.yml \
		-f deployments/docker/docker-compose.stress-ratelimit.yml \
		exec -T api-gateway env | grep -q '^RATE_LIMIT_PER_SEC=50$$' \
		|| (echo "gateway does not have RATE_LIMIT_PER_SEC=50; refusing to run the limiter test"; exit 1)

stress-baseline:
	"$(K6)" run $(STRESS_ENV) stress/k6-baseline.js

stress-gateway:
	"$(K6)" run $(STRESS_ENV) stress/k6-gateway.js

stress-order-flow:
	"$(K6)" run $(STRESS_ENV) stress/k6-order-flow.js

stress-order-service:
	"$(K6)" run $(STRESS_ENV) -e REPLAYS=1000 -e DUPLICATES=50 stress/k6-order-service.js

stress-matching:
	"$(K6)" run $(STRESS_ENV) stress/k6-matching-engine.js

stress-risk:
	"$(K6)" run $(STRESS_ENV) stress/k6-risk-engine.js

stress-settlement:
	"$(K6)" run $(STRESS_ENV) -e REPLAYS=1000 -e DUPLICATES=50 stress/k6-settlement.js

stress-invariants:
	"$(K6)" run $(STRESS_ENV) -e TRADES=10000 stress/k6-settlement-invariants.js

stress-accounting:
	"$(K6)" run $(STRESS_ENV) stress/k6-accounting.js

stress-market-data:
	"$(K6)" run $(STRESS_ENV) -e WS_CLIENTS=50 stress/k6-market-data.js

stress-promotion:
	"$(K6)" run $(STRESS_ENV) stress/k6-promotion.js

stress-ratelimit: stress-up-ratelimit
	"$(K6)" run $(STRESS_ENV) -e PROFILE=ratelimit -e RATE_LIMIT=true \
		-e RATE_LIMIT_PER_SEC=50 -e FLOOD_CLIENTS=4 stress/k6-gateway.js

stress-all: stress-verify stress-baseline stress-gateway stress-order-flow \
	stress-order-service stress-matching stress-risk stress-settlement \
	stress-invariants stress-accounting stress-market-data stress-ws stress-promotion
	@echo "All stress scenarios finished. Run 'make stress-report'."
	@echo "The rate-limit profile needs the throttled stack: make stress-up-ratelimit && make stress-ratelimit"

stress-report:
	$(PYTHON) scripts/k6_report.py --results stress/results \
		--templates stress/cv_templates.yaml

stress-report-single:
	$(PYTHON) scripts/k6_report.py --results stress/results \
		--templates stress/cv_templates.yaml --allow-single

# Legacy aliases kept so existing runbooks keep working.
stress-order: stress-order-flow
stress-ws:
	"$(K6)" run $(STRESS_ENV) stress/k6-ws-priceboard.js

baseline-render:
	$(PYTHON) scripts/render_baselines.py

baseline-check:
	$(PYTHON) scripts/render_baselines.py --check

baseline: stress-baseline

# 6b. Local validation (no containers are started)
check:
	$(COMPOSE) -f deployments/docker/docker-compose.infra.yml config -q
	$(COMPOSE) -f deployments/docker/docker-compose.app.yml config -q
	$(COMPOSE) -f deployments/docker/docker-compose.local.yml config -q
	$(COMPOSE) -f deployments/docker/docker-compose.local.yml \
		-f deployments/docker/docker-compose.stress.yml config -q
	$(COMPOSE) -f deployments/docker/docker-compose.local.yml \
		-f deployments/docker/docker-compose.stress.yml \
		-f deployments/docker/docker-compose.stress-ratelimit.yml config -q
	$(COMPOSE) -f deployments/observability/docker-compose.monitor.yml config -q
	$(PYTHON) scripts/render_baselines.py --check
	@for f in deployments/observability/grafana/dashboards/*.json; do \
		$(PYTHON) -m json.tool "$$f" >/dev/null || exit 1; \
	done
	@if command -v promtool >/dev/null 2>&1; then \
		promtool check rules \
			deployments/observability/prometheus/recording_rules.yml \
			deployments/observability/prometheus/recording_rules_baselines.yml \
			deployments/observability/prometheus/alert_rules.yml; \
	else \
		echo "promtool not installed; skipping rule validation"; \
	fi
	@if command -v kubectl >/dev/null 2>&1 && kubectl version --client >/dev/null 2>&1; then \
		kubectl kustomize deployments/k8s >/dev/null; \
	else \
		echo "kubectl unavailable; skipping kustomize validation"; \
	fi
	@if command -v "$(K6)" >/dev/null 2>&1; then \
		for f in stress/k6-*.js; do \
			"$(K6)" inspect "$$f" >/dev/null || exit 1; \
		done; \
	else \
		echo "k6 not installed; skipping stress script validation"; \
	fi

# 7. Kubernetes Cluster Deployment
k8s-deploy:
	kubectl apply -f deployments/k8s/namespace.yaml
	kubectl create configmap postgres-init -n trading-system --from-file=deployments/postgres/init --dry-run=client -o yaml | kubectl apply -f -
	kubectl apply -f deployments/k8s/configmaps/
	kubectl apply -f deployments/k8s/postgres/
	kubectl apply -f deployments/k8s/redis/
	kubectl apply -f deployments/k8s/services/
	kubectl apply -f deployments/k8s/hpa/

k8s-down:
	kubectl delete -f deployments/k8s/hpa/ --ignore-not-found
	kubectl delete -f deployments/k8s/services/ --ignore-not-found
	kubectl delete -f deployments/k8s/redis/ --ignore-not-found
	kubectl delete -f deployments/k8s/postgres/ --ignore-not-found
	kubectl delete configmap postgres-init -n trading-system --ignore-not-found
	kubectl delete -f deployments/k8s/configmaps/ --ignore-not-found
	kubectl delete -f deployments/k8s/namespace.yaml --ignore-not-found
