# RLS lock inventory

Architecture overview (scopes, layers, GUC catalog): [rls-architecture.md](rls-architecture.md).

Every automated lock that pins the database-context / RLS architecture. "Lock" means a
test or guard that fails when the invariant drifts — changing the invariant requires
editing the lock deliberately.

| Lock | File | What it pins |
| ---- | ---- | ------------ |
| Context directory standard | `src/tests/unit/infrastructure/database/context-directory-standard.policy.unit.test.ts` | `contexts/` holds exactly `database-context.ts` (the 3 scope patterns + registries) and `database-context-runtime.ts` (plumbing). New RLS access = new registry KIND, never a new file. |
| Principal-scope minting confinement | `src/tests/unit/infrastructure/database/principal-scope-minting.policy.unit.test.ts` | `createPrincipalDatabaseScope` is imported only by the confined minters (request minters, job minter, verified minter, the context module itself). |
| Verified-scope usage ledger | `src/tests/unit/infrastructure/database/verified-scope-usage.policy.unit.test.ts` | Every importer of the verified/provisioning minters is enumerated — a new import is a deliberate "I verified this identity myself" claim. |
| Job-minter path confinement | (describe block in the principal minting policy test) | Job scopes are minted only from worker-runtime code. |
| Session minting confinement | `src/tests/unit/infrastructure/database/session-context-confinement.policy.unit.test.ts` | `SESSION_SCOPE.<kind>(value)` factories are auth-domain-only. |
| Maintenance per-kind allowlists | `src/tests/unit/infrastructure/database/maintenance-context-confinement.policy.unit.test.ts` | Each `MAINTENANCE_SCOPE.<kind>` is referenced only from its allowlisted paths. |
| Table → required-scope map | `src/tests/unit/infrastructure/database/rls-table-scope-map.db.unit.test.ts` | Per FORCE-RLS table, the exact `app.*` GUC set its LIVE policies reference; every GUC must be registry-known (or a documented dead arm — currently none). |
| FORCE-RLS table set | `src/infrastructure/database/utils/force-rls-tables.constants.ts` + boot guard | The live database's FORCE-RLS tables match the intentional list exactly. |
| Worker DB import ban | `src/tests/unit/infrastructure/database/worker-database-guard.unit.test.ts` + `agent-os/hooks/guard-edits.sh` (R1) | Workers/processors never call `getRequestDatabase()` or import `database-context-runtime` (one documented exemption: `audit-outbox-drain.processor.ts`). |
| Network isolation in contexts | `src/tests/global/rls-context-network-isolation.global.test.ts` | No outbound I/O (Stripe/S3/Resend/fetch) inside `withPrincipalDatabaseContext` / `withSessionDatabaseContext` / `withMaintenanceDatabaseContext` / `withTransaction` callbacks. |
| No direct DB in services | `src/tests/global/no-direct-db-in-services.global.test.ts` | Services don't touch `database` / `sql` / `getRequestDatabase` — repositories own SQL. |
| No global-admin in tenancy | `src/tests/global/no-global-admin-in-tenancy.global.test.ts` | Tenancy domain code never uses `MAINTENANCE_SCOPE.global_admin`. |
| RLS boot safety | `src/infrastructure/database/safety/assert-database-rls-safety.ts` | `DATABASE_URL` must not connect as superuser / BYPASSRLS (would collapse RLS silently). |
| RLS behavior matrix | `src/tests/security/rls/**` (matrix, worker backstop, upload, discovery, outbox) | Cross-org/cross-user isolation observed against real Postgres as `core_be_app`. |
| Role taxonomy | `src/tests/unit/infrastructure/database/role-taxonomy.db.unit.test.ts` | The five `core_be_*` roles exist; only the operator may carry BYPASSRLS; `core_be_owner` owns every app table (drift lock — new tables need `OWNER TO core_be_owner`); membership edges; SECURITY DEFINER functions are never owner-owned (a non-exempt definer is FORCE-RLS-bound and returns zero rows). |
| Offboarding regressions | `src/tests/unit/infrastructure/database/rls-offboarding-regressions.db.unit.test.ts` | As `core_be_app`: user tombstone passes only under global_admin, org tombstone only under retention (sec-new-D3 gate held), retention sees users rows, drain resolvers work where plain selects stay blocked. |
| Permission-cache post-commit | `src/tests/unit/api/permission-cache-post-commit.policy.unit.test.ts` | Permission-cache invalidation is never called INSIDE a `withPrincipalDatabaseContext` callback (audit R11 — post-commit only; retargeted after the wrapper rename, previously vacuous). |
| Maintenance role posture | `src/tests/unit/infrastructure/database/maintenance-role.db.unit.test.ts` | `core_be_maintenance` exists, is never superuser/BYPASSRLS, and holds data-plane grants (provisioning: [maintenance-database-role runbook](../../deployment/runbooks/maintenance-database-role.md)). |

| Nightly RLS parity canary | `.github/workflows/scheduled-rls-parity.yml` | The DB suites re-run every night under the PRODUCTION role posture (operator fixtures, RLS-subject maintenance pool, `SET LOCAL ROLE core_be_app`) — regressions that only bite RLS-subject roles open a `ci-failure` issue by morning. |

## Owner-decision backlog (not yet locked)

- **Bypass arm role-tightening** — after every hosted environment provisions
  `DATABASE_MAINTENANCE_URL` (runbook above), a migration adds
  `current_user = 'core_be_maintenance'` to the bypass policy arms.
- **pgaudit / DDL event triggers** — requires provider-level extension support; evaluate
  per environment.
