# Bulk Seeder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single configurable, reproducible bulk seeder that exhaustively populates every domain up to tens of thousands of rows, built on a shared orchestrator + a per-domain `seed/` directory contract.

**Architecture:** A thin orchestrator (`src/scripts/seed/bulk.ts`) resolves a profile/scale config and runs each domain's `DomainSeedModule`. Every folder that owns tables gets a `seed/` dir exporting a `SeedContribution`; parents compose children up the tree, and only the top-level domain registers a `DomainSeedModule`. A `SeedRegistry` carries parent organization/user refs across domains so each domain seeds only its own tables.

**Tech Stack:** TypeScript, Drizzle, postgres.js, @faker-js/faker, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-01-bulk-seeder-design.md`

---

## File structure

- `src/scripts/validators/domain/validate-domain.ts` — add `'seed'` to `RESERVED_DOMAIN_ROOT_DIRS` (modify).
- `src/scripts/seed/seed-contract.ts` — types + `composeContributions` (create).
- `src/scripts/seed/bulk-config.ts` — profiles, resolver, env overrides (create).
- `src/scripts/seed/bulk.ts` — orchestrator + production guard + module registry (create).
- `src/scripts/seed/seed-registry.ts` — `SeedRegistry` impl (create).
- `src/scripts/seed/production-guard.ts` — env/DB-host guard (create).
- `src/domains/<domain>/seed/` and `.../<sub>/seed/` — per-domain dirs (create; migrate existing `*.seed.ts` in).
- `src/scripts/seed/minimal.ts`, `full.ts` — refactor to call modules (modify).
- `package.json` — add `db:seed:bulk` (modify).
- Docs/rules/skills — see Tasks 12–14.

Order matters: framework (Tasks 1–5) → migration (Task 6) → domain bulk seeders (Tasks 7–11) → tests (already inline) → docs/rules/skills (Tasks 12–14) → verify (Task 15).

---

## Task 1: Allow `seed/` dirs in the domain validator

**Files:** Modify `src/scripts/validators/domain/validate-domain.ts`; Test `src/tests/unit/validators/` (existing domain validator tests).

- [ ] **Step 1:** Add `'seed'` to `RESERVED_DOMAIN_ROOT_DIRS` (line ~24) with a comment: `// per-domain seed/ dir (DomainSeedModule)`.
- [ ] **Step 2:** Run `pnpm validate:domain:strict` — Expected: still passes (no `seed/` dirs yet).
- [ ] **Step 3:** Commit: `chore(validator): allow seed/ directory under domains`.

## Task 2: Seed contract

**Files:** Create `src/scripts/seed/seed-contract.ts`.

Exports (full TSDoc required per be-tsdoc-export-guard):

- `interface ResolvedCounts` — `{ organizations, usersPerOrg:{min,max}, customRolesPerOrg, subscriptionsPerOrg, apiKeysPerOrg, webhooksPerOrg, notificationsPerUser, uploadsPerOrg, auditMonths, auditPerOrgPerMonth, edgeCases }`.
- `interface SeededOrg { id; public_id; ownerUserId }`, `interface SeededUser { id; public_id }`.
- `interface SeedRegistry` — `{ organizations: SeededOrg[]; users: SeededUser[]; addOrganization(o); addUser(u) }`.
- `interface SeedContext { counts; faker: Faker; registry: SeedRegistry; logger }`.
- `interface SeedContribution { seedReference?(ctx): Promise<void>; seedBulk?(ctx): Promise<void> }`.
- `interface DomainSeedModule extends SeedContribution { name: string; dependsOn?: string[]; seedBulk(ctx): Promise<void> }`.
- `function composeContributions(...parts: SeedContribution[]): SeedContribution` — returns a contribution whose `seedReference`/`seedBulk` run each part's hook in order (skipping undefined).

- [ ] Write `composeContributions` unit test (`src/tests/unit/scripts/seed/seed-contract.unit.test.ts`): two fake contributions, assert both `seedReference` then both `seedBulk` run in order; undefined hooks skipped.
- [ ] Implement; `pnpm test:unit <file>` passes; `pnpm typecheck`.
- [ ] Commit: `feat(seed): add DomainSeedModule/SeedContribution contract`.

## Task 3: Bulk config + resolver

**Files:** Create `src/scripts/seed/bulk-config.ts`; Test `src/tests/unit/scripts/seed/bulk-config.unit.test.ts`.

