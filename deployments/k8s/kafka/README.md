# Kafka on Kubernetes (Strimzi) — production reference

For **local development** use Redpanda (see `deployments/docker/docker-compose.infra.yml`).
For **production**, deploy Apache Kafka via the [Strimzi operator](https://strimzi.io/)
(roadmap v1.2.0).

## Prerequisites
Install the Strimzi operator into the `trading-system` namespace (or cluster-wide):

```bash
kubectl create namespace trading-system
kubectl apply -f https://strimzi.io/install/latest?namespace=trading-system
```

## Apply
```bash
kubectl apply -f deployments/k8s/kafka/kafka-cluster.yaml
kubectl apply -f deployments/k8s/kafka/accounting-topics.yaml
```

The Confluent Schema Registry can be deployed as a plain Deployment + Service
(talking to the Kafka cluster) and is intentionally kept out of these manifests
for brevity; see `deployments/docker/docker-compose.infra.yml` for its config.
