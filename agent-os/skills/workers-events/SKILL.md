---
name: workers-events
description: Implements and maintains core-be patterns for domain events, BullMQ queues, and worker processes (Redis-backed). Use when adding event emission in services, registering handlers, defining queues/jobs, implementing workers, or handling graceful shutdown and retries.
indexNote: domain events + BullMQ queues/workers (Redis, retries, graceful shutdown)
---

# Workers + events (EventBus + BullMQ)

## Core pattern

- **Services emit domain events** (in-process) after successful DB writes.
- **Event handlers enqueue BullMQ jobs** for side effects.
- **Workers process jobs** (pull-based) and interact with integrations/DB as needed.

Event handler failure must **not** fail the HTTP request (log and continue).

## Naming conventions

- **Event types**: `"<domain>.<verb>"` (e.g. `organization.created`)
- **Queue names**: `"<domain>"` (e.g. `organization`)
- **Job names**: `"<domain>.<action>"` (e.g. `organization.created`)
- **Payload fields**: prefer **snake_case** for identifiers in event payloads (e.g. `organization_id`, `created_by`)
- **Full names only**: `repository` not `repo`, `organization` not `org`, `database` not `db`

## Default resilience settings

- `attempts: 3`
- exponential backoff starting at 1000ms
- `removeOnComplete` capped
- `removeOnFail` capped

## Files/locations

- Event bus: `src/core/events/event-bus.ts`
- Queue infrastructure (**connection**, **scheduler** for repeatable retention jobs, **dead-letter** for `<source-queue>-dlq` + final-failure Sentry, **bootstrap**): `src/infrastructure/queue/connection.ts`, `src/infrastructure/queue/scheduler.ts`, `src/infrastructure/queue/dlq/dead-letter.ts`, `src/infrastructure/queue/bootstrap.ts`
- Worker options (stalled job config): `src/infrastructure/queue/worker-runtime/worker-options.ts` — use `getDefaultWorkerOptions()`, `getWebhookWorkerOptions()`, or `getRetentionWorkerOptions()` so lock duration and stall handling are explicit; subscribe to `worker.on('stalled', ...)` for logging
- Redis client: `src/infrastructure/cache/redis.client.ts`
- Domain event aggregator: `src/domains/<domain>/events/index.ts` → calls sub-domain `register*EventHandlers()`
- Event types + handlers: `src/domains/<domain>/sub-domains/<sub-domain>/events/*` (or nested: `sub-domains/<parent>/<child>/events/*`)
- Queue definitions + enqueue helpers: `src/domains/<domain>/sub-domains/<sub-domain>/queues/*` (same nesting rule)
- Workers: `src/domains/<domain>/sub-domains/<sub-domain>/workers/*` (or nested path; or domain root `workers/` for flat domains (`audit`, `upload`) and domain-spanning workers, e.g. `user`)
- Worker entrypoint: `src/worker.ts`

**Important**: Queue infrastructure lives in `src/infrastructure/queue/` and only wires Redis, **central repeatable-job registration** (`scheduler.ts`), **dead-letter** (`dead-letter.ts`) + worker DLQ/Sentry hooks from `bootstrap.ts`, and worker startup. **Processor** logic and **event-driven** queue definitions + enqueue helpers must reside in their respective domain sub-domains, **not** in infrastructure or shared.

- **Repeatable / cron jobs (retention cleanup):** register every `upsertJobScheduler` entry in `src/infrastructure/queue/scheduler.ts` only. Domain worker files define the `Worker` processor only (same queue name as in `scheduler.ts`).

> **commit-dispatch subsystem** (`src/infrastructure/queue/commit-dispatch/`): A recovery worker, executor, and store for durable post-commit side effects. Not a domain worker — lives in infrastructure. When implementing patterns that need guaranteed post-commit delivery, consult this subsystem.

For a visual flow diagram (Service → EventBus → Handler → Queue → Redis → Worker), see `README.md` § Architecture Diagrams → Event-Bus and BullMQ Flow.

