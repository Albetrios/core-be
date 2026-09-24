# AI Tooling Audit — Fix Plan

> **Scope:** 36 skills (`agent-os/skills/`) + 8 agents (`agent-os/agents/`) + 37 rules (`agent-os/rules/`)
> **Audited:** 2026-06-09
> **Status:** Ready to implement

---

## Priority legend

| Level | Meaning |
|-------|---------|
| 🔴 P1 | Generates wrong code or actively breaks a workflow |
| 🟠 P2 | Stale path/name — skill fails if followed literally |
| 🟡 P3 | Missing step or wrong constant — skill is incomplete |
| 🟢 P4 | Minor gap or cosmetic issue |

---

## Task 1 — Skills: Critical codegen bugs 🔴 P1

**Files:** `agent-os/skills/be-schema-generator/SKILL.md`, `agent-os/skills/be-sql-design-guard/SKILL.md`, `agent-os/skills/be-lint-warnings-handler/SKILL.md`

### 1a. `be-schema-generator` — wrong `public_id` type and Drizzle syntax

- [ ] Change `public_id` column in the scaffold template from `text('public_id').notNull().unique()` + CHECK constraint → `varchar('public_id', { length: 21 }).notNull().unique()`
- [ ] Change table constraint syntax from object form `(table) => ({ ... })` → array form `(table) => [ ... ]` (matches all real schema files)
- [ ] Add `uploadSchema` to the pgSchema list in Step 1 (currently lists auth, tenancy, billing, notify, audit — missing upload)
- [ ] Add a note that every new table needs `.enableRLS()` and `pgPolicy` — link to be-db-migration-maintainer for RLS step

### 1b. `be-sql-design-guard` — wrong naming convention + non-existent tables

- [ ] Section D.2: Change unique index prefix from `uniq_` → `idx_` (all 28 real `uniqueIndex()` calls use `idx_`)
- [ ] Fix example SQL in section D.2: `CREATE UNIQUE INDEX uniq_subscriptions_...` → `CREATE UNIQUE INDEX idx_subscriptions_...`
- [ ] Section E.1: Replace `notify.notification_events` → `notify.notifications` (actual table name)
- [ ] Section E.1: Replace `notify.webhook_events` → `notify.webhook_delivery_attempts` (actual table name)
- [ ] Section G.3: Add `DEBUG` and `ERROR` to audit severity CHECK constraint values: `('DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL')`
- [ ] Add RLS section: note that all production tables must have `.enableRLS()` + `pgPolicy` (currently absent from the entire checklist)

### 1c. `be-lint-warnings-handler` — entire skill written for ESLint, project uses Biome

- [ ] Replace every `// eslint-disable-next-line <rule>` example with `// biome-ignore lint/<category>/<rule>: <reason>`
- [ ] Replace ESLint/SonarJS rule names with Biome equivalents throughout:
  - `sonarjs/no-duplicate-string` → no direct Biome equivalent; note to extract constant instead
  - `max-lines-per-function` → `complexity/noExcessiveLinesPerFunction`
  - `security/detect-object-injection` → no Biome equivalent; remove or replace with manual note
  - `no-console` → `suspicious/noConsole`
  - `sonarjs/cognitive-complexity` → `complexity/noExcessiveCognitiveComplexity`
  - `sonarjs/no-identical-functions` → no Biome equivalent; remove
  - `sonarjs/no-collapsible-if` → `style/useCollapsedIf`
  - `sonarjs/prefer-single-boolean-return` → no Biome equivalent; remove

---

## Task 2 — Skills: Stale infrastructure paths 🟠 P2

**Files:** `setup-infra-maintainer` (skill since removed), `agent-os/skills/be-structure-maintainer/SKILL.md`, `agent-os/skills/be-code-quality-guard/SKILL.md`

### 2a. `setup-infra-maintainer` — entire file map is wrong (pervasive path drift)

All `tooling/setup/<file>.ts` references must be updated:

