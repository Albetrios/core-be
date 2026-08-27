# RLS architecture — scopes, layers, and GUCs

The single reference for how Row-Level Security works in core-be after the
principal-database-context overhaul (PR #1123): what exists, how it evolved from the old
wrapper family, the layer model, and exactly which `app.*` GUC each query runs under.

Related: [rls-lock-inventory.md](rls-lock-inventory.md) (the automated locks) ·
[maintenance-database-role runbook](../../deployment/runbooks/maintenance-database-role.md) ·
`src/infrastructure/database/contexts/database-context.ts` (the code).

---

## 1. The model in one paragraph

Every tenant- or user-owned table is `ENABLE + FORCE ROW LEVEL SECURITY`. Policies read
transaction-scoped Postgres session variables (**GUCs**, set via
`set_config('app.…', value, true)` — they die with the transaction). Code can only set
those GUCs by entering a **database context**, and a context can only be entered with an
**unforgeable scope** minted at a trust boundary. There are exactly **three scope
patterns** — principal (who), session (pre-auth artifact), maintenance (bypass) — living
in exactly **two files**, and the connection itself is an RLS-subject role
(`core_be_app` in production; `core_be_maintenance` for bypass contexts once
provisioned), so nothing short of a policy arm grants a row.

---

## 2. Old → new — what changed and why

### 2.1 Wrapper evolution

| Era | Shape | Problem |
| --- | ----- | ------- |
| **Old** (pre-overhaul) | 9+ ad-hoc wrappers, one file each: `withOrganizationContext`, `withOrganizationDatabaseContext`, `withUserDatabaseContext`, `withGlobalRetentionCleanupDatabaseContext`, `withSessionRetentionCleanupDatabaseContext`, `withGlobalAdminDatabaseContext`, `withSystemAuditInsertContext`, `withSystemTableWorkerContext`, `withSystemTableRetentionContext` | Any code could call any wrapper with any string (forgeable authority); every new need added a new file/wrapper; no registry of what a bypass grants; untrackable |
| **Transitional** (phases 1–7.5) | Three pattern files: `principal-database.context.ts`, `session-database.context.ts`, `maintenance-database.context.ts`; legacy wrappers migrated in, then deleted | — |
| **New** (current, A5) | **Two files**: `database-context.ts` (all three patterns + registries + the common `withDatabaseContext(scope)` dispatcher) and `database-context-runtime.ts` (plumbing: ALS storages, worker asserts, timeout lift, handle guards) | Locked by `context-directory-standard.policy.unit.test.ts` — a new file in `contexts/` fails the build |

### 2.2 Old wrapper → new call, one-to-one

| Old call | New call |
| -------- | -------- |
| `withOrganizationContext(orgId, cb)` / `withOrganizationDatabaseContext(orgId, cb)` | `withPrincipalDatabaseContext(scope, cb)` — scope minted by `resolvePrincipalDatabaseScope(request)` (HTTP), `resolveOrganizationJobScope(organizationPublicId)` (worker), or `resolveVerifiedOrganizationPrincipalScope(organizationPublicId)` (verified/port flows) |
| `withUserDatabaseContext(userId, cb)` | `withPrincipalDatabaseContext(scope, cb)` — `requireUserPrincipalDatabaseScope(request)`, `resolveUserJobScope(userPublicId)`, or `resolveVerifiedUserPrincipalScope(userPublicId)` |
| `withGlobalRetentionCleanupDatabaseContext(cb)` | `withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_retention_cleanup, cb)` |
| `withSessionRetentionCleanupDatabaseContext(cb)` | `withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.session_retention_cleanup, cb)` |
| `withGlobalAdminDatabaseContext(cb)` | `withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_admin, cb)` |
| `withSystemAuditInsertContext(cb)` | `withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.system_audit_insert, cb)` |
| `withSystemTableRetentionContext(cb)` | `withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.system_table_retention, cb)` |
| `withSystemTableWorkerContext(cb)` | `withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.system_table_worker, cb)` |
| (pre-auth session lookups, raw) | `withSessionDatabaseContext(createSessionDatabaseScope(kind, value), cb)` |

The key upgrade: the first argument is no longer a string anyone can fabricate — it is a
**branded scope object** whose factories are confined to allowlisted files by policy
tests. Holding a scope IS the authority.

---

### 2.3 Name evolution (GUCs and roles)

| Old | New | Why |
| --- | --- | --- |
| `app.current_organization_id` | `app.current_organization_public_id` | the GUC carries a PUBLIC id (`org_…`), never the internal bigserial — the name now says so (migration `20260827060000`, all 30 policies ALTERed) |
| `app.current_user_id` | `app.current_user_public_id` | same reasoning (`usr_…`) |
| `app.current_session_refresh_token_hash` | *(removed)* | dead policy arm no code ever set — dropped by the InitPlan-hygiene migration |
| local superuser runtime (`core`) | `core_be_app` login | local↔live parity: `pnpm dev` now connects RLS-subject exactly like production |
| implicit superuser fixtures | `core_be_operator` (BYPASSRLS, local/CI only) | fixture power is a named, auditable role instead of a superuser side effect |
| "provider superuser" mental model | `core_be_owner` NOLOGIN group + `core_be_migrator` | ownership and DDL authority are named roles; managed Postgres has no true superusers anyway |

**Naming symmetry (end-to-end, no translation anywhere):** scope field
`organizationPublicId` → GUC `app.current_organization_public_id` → policy compares
`public_id`. The same string flows token/payload → minter (adds provenance only) →
`set_config` → policy arm; internal ids never enter scopes or GUCs (policies translate
public→internal inside the arm where an FK column needs it).

## 3. Layers — text diagram

```text
┌────────────────────────────── TRUST BOUNDARIES (scopes are MINTED here) ─────────────────────────────┐
│                                                                                                      │
│  HTTP request (JWT verified)          Worker job (payload)             Verified/port flows           │
│  ─ resolvePrincipalDatabaseScope      ─ resolveOrganizationJobScope    ─ resolveVerified*Principal-  │
│    (org REQUIRED, from `org` claim)     (organizationPublicId in         Scope (caller already       │
│  ─ requireUserPrincipalDatabaseScope    the job payload)                 authenticated the id:       │
│    (user REQUIRED, org optional —     ─ resolveUserJobScope              invite flow, Stripe event,  │
│    self-heal transitional state)        (userPublicId in payload)        provisioning, admin)        │
│                                                                                                      │
│  Pre-auth session artifact:           Static bypass authority:                                       │
│  ─ createSessionDatabaseScope         ─ MAINTENANCE_SCOPE.<kind>  (frozen singletons — nothing to    │
│    (auth domain ONLY)                    mint; per-file usage allowlists)                            │
└───────────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                                │  scope (branded, unforgeable)
                                                ▼
┌──────────────────────────── PATTERN LAYER  (contexts/database-context.ts) ───────────────────────────┐
│                                                                                                      │
│   withDatabaseContext(scope, cb)   ← ONE common dispatcher (scope.source → principal;                │
│                                      scope.kind ∈ MAINTENANCE_CONTEXTS → maintenance; else session)  │
│        │                                                                                             │
│        ├── withPrincipalDatabaseContext(scope, cb)      identity GUCs (org and/or user)              │
│        ├── withSessionDatabaseContext(scope, cb)        one session-artifact GUC (kind-dispatched)   │
│        └── withMaintenanceDatabaseContext(scope, cb)    one bypass GUC = 'true' (registry-dispatched)│
│                                                                                                      │
│   Registries (single source of truth):                                                               │
│     MAINTENANCE_CONTEXTS  { kind → guc | null, opensTransaction, workerContextKind,                  │
│                             appliesWorkerStatementTimeout, grants }                                  │
│     SESSION_CONTEXTS      { kind → guc }                                                             │
└───────────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                                │
                                                ▼
┌──────────────────────────── RUNTIME LAYER  (contexts/database-context-runtime.ts) ───────────────────┐
│  ─ opens ONE transaction on the right pool (shared pool; maintenance pool when                       │
│    DATABASE_MAINTENANCE_URL is provisioned)                                                          │
│  ─ SET LOCAL statement/lock timeouts (worker budget, bulk kinds only)                                │
│  ─ set_config('app.…', value, true)   ← transaction-scoped; dies at COMMIT/ROLLBACK                  │
│  ─ pins the handle in AsyncLocalStorage (getRequestDatabase() resolves to it;                        │
│    worker runtime THROWS on unpinned access)                                                         │
│  ─ checkout accounting → database_rls_active_checkouts / _hold_seconds metrics                       │
└───────────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                                │  same handle, same connection
                                                ▼
┌────────────────────────────────────────── POSTGRES ──────────────────────────────────────────────────┐
│  Connection role: core_be_app (HTTP/worker) · core_be_maintenance (bypass pool) — both RLS-SUBJECT,  │
│  never superuser/BYPASSRLS (boot guards fail closed in hosted deployments)                           │
│                                                                                                      │
│  FORCE-RLS policies read the GUCs:  USING (read/lock old row) + WITH CHECK (new row)                 │
│  wrapped as ( SELECT current_setting(...) ) → planner hoists to an InitPlan (once per statement)     │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Rules the layers enforce:

- **Repositories never pick a context.** They receive a pinned handle (ALS or explicit
  `databaseHandle`) — services/controllers/workers decide the scope.
- **Workers must be pinned.** `getRequestDatabase()` throws in worker runtime without a
  context; workers may not import the runtime module (one documented exemption:
  `audit-outbox-drain.processor.ts`).
- **Network I/O never runs inside a context callback** (Stripe/S3/Resend) — enforced by
  the network-isolation global test.

---

## 4. GUC catalog — which apply, who sets them, when

Identity GUCs carry **dynamic per-request values**; bypass GUCs are **static `'true'`
switches** whose authority is the frozen scope singleton + per-file allowlist.

| GUC | Pattern / setter | Value | Set when |
| --- | ---------------- | ----- | -------- |
| `app.current_organization_public_id` | Principal | org **public id** (dynamic, from the JWT `org` claim / job payload / verified id) | scope carries `organizationPublicId` |
| `app.current_user_public_id` | Principal | user **public id** (dynamic) | scope carries `userPublicId` |
| `app.current_session_public_id` | Session (`kind: public_id`) | session public id (dynamic) | pre-auth session lookup by public id |
| `app.current_session_token_hash` | Session (`kind: token_hash`) | token hash (dynamic) | pre-auth session lookup by token hash |
| `app.global_retention_cleanup` | Maintenance | `'true'` | retention/tombstone workers, offboarding reconcilers, the org tombstoning step |
| `app.session_retention_cleanup` | Maintenance | `'true'` | session-cleanup worker |
| `app.global_admin` | Maintenance | `'true'` | admin user reads/suspend/soft-delete, admin audit listing, drain user resolution, DLQ-replay actor lookup |
| `app.system_audit_insert` | Maintenance | `'true'` | tenantless `audit.outbox`/`audit.logs` INSERTs |
| `app.audit_outbox_drain` | Maintenance | `'true'` | audit-outbox drain worker (exclusive SELECT/UPDATE/DELETE on `audit.outbox`) |
| *(none)* — `system_table_retention` / `system_table_worker` | Maintenance (`guc: null`) | — | non-RLS system tables (mail outbox, Stripe ledger, DLQ ledger); the kinds exist for ALS pinning + transaction/timeout tuning only |

Removed: `app.current_session_refresh_token_hash` — a policy arm no code ever set (dead
arm, dropped by the InitPlan-hygiene migration; the scope-map test keeps the dead-arm
ledger at zero).

### 4.1 Dynamic resolution — how a query gets its GUCs

```text
request → controller mints scope ─┐
                                  ├─ withPrincipalDatabaseContext(scope, cb)
job → worker-runtime mints scope ─┘        │
                                           ▼
                     one SELECT set_config(...), set_config(...)   ← ONE round trip,
                     exactly the GUCs the scope carries:              never more
                       org-only scope  → app.current_organization_public_id
                       user-only scope → app.current_user_public_id
                       both            → both
                                           │
                     reuse branches (no second checkout):
                       same-org nested call        → reuse pinned handle as-is
                       user-only inside pinned tx  → layer ONLY app.current_user_public_id
                                                     onto the outer handle (FK atomicity
                                                     for OAuth find-or-create)
```

- The wrapper can set **only** the two identity keys — `buildIdentityGucStatement` is the
  single place they are named.
- Maintenance/session wrappers set exactly **one** GUC, dispatched from their registry
  row — code never passes a GUC name.
- Everything is `SET LOCAL`-scoped: the moment the transaction ends, the connection
  returns to the pool with **zero** GUCs armed. A pooled connection can never leak a
  previous request's identity.

---

## 5. Which tables read which GUCs (summary)

Authoritative, live-verified map: `rls-table-scope-map.db.unit.test.ts` (asserts against
`pg_policies` on the migrated database). Condensed view:

| Table group | GUC arms on its policies |
| ----------- | ------------------------ |
| Tenant-scoped (`tenancy.*` children, `billing.subscriptions`, `notify.*`, org-scoped `upload.uploads`, org-scoped `audit.logs`/`outbox` arms) | `app.current_organization_public_id` + `app.global_retention_cleanup` |
| User-owned (`auth.users`†, `auth.auth_methods`†, MFA/WebAuthn/settings/preferences/exports, personal uploads, user notifications) | `app.current_user_public_id` (+ `app.global_admin`†, + `app.global_retention_cleanup` where retention prunes) |
| `auth.sessions` | `app.current_user_public_id`, `app.current_session_public_id`, `app.current_session_token_hash`, `app.session_retention_cleanup` |
| `audit.logs` | org arm, `app.current_user_public_id` (own-actions export), `app.global_admin`, `app.global_retention_cleanup`, `app.system_audit_insert` |
| `audit.outbox` | org arm + `app.system_audit_insert` (INSERT); `app.audit_outbox_drain` (SELECT/UPDATE/DELETE — drain-exclusive) |
| System tables (`auth.mail_outbox`, `billing.stripe_webhook_events`, `billing.plans`, tombstones, `audit.dead_letter_jobs`, `tenancy.permissions`, `auth.verification_tokens`) | no GUC — role-scoped `*_app_access` policies (`core_be_app`, `core_be_maintenance`) or `USING (true)` |

† `tenancy.organizations` / `tenancy.api_keys` deliberately have **no** `global_admin`
arm — cross-tenant admin/system reads go through narrow `SECURITY DEFINER` resolver
functions (`audit.resolve_*_ids_for_public_ids`) instead of widening the bypass.

---

## 5.5 Quick reference — scopes, contexts, minters, kinds

| Pattern | Scope type | Minted by (per-file confined) | Context call |
| --- | --- | --- | --- |
| Principal | `OrganizationPrincipalDatabaseScope` (org required, user optional) | `resolvePrincipalDatabaseScope(request)` · `resolveOrganizationJobScope(organizationPublicId)` · `resolveVerifiedOrganizationPrincipalScope(organizationPublicId)` | `withPrincipalDatabaseContext` |
| Principal | `UserPrincipalDatabaseScope` (user required, org optional — self-heal surface) | `requireUserPrincipalDatabaseScope(request)` · `resolveUserJobScope(userPublicId)` · `resolveVerifiedUserPrincipalScope(userPublicId)` | `withPrincipalDatabaseContext` |
| Session | `SessionDatabaseScope` — kinds `public_id` \| `token_hash` | `createSessionDatabaseScope(kind, value)` (auth domain only; token values are pre-hashed) | `withSessionDatabaseContext` |
| Maintenance | `MaintenanceDatabaseScope` — 7 frozen singletons: `global_retention_cleanup`, `session_retention_cleanup`, `global_admin`, `system_audit_insert`, `audit_outbox_drain`, `system_table_retention`, `system_table_worker` | nothing to mint — `MAINTENANCE_SCOPE.<kind>` | `withMaintenanceDatabaseContext` |
| (any) | `DatabaseScope` union | — | `withDatabaseContext(scope, cb)` — the one common dispatcher |

Provenance (`scope.source`): `token` = authenticated HTTP request · `job` = validated
BullMQ payload · `provisioning` = the caller itself verified the id (invite flow,
Stripe event mapping, admin, signup provisioning) — ledgered per importer by
`verified-scope-usage.policy.unit.test.ts`.

## 6. Postgres semantics that shaped the design (learned the hard way)

1. **An UPDATE's NEW row must stay SELECT-visible** whenever the statement reads the
   table (a column-referencing WHERE is enough). Consequence: a soft-delete cannot run
   under a scope whose SELECT arm hides deleted rows — user tombstoning runs under
   `global_admin`, org tombstoning under `global_retention_cleanup` (whose arm is in the
   org policy's WITH CHECK too). The sec-new-D3 gate (stale org claims cannot read
   deleted orgs) stays intact.
2. **`INSERT … RETURNING` applies SELECT-policy visibility to the returned row.**
   `audit.outbox` staging therefore uses a plain INSERT with an affected-count guard —
   its SELECT is drain-exclusive by design.
3. **A `FOR UPDATE SKIP LOCKED` subquery in `FROM` can be rescanned** by a nested-loop
   plan, locking `limit` MORE rows per rescan. Claim queries use
   `WITH … AS MATERIALIZED` so the locking scan executes exactly once.
4. **InitPlan hygiene:** every `current_setting(...)` in a policy is wrapped as
   `( SELECT current_setting(...) )` so the planner evaluates it once per statement, not
   once per row.
5. **Superuser masking:** none of the above is visible on a superuser connection —
   which is why local dev provisions the RLS-subject `core_be_maintenance` pool, the
   regression suite runs `SET LOCAL ROLE core_be_app`, and boot guards refuse
   superuser/BYPASSRLS on both URLs in hosted deployments.

---

## 7. Roles and pools — the five-role taxonomy (local mirrors live)

Postgres note: "role" and "user" are the same object — `CREATE USER` is just
`CREATE ROLE … LOGIN`. `core_be_owner` is a pure NOLOGIN group; the other four gain
LOGIN when provisioned and act as connection users.

| Role | Connects via | RLS posture | Purpose |
| ---- | ------------ | ----------- | ------- |
| `core_be_owner` | never (NOLOGIN group) | subject (FORCE binds owners) | owns every app schema/table/sequence — DDL + TRUNCATE authority lives here; migrator/operator act through membership |
| `core_be_migrator` | `DATABASE_MIGRATION_URL` (local + the hosted slot; the bootstrap superuser is needed ONLY for a fresh clone's first migrate, before the roles exist) | subject | migrations/DDL (owner-member, `CREATEROLE`, ledger read/write) |
| `core_be_app` | `DATABASE_URL` | **subject** | ALL runtime traffic — local `pnpm dev` now connects as it too (production parity; boot logs `rls_safety.ok` locally) |
| `core_be_maintenance` | `DATABASE_MAINTENANCE_URL` | **subject** | maintenance (bypass) contexts — authority comes only from the GUC arms, never the connection |
| `core_be_operator` | `DATABASE_OPERATOR_URL` (**local/CI only — never hosted**) | **BYPASSRLS** | test-harness fixtures, full/bulk seeds, ops scratch; owner-member + member of app/maintenance so suites can `SET LOCAL ROLE core_be_app` to exercise real policies |

Locks: `role-taxonomy.db.unit.test.ts` pins the role set, non-superuser/non-BYPASSRLS
posture (operator excepted), the owner's table-ownership sweep (drift lock — new tables
must `ALTER TABLE … OWNER TO core_be_owner`), and membership edges.

**SECURITY DEFINER nuance (empirically proven):** a definer function executes as its
OWNER, and FORCE RLS binds a non-exempt owner — so resolver functions are deliberately
NOT owned by `core_be_owner` (they would silently return zero rows). They stay owned by
the per-environment elevated role: local `core` (superuser) / hosted provider owner
(BYPASSRLS via the provider's elevated grant). Verify resolver behavior after
provisioning any new hosted environment.

End-state (operator-gated): after every hosted environment provisions the maintenance
URL, a migration adds `current_user = 'core_be_maintenance'` to the bypass arms — bypass
authority then requires the dedicated **connection**, not just a GUC, so a compromised
`core_be_app` session cannot use any bypass at all.

---

## 8. Bug ledger — what RLS-subject execution caught before first deployment

All eight were pre-existing, invisible on a superuser connection, and each is pinned by
an as-`core_be_app` (or maintenance-role) regression:

| # | Bug (production impact) | Fix |
| - | ----------------------- | --- |
| 1 | `audit.outbox` staging silently dropped — `INSERT … RETURNING` requires SELECT-policy visibility and outbox SELECT is drain-only | plain INSERT + affected-count guard |
| 2 | Outbox claim escalated past its LIMIT — nested-loop rescans of the `FOR UPDATE SKIP LOCKED` FROM-subquery | `WITH claimable AS MATERIALIZED` |
| 3 | Upload pending-sweep confirm/fail UPDATEs rejected — retention bypass was USING-only on `uploads_tenant_isolation` | retention arm added to WITH CHECK |
| 4 | `DELETE /users/me` failed at the final step (half-offboarded accounts) — tombstoned NEW row loses self-arm SELECT visibility | final softDelete under `MAINTENANCE_SCOPE.global_admin` |
| 5 | `DELETE /tenancy/organization` always 500'd after Stripe cancellation — same NEW-row rule vs the sec-new-D3 gate (which is kept) | tombstone under retention scope + retention arm in org WITH CHECK |
| 6 | Audit drain permanently discarded org / API-key-actor rows — `global_admin` grants nothing on `tenancy.*` | `SECURITY DEFINER` resolvers `audit.resolve_*_ids_for_public_ids` |
| 7 | User tombstone purge + offboarding reconciler were silent no-ops — users policy had no retention arm | USING-only retention arm on `users_self_or_admin_access` |
| 8 | Manual DLQ replay always failed its actor pre-condition — lookup ran with no RLS context | wrapped in `MAINTENANCE_SCOPE.global_admin` |

The recurring root causes worth remembering: superuser masking (local + fixtures),
`RETURNING`/NEW-row SELECT-visibility, and bypass arms present in USING but missing in
WITH CHECK.