## Dead-letter queue and alerting

- After a job exhausts BullMQ retries (`job.attemptsMade >= (job.opts.attempts ?? 1)`), `attachDeadLetterAndAlerting` (wired from `bootstrap.ts` for each worker) enqueues a **`dead-letter`** job to **`<source-queue-name>-dlq`** with a **snake_case** payload snapshot (`original_queue`, `original_job_id`, `original_data`, `failed_reason`, …).
- **Transient** failures log `queue.job.retry` at **warn**; **final** failures log `queue.job.final_failure`, enqueue the DLQ job, and send **one** Sentry event per failure (fingerprint `worker_final_failure` + queue + job name). Do **not** call `captureException` from individual `worker.on('failed')` handlers — that duplicates noise across retries.
- Workers return `{ worker, queueName, close }` (see `WorkerHandle` in `bootstrap.ts`) so bootstrap can attach the hook; the repeatable-job **scheduler** handle has `close` only.
- Bull Board (`queue-dashboard.ts`) lists each `-dlq` queue next to its source queue when the dashboard is enabled.
- On worker shutdown, `closeDeadLetterQueues()` runs after worker handles close (see `src/worker.ts`).
- **Poison messages:** at each worker processing entry point, validate `job.data` with `parseJobDataOrDeadLetter({ schema, job, queueName })` (`src/infrastructure/queue/dlq/poison-job.util.ts`) instead of `parseBullMQJobData`. On a schema failure it records the dead-letter (Postgres + Redis mirror) and throws BullMQ `UnrecoverableError`, so a malformed payload skips the remaining retries instead of burning the backoff budget. `attachDeadLetterAndAlerting` recognises `UnrecoverableError` and does not record a second time. Keep using `parseBullMQJobData` in the producer-side `enqueue*` helpers (enqueue is not a retry path).

## Distributed tracing across the queue

- **Inject on enqueue:** spread `captureTraceContextForPropagation()` into the job payload in every `enqueue*` helper, and merge `traceContextJobFieldsSchema` (`src/infrastructure/observability/tracing/trace-context-job-fields.schema.ts`) into the job's `*.job.schema.ts` so `traceparent` / `tracestate` validate.
- **Extract in the worker:** wrap the job body in `runWithPropagatedTraceContext({ traceparent, tracestate }, job.name, () => …)` (`trace-context.util.ts`) so the worker span is a child of the originating request. Both helpers no-op when no span is active or OTEL is disabled.

## Canonical examples

**Tenancy — member invitation**

```text
member-invitation.service.ts  →  eventBus.emit(tenancy.member_invitation.created|resent)
tenancy/sub-domains/membership/member-invitation/events/*.ts  →  recordOutboxEmail() + onCommit(dispatchOutboxEmail)
tenancy/events/index.ts  →  registerTenancyEventHandlers()
```

**Auth — transactional email** (email verification-code, password reset)

```text
email-login.service.ts / auth-method.service.ts  →  eventBus.emit(auth.*.requested)
auth/sub-domains/auth-method/events/*.ts  →  recordOutboxEmail() + onCommit(dispatchOutboxEmail)
auth/events/index.ts  →  registerAuthEventHandlers()
```

**Notify — cross-domain notifications** (billing subscription lifecycle)

```text
stripe-webhook / subscription.service  →  emit billing.subscription.created|updated|canceled|payment_failed
notify/sub-domains/notification/events/billing-notification.event-handlers.ts  →  createAndDispatchNotification()
```

**Notify — outbound webhook delivery**

```text
emitWebhookDeliveryRequested()  →  notify/sub-domains/webhook/events/
notify/sub-domains/webhook/events/webhook-delivery.event-handlers.ts  →  enqueueWebhookDeliveryByAttemptId()
billing events  →  notify/sub-domains/webhook/events/billing-webhook.event-handlers.ts
```

**Notify — direct enqueue** (unused today): `notification.service.dispatchNotification()` → `enqueueNotification()` for rows that already exist.

