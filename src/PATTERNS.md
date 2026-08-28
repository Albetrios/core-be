`src/`

# Cross-cutting patterns

These patterns are implemented identically across the codebase. When a domain `<folder>.overview.md` says **Patterns used: tenant-isolation, audit-emission**, it is asserting that domain follows the contract documented here. Drift = bug.

Each entry follows the same shape: **Purpose**, **Where it lives**, **Implementation**, **How to apply**.

## tenant-isolation

### Purpose

Prevent cross-tenant data leaks. Every read and write performed under an organization scope is filtered by `organization_id`, and the database enforces that filter via Row-Level Security as a defense-in-depth layer. A single misplaced query that forgets the filter must not be enough to leak another tenant's rows.

### Where it lives

- HTTP layer: [src/shared/middlewares/tenant/tenant.middleware.ts](src/shared/middlewares/tenant/tenant.middleware.ts) — reads `X-Organization-Id`, validates its format, and decorates `request.organizationId`. The **authoritative** active organization is the signed `org` JWT claim; routes carry no `{organization_id}` path segment.
- Database layer: [src/infrastructure/database/contexts/database-context.ts](src/infrastructure/database/contexts/database-context.ts) — `withAppDatabaseContext(scope, …)` opens a Drizzle transaction and sets the identity GUCs (`app.current_organization_public_id` / `app.current_user_public_id`) from the token-minted principal scope in one `set_config` statement. RLS policies on org-scoped tables read those GUCs.
- Worker layer: [src/infrastructure/queue/worker-runtime/worker-processor.util.ts](src/infrastructure/queue/worker-runtime/worker-processor.util.ts) — `runTenantScopedWorkerJob` requires `organizationPublicId` in the job payload and wraps the processor body in `withAppDatabaseContext` (with a job-minted principal scope) so RLS sees the same GUC the HTTP layer would have set.

### Implementation

```mermaid
sequenceDiagram
  participant Client
  participant Mw as tenant.middleware
  participant Svc as service
  participant Ctx as withAppDatabaseContext
  participant DB as Postgres (RLS)
  Client->>Mw: HTTP request with X-Organization-Id
  Mw->>Mw: validate X-Organization-Id format
  Mw->>Svc: request.organizationId
  Svc->>Ctx: withAppDatabaseContext(scope, fn)
  Ctx->>DB: BEGIN; SET LOCAL app.current_organization_public_id = orgId
  Ctx->>Svc: pinned databaseHandle (transaction)
  Svc->>DB: SELECT/INSERT/UPDATE (RLS filters by org)
  Ctx->>DB: COMMIT
```

The same context is reused if a worker is already running inside one (no nested top-level transaction; no second pool checkout; no lost `SET LOCAL`).

### How to apply

- New tenant-scoped repository: extend `BaseRepository`, scope every query by `organization_id`. Any RLS-eligible table also needs an RLS policy in its migration.
- New tenant-scoped service method: wrap database I/O in `withAppDatabaseContext(scope, fn)` — the scope is minted at the controller (`REQUEST_SCOPE.ORGANIZATION`) and relayed through the service. **Network I/O (Stripe, S3, Resend) MUST stay outside** the wrapper to avoid holding a pool checkout across remote round trips — enforced by `pnpm test:global` (`rls-context-network-isolation.global.test.ts`).
- New worker job: use `runTenantScopedWorkerJob`; never call `getRequestDatabase()` from a `*.worker.ts` / `*.processor.ts` (enforced by global tests).
- New tenant-scoped endpoint: the active organization comes from the `org` JWT claim (no `{organization_id}` path segment); mint the principal scope at the controller and pass it into `withAppDatabaseContext`.

## audit-emission

### Purpose

Every security- or governance-relevant write stages a row in the `audit.outbox` table inside the caller's transaction; the audit drain worker later inserts it into `audit.logs` so post-hoc investigation always has a non-repudiable trail. Audit failures must never fail the originating request — the user-visible operation is the source of truth and the audit row is best-effort.

### Where it lives