| Stale path in skill | Correct path |
|---|---|
| `tooling/setup/config.ts` | `tooling/setup/common/config.ts` |
| `tooling/setup/secrets.ts` | `tooling/setup/common/secrets.ts` |
| `tooling/setup/env-secrets.ts` | Does not exist; logic is in `tooling/setup/common/secrets.ts` + `tooling/setup/infra/init-wizard.ts` |
| `tooling/setup/orchestrator.ts` | `tooling/setup/infra/orchestrator.ts` |
| `tooling/setup/guide.ts` | `tooling/setup/infra/guide.ts` |
| `tooling/setup/prerequisites.ts` | `tooling/setup/infra/prerequisites.ts` |
| `tooling/setup/state.ts` | `tooling/setup/common/state.ts` |
| `tooling/setup/types.ts` | `tooling/setup/common/types.ts` |
| `tooling/setup/build-env-vars.ts` | `tooling/setup/envs/build-env-vars.ts` |
| `tooling/setup/init-wizard.ts` | `tooling/setup/infra/init-wizard.ts` |
| `tooling/setup/providers/*.provider.ts` | `tooling/setup/infra/providers/<name>/<name>.provider.ts` |

- [ ] Fix `pnpm setup --init` → `pnpm setup:infra:init` (lines 10 and 98)
- [ ] Rebuild the file-map table with correct paths

### 2b. `be-structure-maintainer` — multiple stale infrastructure paths

- [ ] `tooling/setup-infra/` → `tooling/setup/` throughout (lines 120–126)
  - `setup-infra/providers/setup-<name>/...` → `tooling/setup/infra/providers/setup-<name>/...`
  - `setup-infra/setup.config.json` → `tooling/setup/setup.config.json`
- [ ] `src/infrastructure/queue/worker-options.ts` → `src/infrastructure/queue/worker-runtime/worker-options.ts`
- [ ] `src/infrastructure/queue/dead-letter.ts` → `src/infrastructure/queue/dlq/dead-letter.ts`
- [ ] Add missing queue subdirs to layout: `dlq/`, `commit-dispatch/`, `worker-runtime/`
- [ ] Add missing database subdirs: `database/contexts/`, `database/migration/`
- [ ] Add missing infra modules: `outbound/`, `resilience/`, `api-reference/`
- [ ] Add `configuration.error.ts` to the `shared/errors/` listing
- [ ] Expand `mail/` layout: add `mail-outbox.repository.ts`, `mail-outbox.schema.ts`, `resend-api.error.ts`, `queues/`, `workers/`, `templates/`
- [ ] Add `src/core/` module to the layout section (it has event-bus + OVERVIEW.md)

### 2c. `be-code-quality-guard` — stale CI workflow filenames + lint-staged location

- [ ] Line 32: Replace `ci.yml` → `pr-ci.yml`. Remove references to `quality` job (jobs are named `lint`, `typecheck`, `static-sync`, `unit`, etc.)
- [ ] Line 33: Replace `commit-lint.yml` → `pr-governance.yml`
- [ ] Lines 110–118: Lint-staged config block shows inline `package.json` JSON. Update to reflect it lives in `lint-staged.config.mjs` at repo root. Show the actual structure (functions, exclusions for `project-identity.constants.ts`, CHANGELOG markdown).
- [ ] Lines 94–101 (pre-push table): Add missing steps — `pnpm docs:lint:changed` (on markdown changes) and `pnpm sonar:scan` (on deployed-surface `.ts` changes, with `SKIP_SONAR=1` bypass)
- [ ] Add step 3b (architecture policy tests) to the pre-commit step table

---

## Task 3 — Skills: Missing steps and wrong constants 🟡 P3

### 3a. `be-before-commit-guard` — missing 3 steps

**File:** `agent-os/skills/be-before-commit-guard/SKILL.md`

- [ ] Add step 3b "Architecture policy tests" to the commit-step table: runs `pnpm test:global` when `src/domains/**/*.ts` files are staged; skip otherwise
- [ ] Add to pre-push table: step for `pnpm docs:lint:changed` (conditional: markdown file changes)
- [ ] Add to pre-push table: SonarQube gate (`pnpm sonar:scan`, controlled by `SKIP_SONAR=1` env var, fires when deployed-surface `.ts` code is changed)