`src/core/events/register-event-handlers.ts` calls each domain’s `register*EventHandlers()` (from `buildApp()` before routes).

## Implementation checklist

1. **Emit**
   - In the service method (after DB create/update), call `eventBus.emit({ type, payload, timestamp })` with snake_case payload fields.

2. **Handle**
   - Register handler once at startup via `registerEventHandlers()` in `src/core/events/register-event-handlers.ts` (invoked from `buildApp()`).
   - Handler should:
     - validate payload shape
     - enqueue job
     - catch/log errors (do not throw up to HTTP path)

3. **Work**
   - Worker should:
     - switch on `job.name`
     - log structured metadata (job id, organization id, etc.)
     - be idempotent when possible
   - **Database access in workers/processors** (never `getRequestDatabase()` or `database-context-runtime` imports):
     - Type handles via `PostgresDatabaseHandle` / `WorkerDatabaseHandle` in `src/infrastructure/database/utils/database-handle.types.ts` and `src/infrastructure/queue/worker-runtime/worker-processor.util.ts`
     - **Runtime guard:** `src/worker.ts` sets `CORE_BE_RUNTIME=worker`. Unpinned `getRequestDatabase()` throws `WorkerDatabaseContextError`. Context kind is tracked in `database-context-runtime.ts` (ALS).
     - Use `runOrganizationScopedWorkerJob`, `runGlobalRetentionWorkerJob`, or `runUserScopedWorkerJob` from `worker-processor.util.ts`, or `createTenantScopedBullMQWorker` for tenant-scoped queues, or call the context wrappers directly
     - Tenant-scoped jobs → `withAppDatabaseContext(PRINCIPAL_SCOPE.JOB({ organizationPublicId }), (databaseHandle) => …)` — pins ALS + `SET LOCAL app.current_organization_public_id`
     - Global tombstone/retention → `withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP, (databaseHandle) => …)` — `app.global_retention_cleanup`
     - GDPR export → `withAppDatabaseContext(PRINCIPAL_SCOPE.JOB({ userPublicId }), (databaseHandle) => …)` — `app.current_user_public_id`
     - Session cleanup → `withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.SESSION_RETENTION_CLEANUP, …)` — `app.session_retention_cleanup`
     - Mail outbox + Stripe webhook ledger (no tenant RLS) → `withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.SYSTEM_TABLE_WORKER, …)` in processors/workers
     - Pass `databaseHandle` into `createWorker*Repository(databaseHandle)` factories; factories call `assertWorkerDatabaseContext` for the expected kind

4. **Bootstrap**
   - **Register every BullMQ worker in `src/infrastructure/queue/worker-runtime/worker-registration.registry.ts`** — the single source of truth for both startup (`bootstrap.ts`) and Postgres connection budgeting (`worker-connection-budget.ts`). Never register a worker directly in `bootstrap.ts`; never duplicate concurrency in the budget file.
   - Register repeatable retention schedules in `src/infrastructure/queue/scheduler.ts` (wired from `bootstrap.ts`). The scheduler is filtered to **active queues for the selected `WORKER_QUEUE_FAMILIES`** — pass the same `queueName` the registry uses.

5. **Shutdown**
   - On SIGTERM/SIGINT:
     - close BullMQ workers (drain)
     - close dead-letter `Queue` clients (`closeDeadLetterQueues`)
     - close Redis connection
     - exit with code 0

## Worker registration registry (Postgres pool budget)

Every BullMQ worker is registered exactly once in [`worker-registration.registry.ts`](../../../src/infrastructure/queue/worker-runtime/worker-registration.registry.ts). The registry powers three things in one place:

1. **Startup** — `bootstrap.ts` reads the registry filtered by `WORKER_QUEUE_FAMILIES`.
2. **Connection budget** — `worker-connection-budget.ts` sums Postgres demand from the same definitions and `assertPostgresConnectionBudget()` enforces it (warn on monolithic, fail-fast on split).
3. **Scheduler filtering** — `scheduler.ts` only registers crons for queue names active in this process.

