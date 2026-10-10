# ADR 002: Why Protobuf & Schema-First Architecture

## Context
The trading platform is polyglot (C++, Go, Java, TypeScript, Python). Maintaining hand-rolled JSON serializers and REST DTOs across 5 independent microservices leads to silent drift, type mismatches (e.g., float precision bugs), and communication overhead.

## Decision
We adopted **Protocol Buffers v3 (managed via Buf CLI)** as the single source of truth in the central `trading-contracts` repository.

## Rationale
1. **Strong Typing & Financial Safety:** Protobuf enforces exact data types and explicit scaling via custom `Decimal` messages, eliminating floating-point rounding errors common in JSON.
2. **Backwards & Forwards Compatibility:** The Buf linter and breaking change checker prevent breaking wire changes before PRs can be merged.
3. **High Serialization Performance:** Protobuf binary serialization is 3–10x smaller and significantly faster than stringified JSON.

## Consequences
- Requires running code generation tooling (`buf generate`) during the build process.
- Changes to schemas require coordinated versioning across consuming teams.