### 3b. `be-workers-events` — two stale infrastructure paths

**File:** `agent-os/skills/be-workers-events/SKILL.md`

- [ ] Line 34: `src/infrastructure/queue/dead-letter.ts` → `src/infrastructure/queue/dlq/dead-letter.ts`
- [ ] Line 35: `src/infrastructure/queue/worker-options.ts` → `src/infrastructure/queue/worker-runtime/worker-options.ts`
- [ ] Add note on `commit-dispatch/` subsystem (`src/infrastructure/queue/commit-dispatch/`) — recovery worker, executor, store

### 3c. `be-seed-maintainer` — wrong registration file

**File:** `agent-os/skills/be-seed-maintainer/SKILL.md`

- [ ] Lines 63 and 82: Change "register in `MODULES` in `bulk.ts`" → "register in `SEED_MODULES` in `src/scripts/seed/modules.ts`" (`bulk.ts` imports from `modules.ts`)
- [ ] Add mention of `src/scripts/seed/sync-demo-permissions.ts` for permission seeding

### 3d. `be-skill-index` — 5 agents missing + stale workflow ref

**File:** `agent-os/skills/be-skill-index/SKILL.md`

- [ ] Subagents table (lines 315–319): Add missing 5 agents: `be-dependency-auditor`, `be-docs-auditor`, `be-production-hardening-reviewer`, `be-sql-design-reviewer`, `be-tsdoc-coverage-reviewer`
- [ ] Line 122: Change `.github/workflows/ci.yml` → `.github/workflows/pr-ci.yml`

### 3e. `be-route-schema-doc-guard` — wrong constant name

**File:** `agent-os/skills/be-route-schema-doc-guard/SKILL.md`

- [ ] Line 71: Change `EXTRA_ROUTE_SOURCE_FILES` → `SUPPLEMENTAL_ROUTE_FILES` (in `tooling/openapi/extractors/route-schema-metadata.ts`)

### 3f. `be-schema-generator` — missing upload schema (covered in Task 1a)

Already included in Task 1a.

### 3g. `be-db-migration-maintainer` — internal path inconsistency

**File:** `agent-os/skills/be-db-migration-maintainer/SKILL.md`

- [ ] Line 87 layout table: Change `src/infrastructure/database/migrate.ts` → `src/infrastructure/database/migration/migrate.ts` (line 22 is already correct — make table match)

### 3h. `be-openapi-route-sync` — wrong tag format

**File:** `agent-os/skills/be-openapi-route-sync/SKILL.md`

- [ ] Line 29: Change tag example from object `{ "Auth": { "name": "Auth", "description": "..." } }` → flat string `{ "Auth": "Authentication — login, logout, password management" }`

### 3i. `be-ci-investigation` — two wrong workflow paths

**File:** `agent-os/skills/be-ci-investigation/SKILL.md`

- [ ] Line 26: `reusable/chaos-toxiproxy.yml` → `reusable-chaos-toxiproxy.yml`
- [ ] Line 28: `reusable/docs-generate.yml` → `reusable-openapi-postman-publish.yml` (post-merge) / `pr-docs-lane.yml` (PR markdown lint)

### 3j. `be-domain-generator` — undocumented sub-domains

**File:** `agent-os/skills/be-domain-generator/SKILL.md`

- [ ] Add `auth-mfa-session/` to the auth sub-domains list
- [ ] Add `webhook-delivery/` as a nested sub-domain under `webhook/` in the notify domain

### 3k. `be-test-generator` — wrong test command description + missing projects

**File:** `agent-os/skills/be-test-generator/SKILL.md`

- [ ] Line 123: `pnpm test` is not "serial" — it runs parallel (fast + DB-bound groups via `run-parallel.ts`); also excludes contract, chaos, smoke, load, bench
- [ ] Line 114: Events test pattern is `events/__tests__/*.test.ts` not `__tests__/unit/events/`
- [ ] Add `pnpm test:unit-db` (DB-bound unit tests, `*.db.unit.test.ts`)
- [ ] Add `pnpm test:property` (fast-check property tests, `*.property.unit.test.ts`)

