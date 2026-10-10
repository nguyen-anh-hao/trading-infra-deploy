SHELL := /bin/bash

.PHONY: all proto build-all infra-up app-up up monitor-up down down-v reset k8s-deploy stress-test clean test net frontend-install frontend-dev frontend-build frontend-start

# 1. Sinh code Protobuf cho Go, C++, Java, TypeScript (yêu cầu cài đặt `buf`)
proto:
	buf generate

# 2. Build binaries cho tất cả services
build-all:
	cmake -B services/matching-engine/build -S services/matching-engine && cmake --build services/matching-engine/build -j
	cd services/api-gateway && go build -o bin/gateway ./cmd
	cd services/risk-engine && go build -o bin/risk ./cmd
	cd services/clearing-settlement && mvn clean package -DskipTests
	cd services/promotion-service && npm install && npm run build

# 3. Chạy hạ tầng Database & Giám sát (PostgreSQL + Redis + pgAdmin)
# Shared network so Prometheus can reach the app services and postgres-exporter.
net:
	docker network create trading-net || true

infra-up: net
	docker compose -f deployments/docker/docker-compose.infra.yml up -d

monitor-up: net
	docker compose -f deployments/observability/docker-compose.monitor.yml up -d

# 3b. Chạy toàn bộ stack & reset về trạng thái sạch
app-up: net
	docker compose -f deployments/docker/docker-compose.app.yml pull
	docker compose -f deployments/docker/docker-compose.app.yml up -d

# Dựng tất cả: infra + app + monitor.
up: infra-up app-up monitor-up

# Dừng & xoá container (giữ volume + shared network).
down:
	docker compose -f deployments/observability/docker-compose.monitor.yml down
	docker compose -f deployments/docker/docker-compose.app.yml down
	docker compose -f deployments/docker/docker-compose.infra.yml down

# Dừng, xoá container + named volumes (vd pgdata).
down-v:
	docker compose -f deployments/observability/docker-compose.monitor.yml down -v
	docker compose -f deployments/docker/docker-compose.app.yml down -v
	docker compose -f deployments/docker/docker-compose.infra.yml down -v

# Reset hoàn toàn: xoá container + volume + shared network + build artifacts.
reset: down-v
	docker network rm trading-net || true
	$(MAKE) clean

# 4. Triển khai toàn bộ stack lên Kubernetes
k8s-deploy:
	kubectl apply -f deployments/k8s/namespace.yaml
	kubectl apply -f deployments/k8s/configmaps/
	kubectl apply -f deployments/k8s/postgres/
	kubectl apply -f deployments/k8s/redis/
	kubectl apply -f deployments/k8s/services/
	kubectl apply -f deployments/k8s/hpa/

# 5. Kích hoạt Bot bắn tải để theo dõi điểm nghẽn trên Grafana/Jaeger
# Dùng LOCUST_USERS / LOCUST_SPAWN_RATE / LOCUST_RUN_TIME để điều chỉnh tải.
# Mặc định thấp (20 user) để ra số liệu có ý nghĩa trước khi tăng dần tìm ngưỡng.
LOCUST_USERS ?= 20
LOCUST_SPAWN_RATE ?= 5
LOCUST_RUN_TIME ?= 10m
LOCUST_HOST ?= http://localhost:8080

stress-test:
# 	python3 -m pip install --break-system-packages -r bots/noise-trader-py/requirements.txt
	locust -f bots/noise-trader-py/locustfile.py --headless -u $(LOCUST_USERS) -r $(LOCUST_SPAWN_RATE) --run-time $(LOCUST_RUN_TIME) --host $(LOCUST_HOST)

# 6. Chạy toàn bộ unit tests
test:
	cd services/api-gateway && go test ./...
	cd services/risk-engine && go test ./...
	cd services/matching-engine/build && ctest --output-on-failure
	cd services/promotion-service && npm test || true

# 7. Frontend priceboard (chỉ npm, không cần Docker)
frontend-install:
	cd frontend && npm install

frontend-dev:
	cd frontend && npm run dev

frontend-build:
	cd frontend && npm run build

frontend-start:
	cd frontend && npm run start

clean:
	rm -rf services/matching-engine/build services/api-gateway/bin services/risk-engine/bin
	rm -rf services/clearing-settlement/target services/promotion-service/dist services/promotion-service/node_modules
