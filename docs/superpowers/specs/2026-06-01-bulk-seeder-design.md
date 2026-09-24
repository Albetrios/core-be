# Bulk Seeder — Design Spec

- **Date:** 2026-06-01
- **Status:** Approved (pending spec review)
- **Scope:** `core-be` seeding (`src/scripts/seed/**`, `src/domains/<domain>/seed/**`) + docs/skills/rules

## 1. Goal

One configurable, reproducible seeding tool that populates the database from a
small coherent demo set up to **tens of thousands** of rows, **exhaustively
across every domain**, so that:

- list / pagination / filter endpoints are exercised with realistic volume,
- the `audit.logs` monthly partitions and time-range queries actually fill up,
- demo / staging environments look like real tenants,
- edge / boundary states (soft-deleted, expired, revoked, every status) exist.

One tool, three behaviors via **profiles**: `demo` (small & coherent), `edge`
(diverse / boundary states), `load` (tens of thousands).

## 2. Non-goals

- **Not** a millions-of-rows / `COPY`-based load generator. At the
  tens-of-thousands ceiling, idempotent upserts plus light batching are enough.
- **Never** runs against production (hard guard).
- Does not remove the `minimal` / `full` tiers — they stay, but are refactored to
  share the new orchestrator path.

## 3. Architecture

### 3.1 Shared orchestrator (thin)

`src/scripts/seed/bulk.ts` + `src/scripts/seed/bulk-config.ts`:

1. Resolve `(profile, SCALE, env overrides)` → `ResolvedCounts`.
2. Build a seeded `faker`, a `SeedRegistry`, a `logger`, and a `SeedContext`.
3. Discover the registered `DomainSeedModule`s; topologically order by `dependsOn`.
4. Run every `seedReference(ctx)` (reference data), then every `seedBulk(ctx)` in
   dependency order.
5. Production guard up front; `closeDatabase()` in `finally` (matches `full.ts`).

`minimal.ts` and `full.ts` are refactored to call the same modules
(reference-only / fixed-demo presets) so all three tiers share one code path.

### 3.2 Contract — `src/scripts/seed/seed-contract.ts`

```ts
export interface ResolvedCounts {
  organizations: number;
  usersPerOrg: { min: number; max: number };
  customRolesPerOrg: number;
  subscriptionsPerOrg: number;
  apiKeysPerOrg: number;
  webhooksPerOrg: number;
  notificationsPerUser: number;
  uploadsPerOrg: number;
  auditMonths: number;            // how many past months audit rows span
  auditPerOrgPerMonth: number;
  edgeCases: boolean;             // seed deliberate boundary rows
}

export interface SeedRegistry {
  organizations: { id: number; public_id: string; ownerUserId: number }[];
  users: { id: number; public_id: string }[];
  // append + read accessors; the orchestrator owns this object
}

export interface SeedContext {
  counts: ResolvedCounts;
  faker: Faker;
  registry: SeedRegistry;
  logger: Logger;
}

// What a sub-domain / nested sub-domain seed/ exports — no name/dependsOn; the
// parent composes it. This is the unit each (nested) sub-domain owns.
export interface SeedContribution {
  seedReference?(ctx: SeedContext): Promise<void>;
  seedBulk?(ctx: SeedContext): Promise<void>;
}

// What a TOP-LEVEL domain's seed/index.ts exports — the only unit the
// orchestrator registers and manages independently.
export interface DomainSeedModule extends SeedContribution {
  name: string;                                  // 'tenancy', 'billing', …
  dependsOn?: string[];                          // cross-DOMAIN bulk ordering (union of children's needs)
  seedBulk(ctx: SeedContext): Promise<void>;     // required at the domain level
}

// Merges child contributions (own tables + sub-domains + nested sub-domains) into
// one ordered seedReference/seedBulk for the parent. Used at every level.
export function composeContributions(
  ...contributions: SeedContribution[]
): SeedContribution;
```