- Domain: [src/domains/audit/](src/domains/audit/) owns the audit write path and the `audit.outbox` → `audit.logs` drain worker.
- Caller helper: [src/shared/utils/infrastructure/audit-request-context.util.ts](src/shared/utils/infrastructure/audit-request-context.util.ts) — `recordScopedAuditEvent(request, input)` fills in IP / user-agent / actor fields and stages the outbox row. It wraps [audit-record.util.ts](src/shared/utils/infrastructure/audit-record.util.ts)'s `recordAuditEvent`, which swallows + logs failures so callers don't need a try/catch.

### Implementation

1. Handler performs its primary write (e.g. an organization or auth-method mutation).
2. The handler calls `recordScopedAuditEvent(request, { actorUserPublicId | actorApiKeyPublicId, action, resource_type, resource_id, organization_public_id, severity, metadata })` — network context (IP, user-agent, request id) is filled in by the helper.
3. The row is staged in `audit.outbox` inside the caller's transaction (no synchronous id lookup). The audit drain worker later resolves internal ids and inserts into `audit.logs`.
4. Errors are caught and logged at `warn`; the originating request still returns success.

### How to apply

- Adding a security-relevant route: identify the action constant (or add one in [src/domains/audit/audit.types.ts](src/domains/audit/audit.types.ts)), call `recordScopedAuditEvent(request, {...})` after the primary write, populate `metadata` with the diff or operation parameters that future investigators will need.
- Severity defaults to `INFO`. Use `WARNING` for failed-but-recorded actions (e.g. permission denied) and `CRITICAL` for global-admin lifecycle events.

## idempotency

### Purpose

Mutating endpoints (`POST` / `PUT` / `PATCH` / `DELETE`) accept an `X-Idempotency-Key` header so retries from network errors return the original response instead of executing the operation a second time. For routes marked `idempotencyRequired: true` in their `schema.config`, the header is mandatory.

### Where it lives

- Middleware: [src/shared/middlewares/core/idempotency.middleware.ts](src/shared/middlewares/core/idempotency.middleware.ts).
- Redis: keys live under the `idempotency:` prefix; payload caps at `IDEMPOTENCY_CACHED_BODY_BYTES` (100 KiB); TTL = `IDEMPOTENCY_RESPONSE_CACHE_TTL_SECONDS` (24 h) for completed entries and `IDEMPOTENCY_PLACEHOLDER_TTL_SECONDS` (60 s) for in-flight placeholders.
- Cardinality guard: [src/infrastructure/observability/idempotency-cardinality/](src/infrastructure/observability/idempotency-cardinality/) — bounded SCAN job that warns when the key set exceeds threshold.

### Implementation

```mermaid
flowchart TD
    A[Mutating request] --> B{X-Idempotency-Key present?}
    B -- No, but required --> R[400 Validation error]
    B -- No, optional --> X[Pass through]
    B -- Yes --> C[GET idempotency:user:org:method:path:key]
    C -- hit completed --> D[Return cached status, body, headers]
    C -- hit in_flight --> E[409 conflict / wait]
    C -- miss --> F[SETNX placeholder TTL=60s]
    F -- claimed --> G[Run handler]
    G --> H[onSend: stash response]
    H --> I[onResponse: SET completed entry, TTL=24h]
    F -- not claimed --> E
```

Scope key includes `userId` / `organizationId` / `apiKeyPublicId` so two clients can use the same `X-Idempotency-Key` value without collision.

### How to apply

- Make a route required-idempotent: add `config: { idempotencyRequired: true }` to the route options. The middleware will throw `400` if the header is missing.
- Forward to Stripe: pass the same `Idempotency-Key` to Stripe's API; Stripe honors it for 24 h, matching our TTL.
- Bodies above 100 KiB cannot be replayed; the middleware logs a warning and skips caching. Design endpoints with retry replay in mind to stay under the cap.

## soft-delete

### Purpose

Most user- and organization-owned rows use a `deleted_at TIMESTAMPTZ` column instead of physical `DELETE`. This preserves audit trails, lets retention sweeps run independently of user-facing deletes, and keeps foreign-key references intact while the row is "gone" from the API.

Some tables are deliberately exempt: immutable billing ledgers (audit, ledger entries, invoices) never soft-delete because changing or removing a billing event is a compliance risk. Hard `DELETE` is the right call there only after the retention window passes.

### Where it lives

