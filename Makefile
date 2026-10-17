SHELL := /bin/bash

.PHONY: help net infra-up monitor-up app-pull app-up app-local up up-prod down down-v reset k8s-deploy k8s-down logs-app ps

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
	@echo "======================================================================="

# Shared docker network for inter-container communication
net:
	@docker network inspect trading-net >/dev/null 2>&1 || docker network create trading-net

# 1. Core Data Infrastructure
infra-up: net
	docker compose -f deployments/docker/docker-compose.infra.yml up -d

# 2. Observability & Telemetry
monitor-up: net
	docker compose -f deployments/observability/docker-compose.monitor.yml up -d

# 3. Microservices Application Stack (GHCR)
app-pull:
	docker compose -f deployments/docker/docker-compose.app.yml pull

app-up: net app-pull
	docker compose -f deployments/docker/docker-compose.app.yml up -d

# 4. Microservices Application Stack (Local Build)
app-local: net
	docker compose -f deployments/docker/docker-compose.local.yml up -d --build

# 5. Master Commands
up: infra-up monitor-up app-local
	@echo ""
	@echo ">>> Trading System (LOCAL SOURCE mode) is LIVE! <<<"
	@echo "  - API Gateway:    http://localhost:8080"
	@echo "  - Grafana:        http://localhost:3000 (admin / admin)"
	@echo "  - Jaeger UI:      http://localhost:16686"
	@echo "  - Prometheus:     http://localhost:9090"
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
	@echo "  - Kafka UI:       http://localhost:8090"
	@echo "  - Kafka Connect:  http://localhost:18083"
	@echo "  - pgAdmin:        http://localhost:5050 (admin@example.com / admin)"
	@echo ""

# 6. Teardown & Maintenance
down:
	docker compose -f deployments/docker/docker-compose.local.yml down --remove-orphans 2>/dev/null || true
	docker compose -f deployments/docker/docker-compose.app.yml down --remove-orphans 2>/dev/null || true
	docker compose -f deployments/observability/docker-compose.monitor.yml down --remove-orphans 2>/dev/null || true
	docker compose -f deployments/docker/docker-compose.infra.yml down --remove-orphans 2>/dev/null || true

down-v:
	docker compose -f deployments/docker/docker-compose.local.yml down -v --remove-orphans 2>/dev/null || true
	docker compose -f deployments/docker/docker-compose.app.yml down -v --remove-orphans 2>/dev/null || true
	docker compose -f deployments/observability/docker-compose.monitor.yml down -v --remove-orphans 2>/dev/null || true
	docker compose -f deployments/docker/docker-compose.infra.yml down -v --remove-orphans 2>/dev/null || true

reset: down-v
	docker network rm trading-net 2>/dev/null || true

logs-app:
	@if docker compose -f deployments/docker/docker-compose.local.yml ps --status running | grep -q "Up"; then \
		docker compose -f deployments/docker/docker-compose.local.yml logs -f; \
	else \
		docker compose -f deployments/docker/docker-compose.app.yml logs -f; \
	fi

ps:
	docker compose -f deployments/docker/docker-compose.infra.yml ps
	docker compose -f deployments/observability/docker-compose.monitor.yml ps
	docker compose -f deployments/docker/docker-compose.app.yml ps
	docker compose -f deployments/docker/docker-compose.local.yml ps

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