Each domain/sub-domain seeds **only its own tables**. It reads parent refs
(organizations/users) from `registry` and appends the entities it creates back to
`registry` for downstream domains. This preserves the "no cross-domain insert
logic inside domains" rule — cross-domain wiring lives only in the
orchestrator/context.

### 3.3 Per-domain seed directory

A `seed/` directory is co-located with **every folder that owns tables** —
domain, sub-domain, **and nested sub-domain** (recursively):

```text
src/domains/<domain>/seed/
  index.ts                      # exports the domain's DomainSeedModule (composes its own files + every child below)
  <domain>.reference.seed.ts    # existing reference data, moved here (idempotent)
  <domain>.bulk.seed.ts         # NEW: scaled rows for tables this level owns
  <domain>.faker.ts             # level-specific faker generators
src/domains/<domain>/sub-domains/<sub>/seed/          # sub-domain SeedContribution
  index.ts                      # exports a SeedContribution (composes its own files + nested children)
  <sub>.reference.seed.ts
  <sub>.bulk.seed.ts
  <sub>.faker.ts
src/domains/<domain>/sub-domains/<sub>/<nested>/seed/ # NESTED sub-domain SeedContribution (e.g. webhook-event, organization-api-key, member-invitation)
  index.ts                      # exports a SeedContribution
  <nested>.bulk.seed.ts
  <nested>.faker.ts
```

**Composition boundary — the same pattern, one registered unit per domain:**

- Every `seed/index.ts` exports a `SeedContribution` **except** the top-level
  domain's, which exports a full `DomainSeedModule`.
- Each level uses `composeContributions(...)` to fold its own seeders together
  with its children's: `webhook-event` → composed by `webhook` → composed by the
  `notify` domain `seed/index.ts`.
- The orchestrator therefore registers and orders **only domain modules** (one per
  domain). Cross-domain `dependsOn` is declared once at the domain level; ordering
  *within* a domain (parent before nested child where required) is handled by the
  composition order inside that domain's `index.ts`.

### 3.4 Domain coverage + ordering

`seedReference` runs first for all domains (permissions, plans), then `seedBulk`
in `dependsOn` order:

1. **user** — user pool; per-user: settings, notification preferences, data
   exports, auth methods, WebAuthn credentials, auth sessions.
2. **tenancy** (`dependsOn: ['user']`) — organizations (owner from `registry.users`),
   memberships (ACTIVE / INVITED / SUSPENDED mix), Admin + custom roles with
   varied permission subsets, role-permission wiring, member invitations, organization
   settings, notification policies, organization API keys (hashed).
3. **billing** (`dependsOn: ['tenancy']`) — subscriptions per organization across every
   status (active / trialing / past_due / canceled / incomplete).
4. **notify** (`dependsOn: ['tenancy','user']`) — per-user notifications; organization
   webhooks + webhook-events (pending / delivered / failed).
5. **upload** (`dependsOn: ['tenancy','user']`) — uploads per organization/user in mixed
   states (pending / confirmed / failed).
6. **audit** (`dependsOn: ['tenancy','user']`) — audit logs per organization, time-
   distributed `created_at` across `auditMonths`.

### 3.5 Config model — `bulk-config.ts`

- **Profiles**: `demo`, `edge`, `load` — each a base `ResolvedCounts`. Targets:
  `demo` ≈ 10 organizations / ~50 users; `edge` ≈ 25 organizations with every boundary state;
  `load` ≈ **1,000 organizations / ~10,000 users / ~100,000 audit rows**.
- **`SCALE`** env multiplier (default `1`) scales volume-bearing counts
  (organizations, audit rows). The resolver applies a **hard cap** (≈ 5,000 organizations /
  ≈ 500,000 audit rows) so a run stays within the tens-of-thousands-per-table band
  where idempotent upserts + light batching remain viable; exceeding the cap is a
  fatal config error pointing at the COPY-based path as out of scope.
- **Per-knob env overrides**: `BULK_ORGS`, `BULK_USERS_PER_ORG`,
  `BULK_AUDIT_MONTHS`, `BULK_AUDIT_PER_ORG_PER_MONTH`, etc.