- Schema definitions: every soft-deletable table declares `deleted_at: timestamp('deleted_at', { withTimezone: true })`.
- Repositories: list/find methods filter `WHERE deleted_at IS NULL` by default; explicit `includeDeleted` flag is opt-in for admin/forensic paths.
- Tombstone retention workers: [src/domains/tenancy/sub-domains/organization/organization-notification-policy/workers/organization-notification-policy-tombstone-retention.processor.ts](src/domains/tenancy/sub-domains/organization/organization-notification-policy/workers/organization-notification-policy-tombstone-retention.processor.ts) and similar — sweep tombstoned rows after a retention window.

### Implementation

1. `service.delete(id)` calls the repository's `softDelete(id)` which sets `deleted_at = NOW()` and emits any associated events.
2. All read paths automatically exclude soft-deleted rows via `WHERE deleted_at IS NULL`. Joins to soft-deleted rows are tested explicitly — the join filter is part of the repository contract.
3. A retention BullMQ job (registered in [src/infrastructure/queue/scheduler.ts](src/infrastructure/queue/scheduler.ts)) periodically hard-deletes tombstones older than the retention window.

### How to apply

- New table: add `deleted_at` unless the table is an immutable ledger. If exempt, document **why** in the schema file.
- New repository: any query that returns user-visible rows must include `eq(table.deleted_at, null)` or use a base helper that does.
- Forensic / admin paths: opt out explicitly via a documented `includeDeleted: true` flag.

## rls-context

### Purpose

Postgres Row-Level Security is the **defense-in-depth** layer for tenant isolation: even if a query forgets `WHERE organization_id = $1`, the database refuses to return rows that don't match the active organization GUC. Workers must obey the same contract — they must not skip RLS just because they're "internal".

### Where it lives

- Context wrappers: [src/infrastructure/database/contexts/](src/infrastructure/database/contexts/) — exactly three scope patterns behind two wrappers: `withAppDatabaseContext` (principal scopes — request, job, or verified/provisioning source — and pre-auth `SESSION_SCOPE` artifacts; the scope decides the GUCs) and `withMaintenanceDatabaseContext` with the static `MAINTENANCE_SCOPE.<kind>` singletons (the whole bypass family: global_retention_cleanup, session_retention_cleanup, global_admin, system_audit_insert, audit_outbox_drain, system_table_retention, system_table_worker).
- Principal scope minting: `REQUEST_SCOPE.ORGANIZATION` (organization always present — the personal/team-organization invariant) / `REQUEST_SCOPE.USER` (additionally guarantees a real end user) in [src/shared/utils/http/request.util.ts](src/shared/utils/http/request.util.ts) — controllers mint a branded `PrincipalDatabaseScope` from the verified token (path-param-else-claim precedence, both `user` and `apiKey` principal kinds); services relay it into `withAppDatabaseContext` and can never fabricate one from raw strings (factory confinement pinned by `principal-scope-minting.policy.unit.test.ts`). Provenance is edge-only: each legitimate "top" (request, worker payload, provisioning) gets its own minter; bypass GUCs have no minter and no path through the principal wrapper.
- Worker runtime: `runTenantScopedWorkerJob`, `runGlobalRetentionWorkerJob`, `runUserScopedWorkerJob` in [src/infrastructure/queue/worker-runtime/worker-processor.util.ts](src/infrastructure/queue/worker-runtime/worker-processor.util.ts).
- Migration: `migrations/00000000000000_init.sql` (consolidated baseline; defines the `app.global_retention_cleanup` RLS bypass policies) and other RLS-policy migrations under [migrations/](migrations/).

### Implementation

- HTTP requests get RLS via `tenant.middleware` + `organization-rls-transaction.middleware` opening a request-scoped transaction with `SET LOCAL app.current_organization_public_id = $1`.
- Workers get RLS via `runTenantScopedWorkerJob` which **requires** `organizationPublicId` in the job payload and opens its own `withAppDatabaseContext` transaction (job-minted org scope). Workers are forbidden from importing `database-context-runtime.ts` (enforced by `worker-database-guard.unit.test.ts` and global tests).
- Global-scope workers (cross-org sweeps) use `withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP, …)`, which sets a different GUC that RLS policies recognize as "global retention" — strictly limited to retention/cleanup operations.

### Each context grants only what a policy names

