# Maintenance database role (`core_be_maintenance`)

Maintenance (RLS-bypass) database contexts — `withMaintenanceDatabaseContext` with a
`MAINTENANCE_SCOPE.<kind>` in
[`src/infrastructure/database/contexts/database-context.ts`](../../../src/infrastructure/database/contexts/database-context.ts)
— can run on a **dedicated connection pool** with its own Postgres role, so bypass
authority becomes a connection-level property instead of a GUC-only one.

## Current state (groundwork shipped, gating not yet enforced)

- Migration `20260827010000_core_be_maintenance_role.sql` creates `core_be_maintenance`
  **NOLOGIN** with data-plane grants mirroring `core_be_app`.
- Migration `20260827020000_maintenance_role_policy_access.sql` extends the six
  role-scoped `*_app_access` system-table policies to both application roles (without it a
  maintenance-pool connection hits `deny_all` on the mail outbox / Stripe ledger / DLQ
  ledger) and grants `core_be_app` membership so `SET LOCAL ROLE core_be_app` tooling
  keeps working on maintenance connections.
- **Local development is provisioned**: the compose Postgres role has LOGIN and the
  gitignored local env file carries `DATABASE_MAINTENANCE_URL` — local runs and the DB
  test suites exercise maintenance contexts as `core_be_maintenance` (production-like RLS
  instead of the superuser-exempt pool). Hosted environments are NOT yet provisioned.
- `DATABASE_MAINTENANCE_URL` (optional env var) selects the pool: unset → maintenance
  contexts use the shared `DATABASE_URL` pool exactly as before; set → they use a lazy
  second pool built from the same tuned options
  ([`connection.ts`](../../../src/infrastructure/database/connection.ts) →
  `getMaintenanceDatabase()`).
- Bypass policy arms still accept the `app.*` GUCs from any role. Tightening is the
  final step below.

## Operator steps (per environment)

1. Enable login for the role on the environment's Postgres (Neon: create the role via
   the console/CLI or run as the elevated migration user):

   ```sql
   ALTER ROLE core_be_maintenance LOGIN PASSWORD '<generated>';
   ```

2. Set `DATABASE_MAINTENANCE_URL` for the environment (same host/database as
   `DATABASE_URL`, user `core_be_maintenance`), e.g. in `.env.<environment>` +
   `pnpm github:sync`.

3. Deploy and verify workers: retention/cleanup jobs must keep succeeding (they now run
   on the maintenance pool).

4. **Only after every hosted environment has completed 1–3**: ship the arm-tightening
   migration adding `current_user = 'core_be_maintenance'` to the bypass policy arms
   (`app.global_retention_cleanup`, `app.session_retention_cleanup`, `app.global_admin`,
   `app.system_audit_insert`, `app.audit_outbox_drain`) and update the
   `rls-table-scope-map` expectations. From then on a compromised `core_be_app`
   connection cannot use a bypass GUC at all.

## Local parity provisioning (all roles)

Local mirrors live: migration `20260827050000` creates `core_be_owner` /
`core_be_migrator` / `core_be_operator` and moves table ownership to the owner group.
Local provisioning (once, as the compose superuser):

```sql
ALTER ROLE core_be_app LOGIN PASSWORD '<generated>';
ALTER ROLE core_be_operator LOGIN BYPASSRLS PASSWORD '<generated>';
ALTER ROLE core_be_migrator LOGIN CREATEROLE PASSWORD '<generated>';
```

Then the gitignored local env file carries `DATABASE_URL` as `core_be_app` (runtime
parity), `DATABASE_OPERATOR_URL` as `core_be_operator` (harness + full/bulk seeds pick
it up automatically), and `DATABASE_MAINTENANCE_URL` as `core_be_maintenance`.
`DATABASE_MIGRATION_URL` points at `core_be_migrator` for day-to-day migrations; the
compose superuser is needed ONLY for a fresh clone's very first `pnpm db:migrate`
(before the roles exist) and is otherwise used by nothing. `DATABASE_OPERATOR_URL` is
NEVER set in hosted environments.

## Fresh database / recreate provisioning (disaster or reset)

Migrations are the complete source of truth from zero — schemas, tables, every
FORCE-RLS policy, the five roles, ownership, and grants all materialize from one
cold `pnpm db:migrate` (proven by the local scratch rebuild and the nightly CI
canary). A deleted-and-recreated database therefore needs exactly three steps:

1. **Bootstrap migrate** — `DATABASE_MIGRATION_URL` must point at the provider's
   elevated user for the FIRST run (`core_be_migrator` does not exist until the
   migrations create it). On Neon a recreated database usually means a new host:
   update `DATABASE_URL` / `DATABASE_MIGRATION_URL` secrets (direct host, no
   `-pooler`, for the migration URL).
2. **Re-enable logins** — migrations create every role `NOLOGIN` (passwords are
   per-environment secrets, never in committed SQL). Re-run the `ALTER ROLE …
   LOGIN PASSWORD` steps above for whichever roles the environment's URLs use,
   then `pnpm github:sync` any changed secrets.
3. **Data** — reference data returns via `pnpm db:seed`; tenant/billing rows do
   not, and external state (e.g. Stripe customers pointing at vanished internal
   rows) needs reconciliation. Treat recreate as a provisioning event, not a
   redeploy.

## Nightly CI parity canary

`.github/workflows/scheduled-rls-parity.yml` re-runs the DB suites every night with this
exact role posture provisioned in CI (operator fixtures, RLS-subject maintenance pool,
`SET LOCAL ROLE core_be_app` suites) — a policy/plan regression that only bites
RLS-subject roles opens a `ci-failure` issue by morning instead of surfacing at deploy.

## Related

- Bypass-kind registry + per-path usage allowlists:
  `MAINTENANCE_CONTEXTS` in `database-context.ts`,
  `src/tests/unit/infrastructure/database/maintenance-context-confinement.policy.unit.test.ts`
- Per-table policy GUC lock:
  `src/tests/unit/infrastructure/database/rls-table-scope-map.db.unit.test.ts`
