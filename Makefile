SHELL := /bin/bash

.PHONY: help net infra-up app-up app-pull monitor-up up down down-v reset k8s-deploy k8s-down logs ps

help:
	@echo "======================================================================="
	@echo "  Trading System Infrastructure Orchestration (trading-infra-deploy)  "
	@echo "======================================================================="
	@echo "  make up          - Start everything (infra + observability + apps)"
	@echo "  make down        - Stop all containers (preserves data volumes)"
	@echo "  make down-v      - Stop and wipe all persistent data volumes"
	@echo "  make reset       - Complete teardown and clean network"
	@echo ""
	@echo "  make infra-up    - Boot DB & Cache (PostgreSQL, Redis, pgAdmin)"
	@echo "  make monitor-up  - Boot Observability (Prometheus, Grafana, Jaeger)"
	@echo "  make app-pull    - Pull latest service images from GHCR"
	@echo "  make app-up      - Pull and run microservices"
	@echo ""
	@echo "  make logs        - Follow logs across all running containers"
	@echo "  make ps          - View status of all running containers"
	@echo "  make k8s-deploy  - Deploy all manifests to Kubernetes cluster"
	@echo "======================================================================="

# Shared docker network for inter-container communication
net:
	docker network create trading-net 2>/dev/null || true

# 1. Core Data Infrastructure (PostgreSQL 15, Redis 7, pgAdmin)
infra-up: net
	docker compose -f deployments/docker/docker-compose.infra.yml up -d

# 2. Observability & Telemetry (Prometheus, Grafana, Jaeger, OTel Collector)
monitor-up: net
	docker compose -f deployments/observability/docker-compose.monitor.yml up -d

# 3. Microservices Application Stack (Pulled from GitHub Container Registry)
app-pull:
	docker compose -f deployments/docker/docker-compose.app.yml pull

app-up: net app-pull
	docker compose -f deployments/docker/docker-compose.app.yml up -d

# 4. Master Command: Launch entire ecosystem
up: infra-up monitor-up app-up
	@echo ""
	@echo ">>> Trading System ecosystem is LIVE! <<<"
	@echo "  - API Gateway:    http://localhost:8080"
	@echo "  - Grafana:        http://localhost:3000 (admin / admin)"
	@echo "  - Jaeger UI:      http://localhost:16686"
	@echo "  - Prometheus:     http://localhost:9090"
	@echo "  - pgAdmin:        http://localhost:5050 (admin@exchange.internal / admin)"
	@echo ""

# 5. Teardown & Maintenance
down:
	docker compose -f deployments/docker/docker-compose.app.yml down
	docker compose -f deployments/observability/docker-compose.monitor.yml down
	docker compose -f deployments/docker/docker-compose.infra.yml down

down-v:
	docker compose -f deployments/docker/docker-compose.app.yml down -v
	docker compose -f deployments/observability/docker-compose.monitor.yml down -v
	docker compose -f deployments/docker/docker-compose.infra.yml down -v

reset: down-v
	docker network rm trading-net 2>/dev/null || true

logs:
	docker compose -f deployments/docker/docker-compose.app.yml logs -f

ps:
	docker compose -f deployments/docker/docker-compose.infra.yml ps
	docker compose -f deployments/observability/docker-compose.monitor.yml ps
	docker compose -f deployments/docker/docker-compose.app.yml ps

# 6. Kubernetes Cluster Deployment
k8s-deploy:
	kubectl apply -f deployments/k8s/namespace.yaml
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
	kubectl delete -f deployments/k8s/configmaps/ --ignore-not-found
	kubectl delete -f deployments/k8s/namespace.yaml --ignore-not-found