A context sets **one** GUC. It grants access only on tables whose policies test that GUC — picking the wrong context does not raise an error, it silently returns **zero rows** (or fails a `WITH CHECK` with SQLSTATE 42501 on write).

| Context | GUC it sets | Grants on |
| --- | --- | --- |
| `withAppDatabaseContext` (org scope) | `app.current_organization_public_id` | tenant-scoped tables (`organizations_tenant_isolation` and the per-table `*_tenant_isolation` policies) |
| `withAppDatabaseContext` (user scope) | `app.current_user_public_id` | user-owned rows — `auth.users`, `auth.auth_methods`, uploads/notifications, **and the tenancy discovery policies** (`organizations_user_discovery`, `memberships_user_self_discovery`) |
| `MAINTENANCE_SCOPE.GLOBAL_ADMIN` | `app.global_admin` | **`auth.*` and `audit.logs` ONLY** |
| `MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP` | `app.global_retention_cleanup` | retention-sweep tables only |

**`app.global_admin` grants nothing on `tenancy.*`.** No tenancy policy carries that arm — the tenancy tables are reachable only through the active-org GUC or the user GUC. Reading `tenancy.organizations` / `tenancy.memberships` under the admin context returns zero rows; writing fails its `WITH CHECK`. This shipped to production three times (organization provisioning, active-org resolution at login, and the `OrganizationRepository` user-id resolvers) before being pinned by [no-global-admin-in-tenancy.global.test.ts](src/tests/global/no-global-admin-in-tenancy.global.test.ts) and [tenancy-global-admin-invisibility.security.test.ts](src/tests/security/rls/tenancy-global-admin-invisibility.security.test.ts).

To read `auth.users` from a context that is not the user's own (e.g. inside org context, or post-commit with no GUC), use an `auth.*` **SECURITY DEFINER** resolver — `auth.resolve_user_id_by_public_id`, `auth.resolve_user_by_internal_id`, `auth.resolve_user_public_ids_by_ids` — never a direct join.

### Connection-holding discipline

These four properties hold today and are what keep lock contention from becoming pool exhaustion. Three are conventions — breaking one is a silent regression, not a build error.

| Property | Why it matters | Status |
| --- | --- | --- |
| **Transactions are callback-scoped** — zero `.commit()` / `.rollback()` in `src/domains`, `src/shared`, `src/core` | Makes the "early return between BEGIN and COMMIT leaks a transaction holding its row locks" defect class **unwritable** | verified, convention |
| **Every `set_config` passes `true`** (transaction-scoped) | A session-scoped identity survives on a pooled connection and leaks the previous caller's tenant to the next one | verified, convention |
| **No batch-and-parallel write fan-out** — no slicing an id list and dispatching the chunks through `Promise.all` | Postgres serialises the statements on one connection anyway, so the concurrency buys nothing while every statement's row locks are held until COMMIT — the lock window grows with the batch count. Issue one statement for the whole list, or chunk **sequentially** | verified, convention |
| **Bounded post-commit fan-out** — `flushOnCommit` runs at most `MAX_CONCURRENT_ON_COMMIT_TASKS` tasks at once | A post-commit task that touches the database opens its own scoped context, so unbounded dispatch made one request's connection demand equal its queue length | enforced in code |

**Three timeouts, three different failures, no substitutes** (all connection parameters, see [database.overview.md](src/infrastructure/database/database.overview.md)): `statement_timeout` bounds a running query, `idle_in_transaction_session_timeout` bounds an open-and-idle transaction, `lock_timeout` bounds a statement **blocked behind someone else's lock**. A lock waiter is neither running nor idle, so only `lock_timeout` bounds it — while it holds its pooled checkout for the entire wait.

### How to apply

- New tenant-scoped table: add an RLS policy in its migration. The migration linter (`pnpm db:migrate:lint`) rejects schemas that omit RLS where it's required.
- New worker: pick the right runner (`Tenant`, `Global`, `User`) and pass the right context payload. Don't call `getRequestDatabase()`; don't import from `database-context-runtime.ts`. The pre-commit `validate:domain` enforces this at the import-graph level.

## transactional-outbox

### Purpose