- `type BulkProfile = 'demo' | 'edge' | 'load'`.
- `const PROFILES: Record<BulkProfile, ResolvedCounts>` — demo (~10 organizations), edge (~25 organizations, edgeCases:true), load (1000 organizations / usersPerOrg 5–15 / auditMonths 6 / auditPerOrgPerMonth ~15 → ~90k audit rows).
- `const HARD_CAP = { organizations: 5000, auditRows: 500_000 }`.
- `function resolveCounts(env: NodeJS.ProcessEnv): { profile; scale; counts: ResolvedCounts }` — reads `BULK_PROFILE` (default `demo`), `SCALE` (default 1, multiplies organizations + auditPerOrgPerMonth), per-knob overrides (`BULK_ORGS`, `BULK_USERS_PER_ORG`, `BULK_AUDIT_MONTHS`, `BULK_AUDIT_PER_ORG_PER_MONTH`). Throws if resolved organizations > cap or projected audit rows > cap (message points at the COPY path being out of scope).

- [ ] Unit test: default → demo; `BULK_PROFILE=load` counts; `SCALE=2` doubles organizations; `BULK_ORGS=50` override; over-cap throws.
- [ ] Implement; tests + typecheck pass.
- [ ] Commit: `feat(seed): bulk profiles + scale resolver`.

## Task 4: Registry + production guard

**Files:** Create `src/scripts/seed/seed-registry.ts`, `src/scripts/seed/production-guard.ts`; Test `src/tests/unit/scripts/seed/production-guard.unit.test.ts`.

- `createSeedRegistry(): SeedRegistry` — arrays + add methods.
- `assertBulkSeedAllowed(env): void` — throws unless safe: allow when `ALLOW_BULK_SEED==='1'`; else require `NODE_ENV!=='production'` AND `DATABASE_URL` host ∈ {localhost,127.0.0.1,::1} (parse URL). Throw a clear error otherwise.

- [ ] Unit test: prod NODE_ENV throws; hosted DATABASE_URL throws; `ALLOW_BULK_SEED=1` bypasses; localhost passes.
- [ ] Implement; tests + typecheck pass.
- [ ] Commit: `feat(seed): registry + production guard`.

## Task 5: Orchestrator + script

**Files:** Create `src/scripts/seed/bulk.ts`; Modify `package.json`.

- `MODULES: DomainSeedModule[]` imported from each domain `seed/index.ts` (added in Tasks 6–11; start empty + grow).
- `orderModules(modules): DomainSeedModule[]` — topological sort by `dependsOn` (throw on cycle/unknown).
- `runBulkSeed(env): Promise<void>` — `assertBulkSeedAllowed`; `initFakerSeed()`; build context; ordered `seedReference` then ordered `seedBulk`; log summary. `closeDatabase()` in `finally`.
- `package.json`: `"db:seed:bulk": "tsx src/scripts/seed/bulk.ts"`.

- [ ] Unit test for `orderModules` (deps respected, cycle throws).
- [ ] Implement; `pnpm db:seed:bulk` runs (no modules yet → reference only); typecheck.
- [ ] Commit: `feat(seed): bulk orchestrator + db:seed:bulk script`.

## Task 6: Migrate existing seeds into `seed/` dirs

For each existing seed, create the `seed/` dir, move the file in as `<name>.reference.seed.ts`, add `seed/index.ts` exporting a `SeedContribution`/`DomainSeedModule`, update importers.

Existing → destination:

- `tenancy/sub-domains/permission/permission.seed.ts` → `permission/seed/permission.reference.seed.ts`
- `billing/sub-domains/plan/plan.seed.ts` → `plan/seed/plan.reference.seed.ts`
- `tenancy/tenancy.seed.ts` → `tenancy/seed/tenancy.reference.seed.ts` (+ compose permission)
- `user/user.seed.ts` → `user/seed/user.reference.seed.ts`
- `audit/audit.seed.ts` → `audit/seed/audit.reference.seed.ts`
- `billing/billing.seed.ts` → `billing/seed/billing.reference.seed.ts` (+ compose plan)
- `notify/notify.seed.ts` → `notify/seed/notify.reference.seed.ts`

- [ ] Use `git mv` per file; add `seed/index.ts`; update imports in `minimal.ts`, `full.ts`, and any other importer (grep `\.seed\.js`).
- [ ] `pnpm validate:domain:strict`, `pnpm typecheck`, `pnpm db:seed && pnpm db:seed:full` still work.
- [ ] Commit: `refactor(seed): move domain seeds into per-domain seed/ dirs`.

## Tasks 7–11: Per-domain bulk seeders (same pattern each)

