# Observability (production)

What is **in place today** for production signals, and what is **deferred**. For the 2026-05-15 review snapshot, see [production-readiness-2026-05-15.md](../../reviews/production-readiness-2026-05-15.md).

---

## In place

| Signal                      | Tool / path                                                         | Notes                                                                                                |
| --------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Errors, traces, profiling   | [Sentry](../../../src/infrastructure/observability/sentry/sentry.ts)       | `SENTRY_DSN`, release + environment tags                                                             |
| Structured logs             | Pino ([`logger.util.ts`](../../../src/shared/utils/infrastructure/logger.util.ts)) | JSON to stdout; Railway log drain                                                                    |
| Liveness / readiness        | `GET /livez`, `GET /readyz`                             | See [health-checks.md](../../reference/reliability/health-checks.md); deploy probes and load tests               |
| Idempotency cardinality     | Repeatable BullMQ job `idempotency-cardinality`                     | Bounded Redis SCAN + log / Sentry thresholds (`IDEMPOTENCY_CARDINALITY_*`)                           |
| DB pool exhaustion          | API process poll (`db-pool-metrics.ts`)                             | Sentry `database.pool.exhaustion.*` — independent of `METRICS_ENABLED`; see [resource-limits.md](resource-limits.md) |
| Redis memory saturation     | [`redis-saturation.service.ts`](../../../src/infrastructure/observability/redis-saturation/redis-saturation.service.ts) sampled by the dlq-depth worker | `used_memory`/`maxmemory` ratio; warn/critical via `REDIS_MEMORY_WARN_RATIO` / `REDIS_MEMORY_CRITICAL_RATIO` → log + Sentry. Leading indicator for the `noeviction` write-outage mode — see [redis-topology.md](redis-topology.md) |
| BullMQ waiting depth        | [`redis-saturation.service.ts`](../../../src/infrastructure/observability/redis-saturation/redis-saturation.service.ts) sampled by the dlq-depth worker | `waiting`+`delayed` across source queues; warn via `QUEUE_WAITING_DEPTH_WARN_THRESHOLD` → log + Sentry. Surfaces a worker outage before the backlog fills Redis |
| Queue inspection (optional) | Bull Board at `/admin/queues`                                       | `ENABLE_QUEUE_DASHBOARD=true` + super_admin JWT — see [bull-board.md](../../reference/runtime/bull-board.md) |
| **Prometheus metrics** | `GET /metrics` on API + worker (`WORKER_HEALTH_PORT`)              | **On by default** (`METRICS_ENABLED` defaults true); bearer auth required — see [Prometheus](#prometheus-opt-in) below |

---

## Prometheus (opt-in)

Code is in place (`prom-client`). `METRICS_ENABLED` defaults to **`true`** in every runtime (set `METRICS_ENABLED=false` to disable). Configure a scraper (Grafana Alloy, Prometheus, etc.) and set `METRICS_SCRAPE_TOKEN` (min 32 chars). No in-repo Grafana/Prometheus server.

### Enable

| Variable | Purpose |
| -------- | ------- |
| `METRICS_ENABLED` | `true` — exposes `GET /metrics` on API and worker health server |
| `METRICS_SCRAPE_TOKEN` | Required when metrics are enabled (min 32 chars); send `Authorization: Bearer …` on scrape |

### Scrape targets

| Process | URL | Notes |
| ------- | --- | ----- |
| API | `https://<api-host>/metrics` | Same port as Fastify (`PORT`) |
| Worker | `http://<worker-host>:9090/metrics` | `WORKER_HEALTH_PORT` (default **9090**); health server starts with `pnpm dev:worker` / worker process (`startWorkerHealthServer` in `src/worker.ts`) |

Dynamic gauges (pool, BullMQ depth, event loop) refresh on each scrape via [`refreshMetricsBeforeScrape()`](../../../src/infrastructure/observability/metrics/metrics.ts).

### Key metrics (audit #10)

| Metric | Type | Use |
| ------ | ---- | --- |
| `event_loop_lag_ms` | Gauge | Node event-loop delay p99 (ms) |
| `pg_pool_active`, `pg_pool_idle`, `pg_pool_waiting` | Gauge | Postgres connection pressure (sampled from `pg_stat_activity`) |
| `database_rls_active_checkouts` | Gauge | In-process organization-scoped RLS transaction checkouts held now; alert near `DATABASE_POOL_MAX` |
| `database_rls_checkout_hold_seconds` | Histogram (`path`) | How long an organization-RLS checkout pins a pooled connection (`scoped_context` unit of work vs legacy `request_transaction`) |
| `http_request_duration_seconds` | Histogram | Per-route latency; p95 via `histogram_quantile` |
| `bullmq_jobs_waiting` | Gauge (`queue`) | Queue backlog per BullMQ queue |
| `process_unhandled_rejections_total` | Counter (`process`) | Non-fatal `unhandledRejection` events tolerated by the burst handler (`process="api"` / `"worker"`); alert on a sustained sub-threshold rate — it hides a persistent failing path that never trips the fatal burst exit |

Also exported: `db_pool_connections{state}`, `bullmq_queue_*`, `http_requests_total`, default Node metrics (`nodejs_eventloop_lag_*`, heap), and domain gauges (e.g. `stripe_webhook_events_failed`). See [health-checks.md](../../reference/reliability/health-checks.md) and [workers-and-events.md](../../reference/runtime/workers-and-events.md).

`database_rls_checkout_hold_seconds` is the primary scale signal for production-readiness finding #2 (per-request checkout pinning): a rising p95 on `path="scoped_context"` means units of work are holding pooled connections too long (often external I/O leaking into an RLS transaction), and `database_rls_active_checkouts` approaching `DATABASE_POOL_MAX` predicts checkout starvation before requests start queuing.

### Example PromQL

```promql
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))
pg_pool_waiting
bullmq_jobs_waiting
event_loop_lag_ms
max_over_time(database_rls_active_checkouts[5m])
histogram_quantile(0.95, sum(rate(database_rls_checkout_hold_seconds_bucket[5m])) by (le, path))
```

### Local smoke

```bash
METRICS_ENABLED=true pnpm dev
curl -sS http://127.0.0.1:3000/metrics | head
```

**Security:** Never expose `/metrics` without bearer auth in production. Avoid high-cardinality labels (user id, organization id) on histograms.

### Still deferred (infra)

| Item | Status |
| ---- | ------ |
| Grafana / Prometheus server in-repo | Out of scope — configure scraper + dashboards in your platform |
| Redis memory / eviction Prometheus gauges | Threshold log + Sentry alerting is in place (see "In place" above); not yet exported as a `/metrics` gauge |
| Deploy workflow `METRICS_*` secret sync | Optional — set on Railway/GitHub Environment when enabling scrape |

---

## Deferred

| Item                             | Status                                                                                               | When to revisit                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **OpenTelemetry**                | Not wired                                                                                            | When traces/metrics must export to a non-Sentry backend |
| **Grafana Loki**                 | Direction only: Railway **stdout** as the log drain; no in-repo Loki pipeline                        | When centralizing logs in Grafana Cloud Loki            |

---

## Sentry sampling

Production defaults (override with `SENTRY_TRACES_SAMPLE_RATE` / `SENTRY_PROFILE_SAMPLE_RATE`):

| Setting | Prod default | Dev default |
| ------- | ------------ | ----------- |
| Trace baseline | **0.05** (`tracesSampleRate`) | **1.0** |
| Profile sessions | **0.10** (`profileSessionSampleRate`) | **1.0** |

[`tracesSampler`](../../../src/infrastructure/observability/sentry/sentry-sampling.util.ts) (head) and [`beforeSendTransaction`](../../../src/infrastructure/observability/sentry/sentry.ts) (tail) always keep at **100%**:

- HTTP **4xx/5xx** responses
- Transaction names matching **`/error`**
- Routes under **`/api/v1/billing`** and **Stripe webhook** paths
- Requests slower than **`SENTRY_SLOW_TRANSACTION_MS`** (default **3000** ms)

Health-check transactions are dropped. Fast successful requests use deterministic baseline sampling (~5% prod) so error and slow paths stay fully covered at lower volume.

Unit tests: `src/infrastructure/observability/__tests__/sentry.unit.test.ts`.

---

## Logs on Railway

1. API and worker log to **stdout** (Pino).
2. Railway captures container logs in the project dashboard.
3. Optional: forward Railway logs to **Grafana Cloud Loki** (or another sink) via Railway integrations — outside this repo.

---

## Related

- [resource-limits.md](resource-limits.md) — memory, `NODE_OPTIONS`, worker RSS warnings
- [ci-cd/cicd-and-deployment.md](../ci-cd/cicd-and-deployment.md) — `SENTRY_*` and deploy env sync
- [production-go-live.md](production-go-live.md) — go-live steps
