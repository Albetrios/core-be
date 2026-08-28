`src/domains/audit/`

# Audit

## Purpose

Append-only audit log of every security- and governance-relevant action that happens on the platform: who did it (actor), what they did (action), to what (resource), from where (IP, user-agent), with what severity, and any structured metadata. The domain owns the canonical write path used by the `audit-emission` cross-cutting pattern, and exposes a global-admin-only read API for forensic and compliance queries.

What it owns:

- The `audit.logs` table, its schema, and its retention policy, plus the `audit.outbox` transactional-outbox table and its drain worker (`audit-outbox-drain`).
- The write entry-point all other domains call: `recordScopedAuditEvent(request, …)` stages a row in `audit.outbox`; the drain worker resolves internal ids and inserts into `audit.logs` (the underlying `recordAuditEvent` wrapper swallows + logs failures).
- `GET /api/v1/audit/logs` — cross-tenant cursor-paginated listing (global `SUPER_ADMIN` / `ADMIN` only).
- Org-scoped listing is exposed from tenancy as `GET /api/v1/tenancy/organization/audit-logs` (`audit-log:read`); implemented by `AuditService.listForOrganization`.

What it does not own: deciding **when** to emit an audit event — that's the responsibility of each calling domain. Audit only enforces the shape, the durability, and the read contract.

## Key invariants

- **Append-only**: rows are never updated or deleted by the API. Hard-delete only happens via the retention worker after the retention window passes.
- **Best-effort writes**: an audit failure must not fail the originating HTTP request. Callers go through `recordAuditEvent(auditService, input, log)` from `@/shared/utils/infrastructure/audit-record.util.ts`, which catches and logs failures.
- **Outbox-staging RLS context** (audit R10): `AuditService.record` stages the row in `audit.outbox`, whose INSERT policy (`audit_outbox_tenant_isolation_insert`) has only two arms — an org arm (`organization_public_id = app.current_organization_public_id`) and a tenantless system arm (`organization_public_id IS NULL AND app.system_audit_insert = 'true'`); there is **no** user arm. So `record` opens the matching context per row: org-scoped rows under an org principal scope, tenantless rows (login, auth, admin, queue-dashboard) under `MAINTENANCE_SCOPE.system_audit_insert`. Without this the bare-pool INSERT is rejected under the production `core_be_app` role (FORCE/ENABLE RLS) and the row is silently dropped by `recordAuditEvent`. The staged row is its own short transaction — decoupled from the originating business write (which already committed in its own scoped context post-sec-M4) and best-effort.
- **Two read paths, two RLS contexts**: org listing runs in `withAppDatabaseContext` (org scope, `app.current_organization_public_id`); global admin listing runs under `MAINTENANCE_SCOPE.global_admin` (`app.global_admin = true`) so cross-tenant reads are explicit under FORCE RLS, not table-owner bypass.
- **Global admin gate**: `GET /api/v1/audit/logs` requires global `SUPER_ADMIN` or `ADMIN`. Org path requires `audit-log:read` on the target organization.
- **Per-route cap**: `GET /api/v1/audit/logs` carries `MODERATE_AUTHED_RATE_LIMIT` (30 req/60s keyed by user). The preset's `preHandler` hook is appended after `requireRole`, so a denied caller is rejected before its bucket key is derived and cannot consume an admin's quota. Pinned by `audit-routes-rate-limit.policy.unit.test.ts`.
- **Severity is a fixed set**: `INFO` (default), `WARNING` (denied/failed actions still worth recording), `CRITICAL` (global-admin lifecycle and security-incident events).
- **Outbox drain isolates poison rows** (sec-r7/M2): the drain processes a claimed batch in one transaction, but each row's `audit.logs` INSERT runs in a nested transaction (a SAVEPOINT). A row whose INSERT errors is rolled back to its savepoint and marked (transient until the `attempt_count` cap, then `FAILED`) while the rest of the batch still commits — a single poison row can no longer abort the batch and re-head the queue forever. After each pass the drain emits `audit.outbox.drain.backlog.stalled` when the oldest still-PENDING row exceeds the stale threshold.

## Sub-domains

`audit` is a flat domain — no `sub-domains/` folder. The single resource lives at the domain root (`audit.service.ts`, `audit.repository.ts`, `audit.routes.ts`, etc.). Per-symbol docs are in TSDoc on each export (use IDE hover or `pnpm tsdoc:check --report`).

## Patterns used

This domain implements the contracts documented in [src/PATTERNS.md](src/PATTERNS.md):

- `audit-emission` — the domain **is** this pattern's owner; other domains call into `AuditService.record()` (or the helper) to participate.
- `tenant-isolation` / `rls-context` — outbox-staging writes run under the org principal context for org-scoped rows or `MAINTENANCE_SCOPE.system_audit_insert` for tenantless rows, matching the two arms of the `audit.outbox` INSERT policy.
- `soft-delete` does **not** apply: audit rows are immutable until retention purges them.

## Cross-domain flows

Every cross-domain flow in [src/FLOWS.md](src/FLOWS.md) emits at least one audit row through this domain:

- `signup-flow`, `login-flow` — identity lifecycle events.
- `organization-invitation-flow` — invitation create/accept/cancel.
- `subscription-change-flow`, `dunning-flow` — billing state transitions.

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> recorded: AuditService.record()
  recorded --> retained: row visible until retention window
  retained --> purged: retention worker hard-deletes after window
  purged --> [*]
```

## Events

This domain neither emits nor consumes domain events. Audit is a pure write target — the `event-bus` is upstream of it.

## Failure modes

- **Unknown actor public id** → logged at `warn` (`audit.record.unknownActorUserPublicId`); no row written; originating request is unaffected.
- **DB write failure** → caught by `recordAuditEvent`, logged at `warn`; originating request is unaffected.
- **Read endpoint without global admin role** → 403; no information is leaked about whether the requested filter would have matched any rows.
