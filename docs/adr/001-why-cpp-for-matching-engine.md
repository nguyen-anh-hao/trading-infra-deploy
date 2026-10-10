# ADR 001: Why C++ for the Matching Engine

## Context
A trading system's core competitive advantage lies in deterministic order execution speed (tick-to-trade latency) and consistent throughput during market volatility spikes.

## Decision
We implemented the `matching-engine` in **modern C++ (C++20)** instead of managed languages like Java, Go, or Python.

## Rationale
1. **Zero Garbage Collection (GC) Jitter:** Managed runtimes suffer from unpredictable GC stop-the-world pauses (often tens of milliseconds), creating unacceptable tail-latency spikes (P99/P99.9) on high-frequency trading queues.
2. **Deterministic Memory Layout:** C++ provides granular control over cache alignment, memory arenas, and contiguous memory storage (`std::vector` vs pointer graphs), maximizing CPU L1/L2/L3 cache hits.
3. **Hardware & OS Proximity:** Direct access to CPU SIMD vector instructions, thread-affinity pinning (`pthread_setaffinity_np`), and future migration to kernel-bypass networking (Solarflare OpenOnload / DPDK).

## Consequences
- Requires strict bounds-checking and testing to prevent segmentation faults.
- Must communicate with higher-level services via well-defined IPC/RPC contracts.