Outbound side effects (email send, webhook delivery) must not be lost when the originating transaction commits, and must not fire when the originating transaction rolls back. The outbox pattern makes side-effect dispatch a row written inside the same transaction; a separate worker then reads the outbox and performs the side effect with at-least-once semantics.

### Where it lives

- Mail: [src/infrastructure/mail/mail-outbox.schema.ts](src/infrastructure/mail/mail-outbox.schema.ts), [mail-outbox.repository.ts](src/infrastructure/mail/mail-outbox.repository.ts), [workers/mail-outbox-sweeper.processor.ts](src/infrastructure/mail/workers/mail-outbox-sweeper.processor.ts), [workers/mail.processor.ts](src/infrastructure/mail/workers/mail.processor.ts).
- Webhook delivery: [src/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery.repository.ts](src/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery.repository.ts), [webhook-delivery-attempt.repository.ts](src/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery-attempt.repository.ts), [workers/webhook-delivery.worker.ts](src/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-delivery.worker.ts).
- Stripe webhook events: [src/domains/billing/sub-domains/stripe-webhook/stripe-webhook-event.repository.ts](src/domains/billing/sub-domains/stripe-webhook/stripe-webhook-event.repository.ts) — inbound webhooks use the same idempotent-claim pattern as the outbox.

### Implementation

```mermaid
sequenceDiagram
  participant Svc as service
  participant DB as Postgres
  participant EB as event-bus (in-process)
  participant OB as outbox row
  participant W as worker
  participant Ext as Resend / customer webhook
  Svc->>DB: BEGIN
  Svc->>DB: write business row
  Svc->>OB: write outbox row (status=pending)
  Svc->>DB: COMMIT
  Svc->>EB: emit domain event (fire-and-forget)
  EB->>W: enqueueMail / enqueueWebhookDelivery
  W->>OB: claim row (pending → sending) — atomic
  W->>Ext: HTTP POST
  W->>OB: mark sent / failed (with attempt record)
```

- **Atomic claim**: the worker uses an `UPDATE ... WHERE status = 'pending' RETURNING id` to prevent two workers from claiming the same row.
- **Stuck-row reclaim**: the sweeper processor reclaims rows stuck in `sending` for longer than `STUCK_SENDING_LEASE_MINUTES` (15 min) so a crashed worker doesn't strand outbox rows forever.
- **DLQ**: failed deliveries with exhausted retries land in the per-queue `<name>-dlq` registered by [src/infrastructure/queue/dlq/](src/infrastructure/queue/dlq/).

### How to apply

- New outbound side effect: write the row inside the originating transaction, never enqueue from inside the transaction (Redis is not transactional with Postgres). The event-bus emission outside the transaction is the cue for the BullMQ enqueue.
- Inbound webhook receiver (Stripe-shaped): persist the inbound event with `status=processing` keyed on the provider's `event.id`, then run the work; if the same event arrives twice, the unique constraint rejects it. Reclaim leases via `STRIPE_WEBHOOK_STUCK_PROCESSING_LEASE_MINUTES`.

## import-paths

### Purpose

Keep imports stable when files move. Path aliases (`@/`, `@tooling/`) make cross-folder dependencies explicit and grep-friendly; parent-relative paths (`../`) break when folders are reorganized.

### Where it lives

- Rule: [`.cursor/rules/import-paths.mdc`](../.cursor/rules/import-paths.mdc)
- Aliases: [`tsconfig.json`](../tsconfig.json) — `@/*` → `src/*`, `@tooling/*` → `tooling/*`
- CI gate: [`src/tests/global/import-paths.global.test.ts`](tests/global/import-paths.global.test.ts)

### Implementation

- **`src/`**: cross-folder → `@/domains/...`, `@/shared/...`, `@/infrastructure/...`, `@/core/...`. Co-located layers in the same folder may use `./` (e.g. service → `./repository.js`).
- **`tooling/`**: cross-folder → `@tooling/setup/...`, `@tooling/openapi/...`, etc. Same-folder `./` only.
- Always use `.js` extensions in import specifiers (NodeNext).

### How to apply

- New file under `src/` or `tooling/`: import siblings with `./`; import anything outside the folder with the appropriate alias. Never `../`.
- IDE: `.vscode/settings.json` sets `typescript.preferences.importModuleSpecifier: "non-relative"` to match this policy.
