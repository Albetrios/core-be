`src/infrastructure/queue/`

# Queue infrastructure

## Purpose

BullMQ + Redis runtime for the platform. Owns connection management, the worker bootstrap, the centralized scheduler for repeatable retention jobs, the per-queue dead-letter sibling, and the worker-runtime helpers (RLS context, heartbeat, health server, shutdown timing). Domain-owned queues and processors live in their respective domain folders — this module never holds business logic, only the runtime substrate.

## Design decisions

- **BullMQ over alternatives**: native delayed/repeatable jobs and Redis-backed durability fit the platform's at-least-once / idempotent-handler model. Postgres-backed queues were considered but rejected — the queue would compete with hot business workloads for the same connection pool.
- **One Redis connection per worker process** (not per queue) to bound the connection count visible to managed Redis providers.
- **Producer `enableOfflineQueue: false`**: API-side enqueue helpers use `getBullMQProducerConnectionOptions()` ([connection.ts](src/infrastructure/queue/connection.ts)) so a Redis partition fails the add immediately instead of buffering jobs that would never drain (workers keep the shared options from `getBullMQConnectionOptions()`).
- **Centralized scheduler**: every repeatable retention job is registered through [scheduler.ts](src/infrastructure/queue/scheduler.ts) so the cron index is trivially auditable. Domains export their queue + processor; this module owns the registration moment.
- **Per-queue DLQ**: every queue has a sibling `<name>-dlq` queue that captures final-retry failures with full job context. Final failures additionally fire a Sentry event from [bootstrap.ts](src/infrastructure/queue/bootstrap.ts).
- **Shared job-options policy**: cross-queue defaults that are not queue-specific (e.g. completed/failed job retention count) live in [queue.constants.ts](src/infrastructure/queue/queue.constants.ts) so every event-driven domain producer queue stays consistent; queue-specific options (attempts, backoff, failure caps) remain in each domain's queue file.
- **Workers must use `runOrganizationScopedWorkerJob` / `runGlobalRetentionWorkerJob` / `runUserScopedWorkerJob`** from [worker-runtime/worker-processor.util.ts](src/infrastructure/queue/worker-runtime/worker-processor.util.ts). Workers are forbidden from importing `request-database.context.ts` (enforced by [contexts/worker-database-guard.util.ts](src/infrastructure/database/contexts/worker-database-guard.util.ts) and global tests).
- **Heartbeat keys in Redis**: each worker publishes a heartbeat with `WORKER_QUEUE_HEARTBEAT_TTL_SECONDS = 86 400`; the admin worker-readiness script consumes them.

## Operational concerns

- **Worker stall detection**: `BULLMQ_STALLED_INTERVAL_MS = 30 000` and `BULLMQ_DEFAULT_LOCK_DURATION_MS = 30 000`. Webhook delivery uses a longer 60 000 ms lock; retention sweepers use 120 000 ms.
- **Graceful shutdown**: the worker process drains in-flight jobs and closes connections within `FIFTEEN_SECONDS_MS`. The shutdown-timing util records the exact phase durations for post-incident review.
- **Connection-budget enforcement**: [worker-runtime/worker-connection-budget.ts](src/infrastructure/queue/worker-runtime/worker-connection-budget.ts) caps the per-process Redis connection count.
- **Queue dashboard**: optional Bull Board UI mounted by [queue-dashboard.ts](src/infrastructure/queue/queue-dashboard.ts) when `ENABLE_QUEUE_DASHBOARD=true`. Authenticated; admin-only.

## External dependencies

- **Redis** (managed in production via `REDIS_URL`). [src/infrastructure/cache/](src/infrastructure/cache/) owns the underlying client; this module re-exports through [connection.ts](src/infrastructure/queue/connection.ts).

## Tuning parameters

- `BULLMQ_DEFAULT_LOCK_DURATION_MS = 30 000`
- `BULLMQ_STALLED_INTERVAL_MS = 30 000`
- `BULLMQ_WEBHOOK_LOCK_DURATION_MS = 60 000`
- `BULLMQ_RETENTION_LOCK_DURATION_MS = 120 000`
- `WORKER_QUEUE_HEARTBEAT_TTL_SECONDS = 86 400`
- `DEFAULT_JOB_RETENTION_COUNT = 1 000` — completed/failed jobs kept per event-driven domain producer queue.
- `WORKER_CONCURRENCY` (env) — per-worker job parallelism.

## Failure modes

- **Redis unavailable** → workers fail fast and exit; Railway / Kubernetes restarts the pod once Redis recovers.
- **Worker crashes mid-job** → BullMQ stalls the job and another worker picks it up after the lock duration.
- **Job exceeds retries** → final failure → DLQ + Sentry. Replay tooling lives in [dlq/dlq-replay.util.ts](src/infrastructure/queue/dlq/).

## Related runbooks

- DLQ replay procedure (when present in [docs/deployment/runbooks/](docs/deployment/runbooks/))
- Worker readiness investigation (`pnpm tool:worker-readiness`)
