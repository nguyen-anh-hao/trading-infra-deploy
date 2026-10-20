#!/usr/bin/env bash
# Wait until the local trading stack is actually ready for k6, not merely
# "container started". Spring Boot accepts a TCP connection before it can serve
# /actuator/health, so the first k6 run after `up -d` otherwise fails preflight.
set -euo pipefail

TIMEOUT="${WAIT_TIMEOUT_S:-180}"
DEADLINE=$((SECONDS + TIMEOUT))

URLS=(
  "http://localhost:8080/health"
  "http://localhost:8087/health"
  "http://localhost:9001/health"
  "http://localhost:9002/health"
  "http://localhost:8083/actuator/health"
  "http://localhost:8086/actuator/health"
  "http://localhost:8085/health"
  "http://localhost:8084/fee-tiers?account_id=1"
)

CONNECTORS=(
  "settlement-outbox-connector"
  "orders-outbox-connector"
  "risk-outbox-connector"
)

while :; do
  ready=1
  for url in "${URLS[@]}"; do
    if ! curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      ready=0
      break
    fi
  done
  if [ "$ready" -eq 1 ]; then
    for connector in "${CONNECTORS[@]}"; do
      status=$(curl -fsS --max-time 3 "http://localhost:18083/connectors/${connector}/status" 2>/dev/null || true)
      if ! grep -q '"state":"RUNNING"' <<<"$status"; then
        ready=0
        break
      fi
    done
  fi
  if [ "$ready" -eq 1 ]; then
    echo "stack ready: all services healthy and connectors RUNNING"
    exit 0
  fi
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    echo "timed out after ${TIMEOUT}s waiting for the stack" >&2
    echo "check: docker compose ps, docker logs, curl http://localhost:8083/actuator/health" >&2
    exit 1
  fi
  sleep 2
done
