# Kafka Connect image with the Debezium PostgreSQL connector.
# Base image already ships the Confluent Avro converter (for Schema Registry);
# the Debezium connector adds the Outbox Event Router SMT and the
# BinaryDataConverter used to relay Avro outbox payloads.
FROM confluentinc/cp-kafka-connect:7.7.1
RUN confluent-hub install --no-prompt debezium/debezium-connector-postgresql:2.5.4