### 3l. `be-contract-test-maintainer` — wrong setup file path

**File:** `agent-os/skills/be-contract-test-maintainer/SKILL.md`

- [ ] Layout table row 5: Change `src/tests/contract-vitest-setup.ts` → `src/tests/contract/contract-vitest-setup.ts`

### 3m. `be-route-catalog` — stale "both artifacts" wording

**File:** `agent-os/skills/be-route-catalog/SKILL.md`

- [ ] Lines 152–155: Remove "both artifacts" / "either file is out of sync" wording — only one output exists: `docs/routes.txt`

---

## Task 4 — Minor gaps 🟢 P4

### 4a. `be-docs-maintainer` + `be-docs-audit`

- [ ] Add `docs/superpowers/` (AI-generated plans/specs) and `docs/database/` (core-be.dbml) to the subfolder enumeration in both skills

### 4b. `be-overview-doc-maintainer`

- [ ] Add `src/core/` and `src/scripts/` to the trigger-path list (both have real `OVERVIEW.md` files)

### 4c. `be-production-hardening-guard`

- [ ] Line 66: `src/infrastructure/queue/worker-options.ts` → `src/infrastructure/queue/worker-runtime/worker-options.ts`

### 4d. `be-dependency-security`

- [ ] Lines 55/98: Override examples reference `package.json` → move to `pnpm-workspace.yaml` (where real overrides live)

### 4e. `be-supabase-porting`

- [ ] Line 18: Add `upload` domain to the domain list
- [ ] Follow-up skills table: Replace `be-openapi-route-sync` (legacy) → `be-route-schema-doc-guard`

### 4f. `be-split-to-prs`

- [ ] Add note that this repo enforces merge-commit-only merges (squash and rebase are disabled)

### 4g. `be-path-to-production-gate`

- [ ] Add `pnpm ci:local` and `pnpm verify:base` as explicit local gate commands in step 2
- [ ] Add SonarQube checklist item: `pnpm sonar:up` / `pnpm sonar:scan` / `pnpm sonar:down`

### 4h. `be-openapi-multilingual`

- [ ] Step 1: Replace "run be-openapi-route-sync first" → "run be-route-schema-doc-guard first" (be-openapi-route-sync is legacy)

### 4i. `be-tsdoc-export-guard`

- [ ] Lines 140/146: Change `pnpm tsdoc:check --report` / `--refresh-budget` → `pnpm tsdoc:check:report` / `pnpm tsdoc:check:refresh-budget` (canonical script names)

---

## Task 5 — Agents: literal `\n` escape corruption 🟡 P3

**Files:** `agent-os/agents/be-ci-investigator.md`, `agent-os/agents/be-production-reviewer.md`, `agent-os/agents/be-verifier.md`

The last 2 lines of the "Platform Access" section in 3 agent files contain literal `\n` escape sequences instead of real newlines. Example:

```text
...in the\nfrontmatter above.\n
```

Should be:

```text
...in the
frontmatter above.
```

- [ ] Fix `be-ci-investigator.md` line 39
- [ ] Fix `production-reviewer.md` line 47
- [ ] Fix `verifier.md` line 45

---

## Task 6 — Rules: stale references and wrong content 🟡 P3

### 6a. `be-project-identity.mdc` — removed file listed as generated output

- [ ] Line 15: Remove `.github/sync.config.json` from the "Generated (do not hand-edit)" list — the file was deleted in `4370ea38`. Add `.github/actions/setup-project-identity/action.yml` as a generated output instead.

### 6b. `be-engineering-principles.mdc` + `be-src-architecture.mdc` — ambiguous processor rule

- [ ] Qualify "No processors in `infrastructure/queue/`" → "No *domain* job processors in `infrastructure/queue/`" (infrastructure-owned workers in `dlq/` and `observability/` are intentional exceptions)

### 6c. `be-chaos-test-maintainer-sync.mdc` — dead glob

