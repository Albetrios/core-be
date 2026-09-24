---
name: be-seed-maintainer
description: Keeps per-domain seed/ directories and the bulk seed orchestrator aligned with schemas and routes. Use after route, schema, or seed changes.
trigger: src/domains/**/seed/**, src/scripts/seed/**
triggerNote: Keep per-domain seeds aligned with schemas + routes
indexNote: keep per-domain seed/ + bulk orchestrator aligned with schemas + routes
---

# Seed maintainer (core-be)

## Purpose

Keep seed data domain-owned, idempotent, and in sync with schemas and **routes**. Every folder that owns tables carries a `seed/` directory; one shared orchestrator drives all three seeding tiers.

## When to Use

- After adding/removing/updating **routes** or APIs (review and update seeds for route-level alignment)
- After adding new database tables, sub-domains, or domains
- After changing schema columns that affect seed data
- When seed scripts fail or produce stale data
- When adding new test/demo/load-test data requirements

## Three tiers (one code path)

All three share the contract and the per-domain seeders:

- **`pnpm db:seed`** — minimal: bootstrap/reference data only (permission codes, plans). No users or organizations required for the app to start.
- **`pnpm db:seed:full`** — fixed demo set: a small, coherent set of users/organizations/memberships and the cross-domain flows that exercise the API (demo, manual testing).
- **`pnpm db:seed:bulk`** — scaled volume via the orchestrator and profiles, for load/pagination/filter testing and full demo tenants.

## Per-domain `seed/` directory

A `seed/` directory is co-located with **every folder that owns tables** — domain, sub-domain, **and nested sub-domain**. A folder that owns no tables has no `seed/` dir.

```text
src/domains/<domain>/seed/
  index.ts                      # domain root: exports a DomainSeedModule
  <domain>.reference.seed.ts    # idempotent reference / bootstrap data
  <domain>.bulk.seed.ts         # scaled rows for tables this level owns
  <domain>.faker.ts             # level-specific faker generators
src/domains/<domain>/sub-domains/<sub>/seed/          # exports a SeedContribution
src/domains/<domain>/sub-domains/<sub>/<nested>/seed/ # exports a SeedContribution
```

File naming:

- `<name>.reference.seed.ts` — reference / bootstrap data (idempotent). Reference-only levels (e.g. `permission`, `plan`) omit bulk + faker.
- `<name>.bulk.seed.ts` — scaled rows for the tables this level owns.
- `<name>.faker.ts` — faker generators; take the seeded `faker` from `context`.
- `index.ts` — exports the level's `SeedContribution` (or a `DomainSeedModule` at a domain root) and composes its own files plus children.

Canonical examples to copy: `src/domains/user/seed/` and `src/domains/tenancy/seed/` (faker + `*.bulk.seed.ts` + `index.ts`); `src/domains/tenancy/sub-domains/permission/seed/` (reference-only).

## The contract — `src/scripts/seed/seed-contract.ts`

- **`SeedContribution`** — `{ seedReference?(ctx), seedBulk?(ctx) }`; both hooks optional. Exported by every sub-domain / nested sub-domain `seed/index.ts`.
- **`DomainSeedModule`** — `SeedContribution` + `name` + `dependsOn?` (cross-**domain** bulk ordering) + required `seedBulk`. Exported **only** by a top-level domain's `seed/index.ts`; the only unit the orchestrator registers.
- **`composeContributions(...parts)`** — folds children up: runs each part's `seedReference` first, then each part's `seedBulk`. Used at every level (nested → sub-domain → domain).
- **`SeedContext`** — `{ counts, faker, registry, logger }`, handed to every seeder.
- **`SeedRegistry`** — cross-domain parents (organizations/users). The user/tenancy bulk seeders append (`addUser` / `addOrganization`); downstream domains read `registry.users` / `registry.organizations`.

**Seed only your own tables.** A domain/sub-domain seeder writes only its own tables and reads parents from the registry. Cross-domain wiring lives only in the orchestrator/context — never inside a domain seeder (preserves "no cross-domain insert logic inside domains").

## Orchestrator and config

- **`src/scripts/seed/bulk.ts`** — `orderModules` (topological by `dependsOn`), `runBulkSeed` (guard → resolve → all `seedReference`, then all `seedBulk`), `closeDatabase()` in `finally`. Domain modules are registered in **`src/scripts/seed/modules.ts`** (`SEED_MODULES` — one `DomainSeedModule` per domain).
- **`src/scripts/seed/bulk-config.ts`** — `PROFILES` (`demo` / `edge` / `load`), `resolveCounts` (`BULK_PROFILE`, `SCALE`, per-knob `BULK_ORGS` / `BULK_USERS_PER_ORG` / `BULK_AUDIT_MONTHS` / `BULK_AUDIT_PER_ORG_PER_MONTH`), `HARD_CAP` (fatal if exceeded; COPY path out of scope).
- **`src/scripts/seed/production-guard.ts`** — `assertBulkSeedAllowed`: refuses on a non-local `DATABASE_URL` unless `ALLOW_BULK_SEED=1` (no `NODE_ENV` check).
- **`src/scripts/seed/seed-registry.ts`** — in-memory `createSeedRegistry()`.
- **`minimal.ts` / `full.ts`** — orchestration entry points for the reference-only and fixed-demo tiers; call domain seeds + cross-domain flows. No entity lists or insert helpers here.
- **`helpers.ts`** — re-exports like `closeDatabase`. **`faker-data.ts`** — `initFakerSeed()` and shared faker helpers.

Dependency order (declared via `dependsOn` at the domain level): `user` first; then `auth` and `tenancy` (both depend on `user`); then `billing` (on `tenancy`) and `notify` / `upload` / `audit` (on `tenancy` + `user`). `seedReference` (permissions, plans) runs for all domains before any `seedBulk`.

## Idempotency and reproducibility (required)

- Re-running any tier must not duplicate rows. Two conflict-handling patterns:
  - **`onConflictDoNothing()`** — default for bulk rows, reference codes, and join tables where existing data is the source of truth.
  - **`onConflictDoUpdate({ target, set })`** — required for demo seed helpers where fields must stay current on re-run (e.g. `password_hash`, `first_name`, `last_name` in `seedUser`; `name` in `seedOrganization`). For unique indexes with a `WHERE` clause (partial indexes), also supply `targetWhere: sql\`${table.deleted_at} IS NULL\`` so Drizzle resolves the correct index.
- Use count-and-resume as an alternative for ordered bulk rows. Use `generatePublicId()` for `public_id` fields.
- High-count tables (`audit.logs`, notifications) use batched multi-row inserts with `ON CONFLICT DO NOTHING`.
- Pin faker via `SEED` (`initFakerSeed()`) so a given seed reproduces the same data.

## Steps

1. **Identify which level owns the table(s)** (domain, sub-domain, or nested sub-domain).
2. **Add or update that level's `seed/` dir.** Reference data → `<name>.reference.seed.ts`; scaled rows → `<name>.bulk.seed.ts`; generators → `<name>.faker.ts`. Export the level's `SeedContribution` from `index.ts`. Read parents from `context.registry`; never touch other domains' tables.
3. **Compose up.** Ensure the parent `seed/index.ts` includes the new contribution via `composeContributions(...)`. If a new top-level domain owns tables, export a `DomainSeedModule` (`name` + `dependsOn`) and register it in `SEED_MODULES` in `src/scripts/seed/modules.ts`.
4. **Keep tiers consistent.** Update `minimal.ts` (reference data) and `full.ts` (demo flows) if the new data is needed there. Update `bulk-config.ts` profile counts / knobs if the new table needs a volume dial.
5. **Order**: reference first (permissions, plans), then bulk in `dependsOn` order (`user` before `tenancy` before downstream).
6. **After route changes**: run **be-route-catalog** (`pnpm routes:catalog`) and update seeds so new routes have data and removed routes' seed data is dropped.
7. **Test**: `pnpm db:seed`, `pnpm db:seed:full`, and a tiny bulk run (e.g. `BULK_PROFILE=demo pnpm db:seed:bulk`); run **twice** to confirm idempotency; run `pnpm typecheck`.

## Domain–permission mapping

System permission codes live in `src/domains/tenancy/sub-domains/permission/seed/permission.reference.seed.ts` (`SYSTEM_PERMISSIONS`). When adding a domain that needs permissions, add the codes there and ensure they are granted to admin/demo roles in `full.ts` (via `seedRolePermissions()`). Domains covered: Tenancy, Billing, Notify, Audit, Upload (see the reference seed for the full list).

> **Note:** For permission seeding, see `src/scripts/seed/sync-demo-permissions.ts`.

## Seed function pattern

```typescript
// Bulk rows / reference codes / join tables — existing row is source of truth
export async function seedEntity(payload: Payload) {
  const [row] = await database
    .insert(entity)
    .values({ public_id: generatePublicId(), ...payload })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

// Demo seed helpers — fields must stay current on re-run (e.g. credentials, display name)
// For a partial unique index (WHERE deleted_at IS NULL), supply targetWhere.
export async function seedDemoEntity(payload: Payload) {
  const [row] = await database
    .insert(entity)
    .values({ public_id: generatePublicId(), ...payload })
    .onConflictDoUpdate({
      target: entity.email,                          // or composite [entity.org_id, entity.name]
      targetWhere: sql`${entity.deleted_at} IS NULL`, // omit for non-partial indexes
      set: { field_to_refresh: payload.field_to_refresh },
    })
    .returning();
  return row ?? null;
}
```

## Related

- Rule: `agent-os/rules/be-seed-conventions.mdc` (auto-attaches under `src/domains/**`, `src/scripts/seed/**`).
- Overview: `src/scripts/seed/seed.overview.md`.
- New table/domain scaffolding: **be-domain-generator** (scaffolds the `seed/` dir); **be-structure-maintainer** if layout/paths change.