### Registration shape

```typescript
{
  queueName: '<unique BullMQ queue>',
  family: 'mail' | 'notify' | 'webhook' | 'stripe' | 'retention' | 'observability',
  logLabel: 'human-readable worker name',
  usesPostgres: true | false,
  scheduled: true | false,
  criticality: 'throughput' | 'maintenance' | 'observability',
  holdsConnectionDuringExternalIo?: true | false,
  resolvePostgresConcurrency?: (workerContainers) => number,
  isEnabled?: (workerContainers) => boolean,
  create: (workerContainers) => WorkerHandle,
}
```

`retentionDefinition({ ... })` defaults `usesPostgres: true`, `resolvePostgresConcurrency: () => RETENTION_WORKER_CONCURRENCY`, `scheduled: true`, and `criticality: 'maintenance'`. Override `scheduled` only for orphan workers (registered but no cron yet).

### Field decisions

| Field                             | How to choose                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `family`                          | Pick the smallest family that fits. Throughput workers → `mail` / `notify` / `webhook` / `stripe`. Crons / sweepers / tombstone / partition / GDPR retention → `retention`. Redis-only monitoring → `observability`.                                                                                                                                                                                                     |
| `usesPostgres`                    | `true` if the processor checks out a postgres.js connection at any point during a job. `false` only when the processor talks exclusively to Redis / external HTTP (e.g. `dlq-depth`, `idempotency-cardinality`).                                                                                                                                                                                                         |
| `scheduled`                       | `true` when there is a matching `upsertJobScheduler` entry in `scheduler.ts`. `false` for event-driven workers (`mail`, `webhook-delivery`, `notification`, `user-data-export`, `stripe-webhook`). `scheduler-registry-audit.ts` cross-checks both directions and logs `worker.registry.scheduler_mismatch` on drift.                                                                                                    |
| `criticality`                     | `throughput` for workers that drive user-visible latency (event-driven mail/notify/webhook/stripe). `maintenance` for retention/cron/sweeper/reclaim. `observability` for metrics-only workers (`dlq-depth`, `idempotency-cardinality`). Surfaced in `worker.queue_families.selected` and pool alerts.                                                                                                                   |
| `holdsConnectionDuringExternalIo` | `true` when the Postgres checkout is held during an outbound HTTP / S3 / Resend / Stripe call. Examples: `audit-export` / `upload-tombstone-retention` / `upload-pending-sweep` / `user-data-export(-retention)` (S3 calls during DB context). Omit / `false` when the DB context closes before any external IO — e.g. `webhook-delivery`, which claims and records the attempt in separate short transactions around (not across) the outbound POST. Only meaningful when `usesPostgres: true`. |
| `resolvePostgresConcurrency`      | Throughput: `() => getWorkerConcurrencyMail()` / `_Notify()` / `_Webhook()` / `_Stripe()` from `@/shared/config/worker-concurrency.util.js`. Cron / retention / sweeper: use the `retentionDefinition()` helper (concurrency `RETENTION_WORKER_CONCURRENCY = 1`). Required when `usesPostgres: true`.                                                                                                                    |
| `isEnabled`                       | Only when the worker is conditional on env config (e.g. mail disabled in CI, Stripe disabled when keys absent). Omit when always enabled.                                                                                                                                                                                                                                                                                |
| `create`                          | Factory that returns a `WorkerHandle`. May accept `workerContainers` for cross-domain service deps (e.g. user-data-export needs `userDomain.userDataExportService`).                                                                                                                                                                                                                                                     |

### Checklist when adding a new worker