- **`BULK_PROFILE`** selects the profile (default `demo`).
- **`SEED`** (existing) pins faker for reproducibility.

Invocation examples: `pnpm db:seed:bulk`,
`BULK_PROFILE=load SCALE=5 pnpm db:seed:bulk`,
`BULK_PROFILE=edge BULK_ORGS=200 pnpm db:seed:bulk`.

### 3.6 Determinism, idempotency, performance

- `initFakerSeed()` (`SEED`) → reproducible runs.
- Deterministic natural keys (email/slug derived from faker + index) so re-runs
  **upsert**, not duplicate.
- Idempotent upserts via domain helpers; the two high-count tables
  (`audit.logs`, notifications) use batched **multi-row inserts** (chunks of
  ~500) with `ON CONFLICT DO NOTHING`, keeping a `load` run in the
  seconds-to-low-minutes range.

### 3.7 Audit partitioning

When `audit.logs` is partitioned (hosted), the audit bulk seeder first ensures
the monthly partitions it will write to exist (idempotent
`CREATE TABLE IF NOT EXISTS … PARTITION OF`) for the spanned months, then inserts
the time-distributed rows. On a plain table (local / CI) it inserts directly.
This keeps the seeder correct on both shapes and complements the existing
hosted-vs-migrations `audit.logs` partitioning note (tracked separately).

### 3.8 Safety

Refuse to run when `NODE_ENV === 'production'` **or** `DATABASE_URL` resolves to a
non-local / known-hosted host, unless `ALLOW_BULK_SEED=1` is set explicitly. Log
the resolved profile + counts up front and a per-table created-row summary at the
end.

## 4. Migration of existing seeds

Move every existing `*.seed.ts` (`permission.seed.ts`, `plan.seed.ts`,
`tenancy.seed.ts`, `user.seed.ts`, `audit.seed.ts`, `billing.seed.ts`,
`notify.seed.ts`) into the `seed/` directory of its owning domain/sub-domain and
adopt the contract (`seedReference`). Update imports in `minimal.ts` / `full.ts`.
No behavior change to reference data. Governed by **be-structure-maintainer** and the
**be-import-paths** rule.

## 5. Docs / skills / rules to update

- **CLAUDE.md** — Domain Structure canonical layout (add `seed/`), Seeding
  section (orchestrator + contract + profiles), Commands (`db:seed:bulk`).
- **`.cursor/rules/`** — new scoped rule `be-seed-conventions.mdc` (auto-attach under
  `src/domains/**` and `src/scripts/seed/**`) describing the `seed/` directory +
  `DomainSeedModule` contract.
- **Skills** — `be-seed-maintainer` (rewrite around the new structure),
  `be-domain-generator` (scaffold `seed/` for new domains/sub-domains),
  `be-structure-maintainer` (record the layout change), `be-skill-index` (trigger map).
- **In-source docs** — `OVERVIEW.md` in `src/scripts/seed/` and a short overview
  in each new `seed/` dir.
- Run `pnpm routes:catalog` so seeds remain aligned with routes.

## 6. Testing

- **Unit** — `bulk-config` resolver: profile × `SCALE` × env-override math and the
  tens-of-thousands cap.
- **Smoke** (`src/scripts/seed/__tests__/`) — run a tiny profile against the test
  DB; assert per-table row counts > 0 and **idempotency** (run twice → identical
  counts). A guard test asserts the production guard refuses without
  `ALLOW_BULK_SEED`.
- Update existing domain seed tests for the moved paths.

## 7. Delivery

Single PR to `dev`: contract + orchestrator + config + all domain `seed/` dirs
(migrated reference + new bulk) + docs/skills/rules + tests. CI must be green
(`validate`, `validate:domain`, DB tests, `routes:catalog:check`, `tsdoc:check`).

## 8. Risks / open items

- Large PR review surface — accepted by choice (single-PR delivery).
- Exhaustive breadth means many small seeders; mitigated by the uniform contract.
- Hosted `audit.logs` is partitioned while migrations define it plain — handled
  here by the partition-ensure step; the broader drift reconciliation is a
  separate follow-up.
