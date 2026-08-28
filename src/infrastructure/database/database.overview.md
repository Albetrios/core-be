`src/infrastructure/database/`

# Database infrastructure

## Purpose

Postgres connection management, the abstract `BaseRepository` (with cursor pagination), the transactional helpers, the migration runner, the shared `pgSchema` definitions, and the **context family** that owns the platform's RLS contract — `withAppDatabaseContext` (minted identity scope), `withAppDatabaseContext` (pre-auth session artifacts), and `withMaintenanceDatabaseContext` (kind-dispatched bypass scopes: `MAINTENANCE_SCOPE.GLOBAL_ADMIN`, `global_retention_cleanup`, `session_retention_cleanup`, `system_audit_insert`, `audit_outbox_drain`, `system_table_retention`, `system_table_worker`). Domains never construct Drizzle clients themselves; they receive a `databaseHandle` from one of these contexts.

## Design decisions

- **Postgres over alternatives**: chosen for transactional guarantees, RLS, mature operational tooling, and the Drizzle ORM's typed query DSL. Multi-region failover is handled by the managed provider (Neon / RDS).
- **Drizzle 0.45 + the `postgres` 3.x driver**: `postgres` driver chosen over `pg` for native prepared-statement support, simpler connection-pool semantics, and much better performance under load.
- **`snake_case` column names everywhere**: enforced by convention; matches Postgres native style and avoids the case-folding pitfalls of mixed identifiers.
- **RLS is the defense-in-depth layer**: every tenant-scoped table has an RLS policy. The application is expected to filter by `organization_id`; RLS is what prevents a bug from leaking rows across tenants.
- **Context family pattern**: instead of per-call `SET LOCAL`, contexts open a Drizzle transaction, set the GUC once, and pass a pinned `databaseHandle` to a callback. Reuse semantics: a worker context inside an HTTP request (or vice versa) for the same organization reuses the active handle (no nested top-level transaction, no lost `SET LOCAL`).
- **A context grants only what a policy names**: each wrapper sets exactly one GUC, and grants access only on tables whose policies test it. `app.current_organization_public_id` → tenant-scoped tables; `app.current_user_public_id` → user-owned rows **and** the tenancy discovery policies; `app.global_admin` → **`auth.*` and `audit.logs` only**; `app.global_retention_cleanup` → retention sweeps. Notably `MAINTENANCE_SCOPE.GLOBAL_ADMIN` grants **nothing on `tenancy.*`** — no tenancy policy carries that arm, so it reads zero rows there rather than erroring. Full matrix and rationale in [src/PATTERNS.md](src/PATTERNS.md#rls-context); pinned by `no-global-admin-in-tenancy.global.test.ts` and `tenancy-global-admin-invisibility.security.test.ts`.
- **Cross-context user lookups go through SECURITY DEFINER resolvers**: `auth.users` is FORCE RLS and self-scoped, so a direct join from org context (or a post-commit path with no GUC) matches zero rows. Use `auth.resolve_user_id_by_public_id`, `auth.resolve_user_by_internal_id`, or `auth.resolve_user_public_ids_by_ids` instead.
- **Workers cannot use HTTP request DB context**: enforced by [contexts/worker-database-guard.util.ts](src/infrastructure/database/contexts/worker-database-guard.util.ts) and by global tests that scan `*.worker.ts` / `*.processor.ts` imports.
- **Connection budget**: [assert-connection-budget.ts](src/infrastructure/database/safety/assert-connection-budget.ts) caps the per-process pool size against the managed Postgres tier limits.
- **RLS role safety**: [assert-database-rls-safety.ts](src/infrastructure/database/safety/assert-database-rls-safety.ts) refuses to boot in hosted deployments when `DATABASE_URL` resolves to a superuser or a `BYPASSRLS` role. PostgreSQL skips RLS (even `FORCE`d) for those roles, so a misconfigured connection string would silently collapse tenant isolation. Local docker-compose still tolerates the default `postgres` superuser (warn-only).
- **TLS verification safety**: [assert-database-tls-safety.ts](src/infrastructure/database/safety/assert-database-tls-safety.ts) refuses to boot in hosted deployments unless the Postgres client verifies the server certificate (`sslmode=verify-ca`/`verify-full` or `DATABASE_SSL_REJECT_UNAUTHORIZED=true`). Neon's common `sslmode=require` encrypts but does not validate the chain (MITM exposure). The SSL-mode parsing/strictness helpers live in [connection-url.util.ts](src/infrastructure/database/utils/connection-url.util.ts) (a side-effect-free module reused by the connection pool, the migration runner, and this assertion).
- **Migration runner requires a direct (non-pooler) endpoint**: [migration/migrate.ts](src/infrastructure/database/migration/migrate.ts) fails fast when `DATABASE_MIGRATION_URL` is a pooler (`-pooler` host or `?pgbouncer=true`), because the session-level `pg_advisory_lock` that serializes concurrent deploys is not pinned to one backend through a transaction-mode pooler.
- **Force-RLS table list** at [force-rls-tables.constants.ts](src/infrastructure/database/utils/force-rls-tables.constants.ts): the migration linter rejects new tables that should be RLS-eligible but aren't in the list.

## Operational concerns

- **Three timeouts, three failures — none substitutes for another** (all set as connection parameters): `statement_timeout` (`DATABASE_STATEMENT_TIMEOUT_MS`, HTTP override `DATABASE_HTTP_STATEMENT_TIMEOUT_MS`) kills a runaway query; `idle_in_transaction_session_timeout` (`DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS`) kills an abandoned transaction; `lock_timeout` (`DATABASE_LOCK_TIMEOUT_MS`, default 3000) bounds a statement **waiting behind someone else's lock**. A lock waiter is neither idle nor executing, so only `lock_timeout` bounds it — yet it holds its pooled connection for the whole wait, which is how lock contention turns into pool exhaustion. The statement layers accept `0` (disabled); the idle and lock timeouts enforce a `1000` floor so one misconfiguration cannot silently remove the ceiling. Worker transactions lift both HTTP-tuned caps with `SET LOCAL` (`DATABASE_WORKER_STATEMENT_TIMEOUT_MS`, `DATABASE_WORKER_LOCK_TIMEOUT_MS`) — background work has a 5-minute statement budget and retries safely, so a 3s lock give-up would only churn the DLQ. Set them in the **server parameter group** too — anything connecting outside the app's own path (migration runner, ops scripts) otherwise has no bound.
- **Pool sizing**: `DATABASE_POOL_SIZE` env. The `assert-connection-budget` helper warns at startup when the configured size exceeds the budget.
- **Checkout observability**: [organization-rls-checkout-counter.ts](src/infrastructure/database/pool/organization-rls-checkout-counter.ts) tracks in-flight org-scoped RLS checkouts (both the `withAppDatabaseContext` unit-of-work and the legacy request-pinned transaction). It feeds the pool-exhaustion alerter and the `database_rls_active_checkouts` gauge + `database_rls_checkout_hold_seconds` histogram (see [observability runbook](docs/deployment/runbooks/observability.md)) so checkout starvation and over-long holds are caught before requests queue.
- **Append-heavy table retention**: `audit.logs` and `notify.notifications` are plain (non-partitioned) tables. Growth is bounded by row-level retention workers (`audit-retention`, `notification-retention`) that batch-`DELETE` rows older than their configured retention window, backed by the `created_at` indexes.
- **Migrations** live under [migrations/](migrations/) at repo root; the runner is `pnpm db:migrate`. The lint check is `pnpm db:migrate:lint`.

## External dependencies

- **Postgres 16+** — production runs against managed Postgres. Local dev uses Docker Compose.

## Tuning parameters

- `DATABASE_URL`, `DATABASE_POOL_SIZE`, `DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_RLS_SCOPED_CONTEXTS` (feature flag for the scoped-context model).

## Failure modes

- **Postgres unavailable** → connection probe fails; readiness `/readyz` returns 503; load balancer yanks traffic.
- **RLS GUC missing or wrong for the table** (a worker that skipped a context wrapper, or code that picked a context whose GUC no policy on that table tests) → the access is treated as cross-tenant: reads return zero rows, writes fail their `WITH CHECK` with SQLSTATE 42501. There is no error on the read path — it simply looks like "no data". **The default test suite cannot catch this**: `docker-compose.yml` and every CI workflow connect as `POSTGRES_USER: core`, a container superuser that bypasses RLS wholesale, whereas deployed environments connect as a dedicated `NOBYPASSRLS` login role (`<environment>_app_login`) that inherits its DML from the `NOLOGIN` `core_be_app` role via `GRANT core_be_app TO …` — see the [runtime-role runbook](docs/deployment/runbooks/resource-limits.md). Cover such paths with a test that runs as `core_be_app` (see `src/tests/security/rls/`, or the `useApplicationDatabaseRole` option on `withMaintenanceDatabaseContext`).
- **Long-running query** → statement timeout fires; the query is killed and the request returns 5xx.
- **Multi-region replica lag** → the managed provider routes reads; this module does not split read/write.

## Related runbooks

- Postgres failover procedure (managed-provider docs).
- Migration replay / dry-run: `pnpm db:migrate:dry-run` and `pnpm db:migrate:lint`.