- [ ] Remove `src/scripts/**/provision-proxies.ts` from globs (file is at `src/tests/chaos/provision-proxies.ts`, already covered by the existing `src/tests/chaos/**/*.ts` glob)

### 6d. `be-code-smells-and-best-practices-sync.mdc` — says ESLint, means Biome

- [ ] Line 11: Change "ESLint errors and any new warnings" → "Biome errors and any new warnings"

### 6e. `be-openapi-multilingual-sync.mdc` — references legacy skill

- [ ] Description frontmatter and line 12 body: Replace `be-openapi-route-sync` → `be-route-schema-doc-guard`

### 6f. `be-structure-maintainer-sync.mdc` — glob may miss flat agent files

- [ ] `agent-os/agents/**/*.md` → `agent-os/agents/*.md` (no subdirs currently; `**/` is ambiguous in strict glob engines)

---

## Task 7 — New skills / agents needed ⚠️ Additions

Based on gaps found across the audit, the following are recommended additions:

### 7a. New agent: `changelog-reviewer.md`

- Wraps `agent-os/skills/be-pr-babysit/SKILL.md` (or a future changelog skill)
- The `be-ci-investigator.md` references it in its description but it doesn't exist in `agent-os/agents/`

### 7b. Skill gap: No skill for `src/infrastructure/queue/commit-dispatch/`

- The commit-dispatch subsystem (recovery worker, executor, store) is undocumented and has no skill coverage
- Add a section to `workers-events/SKILL.md` covering commit-dispatch patterns, OR create a dedicated `commit-dispatch/SKILL.md`

### 7c. Missing `TOKEN: metrics` documentation

- Neither `be-route-catalog`, `be-route-schema-doc-guard`, nor `be-openapi-multilingual` document the `TOKEN: metrics` access type for `/metrics` and `/internal/ops/*` routes
- Add to `route-catalog/SKILL.md` access-type table

---

## Recommended PR grouping

| PR | Tasks | Scope |
|----|-------|-------|
| **PR A** (P1 fixes) | Task 1 | be-schema-generator, be-sql-design-guard, be-lint-warnings-handler |
| **PR B** (P2 path fixes) | Task 2 | setup-infra-maintainer, be-structure-maintainer, be-code-quality-guard |
| **PR C** (P3 gaps) | Tasks 3, 5, 6 | 13 skills + 3 agents + 6 rules |
| **PR D** (P4 minor) | Task 4 | 9 minor skill gaps |
| **PR E** (new additions) | Task 7 | New agent + skill gaps |

---

## Files NOT needing changes (clean)

**Skills:** `be-env-schema-add`, `be-system-narrative-maintainer`, `be-pr-babysit`, `be-cursor-global-skills`, `be-i18n-message-guard`, `be-ide-productivity-guard`, `be-chaos-test-maintainer`, `be-path-to-production-gate` (P4 only), `be-code-smells-and-best-practices` (P4 only)

**Agents:** `be-dependency-auditor`, `be-docs-auditor`, `be-production-hardening-reviewer`, `be-sql-design-reviewer`, `be-tsdoc-coverage-reviewer`

**Rules:** `be-before-commit-guard-sync`, `be-code-quality-guard-sync`, `be-contract-test-maintainer-sync`, `be-db-migration-maintainer-sync`, `be-dependency-security-sync`, `be-docs-maintainer-sync`, `be-domain-generator-sync`, `be-env-schema-add-sync`, `be-i18n-message-guard-sync`, `be-ide-productivity-guard-sync`, `be-overview-doc-maintainer-sync`, `be-project-identity-sync`, `be-route-catalog-sync`, `be-route-schema-doc-guard-sync`, `be-seed-maintainer-sync`, `setup-infra-maintainer-sync`, `be-sql-design-guard-sync`, `be-system-narrative-maintainer-sync`, `be-tsdoc-export-guard-sync`, `be-workers-events-sync`, `be-context7-backend`, `be-full-names-only`, `be-object-params`, `be-import-paths`, `be-new-requirement-intake`, `be-no-placeholder-files`, `be-testing-conventions`, `be-seed-conventions`, `be-production-hardening`, `be-path-to-production-gate`