1. Implement the worker file under `src/domains/<domain>/<sub-domain>/workers/*.worker.ts` and export a `createXxxWorker()` factory that returns `WorkerHandle`.
2. Add a constants file (`<queue>.constants.ts`) exporting the queue name string.
3. **Add a single entry to `worker-registration.registry.ts`** — pick `family`, `usesPostgres`, `resolvePostgresConcurrency`, `scheduled`, `criticality`, and (when relevant) `holdsConnectionDuringExternalIo`. Use `retentionDefinition({ ... })` for single-concurrency cron workers (it defaults `scheduled: true` + `criticality: 'maintenance'`).
4. If it is a repeatable / cron job, add an `upsertJobScheduler` entry in `scheduler.ts` using the same `queueName` constant — and set `scheduled: true` in the registration. The startup audit will warn if these disagree.
5. Run targeted tests: `pnpm test:unit src/infrastructure/queue/worker-runtime/__tests__/unit/` and `pnpm test:unit src/infrastructure/database/__tests__/unit/assert-connection-budget.unit.test.ts` (asserts new demand is bounded).
6. Update the worker count and family breakdown in [`docs/deployment/runbooks/resource-limits.md`](../../../docs/deployment/runbooks/resource-limits.md#per-family-registry-breakdown-32-workers-29-use-postgres) when the totals change, including the **External-IO holding** column when `holdsConnectionDuringExternalIo: true`.

### Anti-patterns

- **Do not** register workers directly in `bootstrap.ts` — the registry is canonical.
- **Do not** add a parallel concurrency number anywhere else (env, config, budget file). The registry's `resolvePostgresConcurrency` is the only source.
- **Do not** put a worker in the wrong family — split deployments rely on `WORKER_QUEUE_FAMILIES` selecting correctly.
- **Do not** mark `usesPostgres: false` if any code path opens a transaction or calls a repository — the budget will under-count and the pool can starve.
- **Do not** add an `upsertJobScheduler` cron without flipping `scheduled: true` (or vice versa) — the startup audit will log `worker.registry.scheduler_mismatch`.
- **Do not** mark `holdsConnectionDuringExternalIo: false` for workers that wrap S3 / Resend / Stripe / outbound HTTP inside a DB context — the at-risk demand metric will under-count pool starvation risk during external slowness.

---

## Sync after changes (layered docs)

When a worker, processor, queue, event type, or handler is added or renamed:

1. **TSDoc on every public export** in the new `*.worker.ts`, `*.processor.ts`, queue file, or event-handlers file. Workers / processors are **service-like** and require both `summary` and `@remarks` (Algorithm / Failure modes / Side effects / Notes). Invoke **tsdoc-export-guard**.
2. **<folder>.overview.md** for the new domain / sub-domain folder if not present (Template A.2 with a `## Lifecycle` Mermaid showing the worker's job state machine). Invoke **overview-doc-maintainer**.
3. **System narrative** updates if the worker introduces a cross-cutting pattern (e.g. a new transactional-outbox surface) or participates in a new end-to-end flow. Invoke **system-narrative-maintainer**.
4. **Coverage check** — run `pnpm tsdoc:check` to confirm new worker / processor / queue / event exports carry summaries (and `@remarks` for service-like files).

The strict ratchet at pre-commit and CI ensures none of the four `MISSING_*` token counts grow when a worker is added.

## Don'ts

- Don't call integrations directly from services (emit events instead).
- Don't push jobs from HTTP controllers; keep it in services/events so behavior stays consistent across entrypoints.
- Don't place **processor** implementations in `src/infrastructure/queue/` — they belong in `src/domains/<domain>/<sub-domain>/workers/*`. Event-driven **queue + enqueue** helpers belong in `src/domains/<domain>/<sub-domain>/queues/*`. Exception: `scheduler.ts` registers repeatable **`upsertJobScheduler`** entries only (no processors).
- Don't call `getRequestDatabase()` from workers, processors, or `batch-delete.util.ts` — the guard tests block `database-context-runtime` and global `database` pool imports there; use explicit handles from context wrappers and `createWorker*Repository` factories.
- Don't register a worker outside the registry (`worker-registration.registry.ts`). Budget drift is the most common production-incident class this registry prevents.
