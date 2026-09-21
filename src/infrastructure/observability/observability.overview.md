`src/infrastructure/observability/`

# Observability infrastructure

## Purpose

The platform's instrumentation surface: Sentry (errors, traces, profiling, structured logs), OpenTelemetry (optional OTLP trace export), idempotency-cardinality monitoring (bounded SCAN to detect Redis-key leaks), and the DLQ-depth + DB-pool alerting workers. This module owns the wiring; individual domains and infrastructure modules consume it through `Sentry.captureException()`, `logger.*`, etc.

## Design decisions

- **Sentry over alternatives**: chosen for the integrated error + tracing + profiling story, the breadcrumb model, and the seamless V8 CpuProfiler integration. Continuous profiling lets us find regressions without enabling profiling per-incident.
- **OpenTelemetry (optional)**: `initOpenTelemetry()` is started from both entrypoints (`server.ts` / `worker.ts`, service names `core-be-api` / `core-be-worker`) and is a **no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set** — so OTLP tracing actually runs when an operator configures it, and the SDK is flushed + torn down (`shutdownOpenTelemetry()`) in both graceful-shutdown paths before the Sentry flush. Coexists with Sentry tracing.
- **Structured logging via Pino + Sentry**: Pino emits JSON logs to stdout (collected by Railway / the cloud provider); Sentry receives a structured copy of `error`-level entries via the Sentry transport.
- **Idempotency cardinality sampling**: a bounded `SCAN` on the `idempotency:*` Redis keyspace runs on a schedule, logs the cardinality, and fires Sentry when a threshold is crossed. The point is to detect the "leak" failure mode where a bug strands keys past their TTL.
- **DLQ depth alerts**: the [dlq-depth/](src/infrastructure/observability/dlq-depth/) worker polls every queue's DLQ count and emits Sentry warnings when depth exceeds a threshold, so on-call sees the queue health independently of any single failed job.
- **Redis saturation + queue waiting-depth alerts**: the [redis-saturation/](src/infrastructure/observability/redis-saturation/) module samples Redis `used_memory`/`maxmemory` ratio and BullMQ `waiting`+`delayed` depth on the dlq-depth worker's existing schedule. Memory saturation is the leading indicator for the `noeviction` write-outage failure mode; waiting depth surfaces a worker outage before the backlog fills Redis. Both warn via `logger` and escalate to Sentry past their thresholds (`REDIS_MEMORY_WARN_RATIO` / `REDIS_MEMORY_CRITICAL_RATIO`, `QUEUE_WAITING_DEPTH_WARN_THRESHOLD`).
- **DB pool alerting**: similar pattern for Postgres pool waiters — a long-running pool wait is a leading indicator of a transaction holding a connection across a remote round trip (see `billing` invariant about Stripe calls outside RLS contexts).
- **Read-cache hit ratio**: `read_cache_requests_total{cache,result}` is recorded by every Redis read cache (see [read-caching](src/PATTERNS.md)). It exists because a cache is otherwise unfalsifiable — it either removes a pool checkout or quietly costs a Redis round trip per request, and nothing in the logs distinguishes the two. The label is the cache's **name**, never its key, so cardinality stays bounded. Alert on a sustained drop rather than an absolute value: the right ratio differs per cache, and a collapse after a deploy usually means an invalidation became too broad.

## Operational concerns

- **PII redaction**: the Sentry `beforeSend` hook strips emails, IP addresses, and tokens from breadcrumbs and event tags. The redaction list lives in [sentry.ts](src/infrastructure/observability/sentry/sentry.ts).
- **Sample rate**: `SENTRY_TRACES_SAMPLE_RATE` controls trace sampling; we run at 1.0 in dev and a tunable rate in prod.
- **Profile cadence**: continuous profiling runs in 60 s windows; Sentry merges them into the project's profile timeline.

## External dependencies

- **Sentry** — error / trace / profile / log destination.

## Failure modes

- **Sentry unavailable** → SDK queues events in memory up to a cap; events drop after the cap (logged at warn). Application path is not blocked.
- **Pino transport blocks on stdout** (very rare, container-level pipe full) → the worker pool can stall; mitigated by the cloud provider's log forwarding.
- **Idempotency-cardinality SCAN is bounded** so it cannot trigger Redis CPU pressure, but a cluster of large mismatches will produce alerts.