For each domain, in its `seed/` dir add `<name>.faker.ts` (deterministic generators) + `<name>.bulk.seed.ts` (idempotent inserts reusing/extending domain seed helpers), wire into `seed/index.ts` (`composeContributions`), register the domain module in `bulk.ts`, and extend the smoke test (Task 11b) to assert rows > 0 for the new tables. Use multi-row batched inserts (`ON CONFLICT DO NOTHING`, chunk 500) for high-count tables.

- **Task 7 — user** (`dependsOn: []`): users pool; user_settings, notification_preferences, user_data_exports, auth_methods, webauthn_credentials, auth_sessions.
- **Task 8 — tenancy** (`dependsOn: ['user']`): organizations, memberships (status mix), member_roles + custom roles, member_role_permissions, member_invitations (incl. expired in `edge`), organization_settings, organization_notification_policies, organization_api_keys (hashed; revoked in `edge`).
- **Task 9 — billing** (`dependsOn: ['tenancy']`): subscriptions across every status.
- **Task 10 — notify** (`dependsOn: ['tenancy','user']`): notifications per user; webhooks + webhook_events (pending/delivered/failed). `webhook-event` nested `seed/` composes up into `webhook`.
- **Task 11 — upload + audit** (`dependsOn: ['tenancy','user']`): uploads (state mix); audit logs time-distributed across `auditMonths` — audit seeder ensures monthly partitions exist (idempotent `CREATE TABLE IF NOT EXISTS ... PARTITION OF`) when `audit.logs` is partitioned, else inserts directly.

Each task: implement → `BULK_PROFILE=demo pnpm db:seed:bulk` runs clean against the local DB → commit `feat(seed): <domain> bulk seeder`.

## Task 11b: Smoke + idempotency test

**Files:** Create `src/scripts/seed/__tests__/bulk-seed.smoke.test.ts` (integration; needs DB).

- [ ] Run a tiny profile (`BULK_PROFILE=demo`, `BULK_ORGS=2`) twice; assert per-table counts > 0 and identical across the two runs (idempotency). Assert the production guard throws without `ALLOW_BULK_SEED` when `DATABASE_URL` is hosted (mock env).
- [ ] Commit: `test(seed): bulk seeder smoke + idempotency`.

## Task 12: Docs

- [ ] `CLAUDE.md`: Domain Structure canonical layout (add `seed/`), Seeding section (orchestrator + contract + profiles), Commands (`db:seed:bulk`).
- [ ] `src/scripts/seed/seed.overview.md` (new) describing the tiers + contract; one-line `OVERVIEW.md` is not required per dir but add where a `seed/` dir is non-obvious.
- [ ] Commit: `docs(seed): document bulk seeder + per-domain seed/ convention`.

## Task 13: Rule

- [ ] Create `.cursor/rules/be-seed-conventions.mdc` (auto-attach globs `src/domains/**`, `src/scripts/seed/**`): the `seed/` dir layout, `SeedContribution` vs `DomainSeedModule`, compose-up rule, idempotency + production-guard requirements.
- [ ] Mirror to `agents/`/`.claude/` only if that sync exists on `dev` (it does not yet — skip).
- [ ] Commit: `docs(rules): add be-seed-conventions rule`.

## Task 14: Skills

- [ ] `seed-maintainer/SKILL.md` — rewrite around per-domain `seed/` + contract + bulk profiles.
- [ ] `domain-generator/SKILL.md` — scaffold `seed/` (reference + bulk + faker + index) for new domains/sub-domains.
- [ ] `structure-maintainer/SKILL.md` — record the `seed/` layout + validator allowlist change.
- [ ] `skill-index/SKILL.md` — add seed-conventions/seed-maintainer triggers for `seed/` changes.
- [ ] Commit: `docs(skills): align seed-maintainer/domain-generator/structure-maintainer with seed/ dirs`.

## Task 15: Verify + PR

- [ ] `pnpm routes:catalog` (seeds-vs-routes), `pnpm validate`, `pnpm validate:domain:strict`, `pnpm tsdoc:check`, `pnpm test:unit`, and `pnpm db:migrate && BULK_PROFILE=demo pnpm db:seed:bulk` against local compose.
- [ ] Push `feat/bulk-seeder`; open PR to `dev` with coverage summary.

## Self-review notes

- Spec coverage: every spec section maps to a task (contract→2, config→3, guard→4, orchestrator→5, migration→6, breadth→7–11, partitioning→11, tests→3/4/11b, docs/rules/skills→12–14, validator→1).
- Idempotency asserted in 11b; production guard in 4 + 11b.
- Naming consistent: `SeedContribution`, `DomainSeedModule`, `composeContributions`, `resolveCounts`, `assertBulkSeedAllowed`, `runBulkSeed`.
