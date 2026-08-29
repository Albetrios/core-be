# New Requirement Intake (core-be)

**Use this format when giving a new requirement.** Providing the details below in your request helps the AI perform best and ensures the right skills and rules are invoked.

---

## Intake flow

```mermaid
flowchart LR
  A[Copy template] --> B[Fill details]
  B --> C[AI consults skill-index]
  C --> D[Run skills in order]
  D --> E[Apply rules]
  E --> F[Lint]
```

1. **You (the user)** describe the requirement using the **Details to provide** for the matching type below (omit fields covered by **Default assumptions**).
2. **The AI** applies defaults, proposes a **Plan** once (see [Plan confirmation](#plan-confirmation-ai-workflow)), then runs skills after you reply **go**.
3. **The AI** consults **`.cursor/skills/skill-index/SKILL.md`** first, invokes the **Skills to run** in order, applies the **Rules** that match the changed files, and fixes lint issues in touched files (**code-smells-and-best-practices**) before finishing.

---

## Default assumptions (when you don't specify)

The AI fills these unless your message says otherwise. List overrides in your first message (e.g. "public list endpoint", "no soft-delete").

| Area | Default |
| ---- | ------- |
| **Access** | `authenticated` (use `public` only for auth flows, webhooks, health, or explicit public API) |
| **Pagination** | Cursor-based (`PAGINATION.DEFAULT_LIMIT`) on list routes |
| **Soft-delete** | ON for tenant-owned resources; OFF for system tables, audit, immutable billing ledgers |
| **Tenancy** | Scoped by the signed `org` claim / organization context unless marked global |
| **Tests** | Sub-domain unit tests + bundled domain e2e in `src/domains/<domain>/__tests__/<domain>.test.ts` |
| **i18n** | All user-facing strings use translation keys (`errors.*`, `success.*`) |
| **Logging** | `logger` from `@/shared/utils/infrastructure/logger.util.js`; no `console.log` |
| **Object params** | Single options object for 2+ inputs (repository methods keep positional params) |
| **Validation** | Zod DTO in `*.dto.ts` + function validator with `.safeParse()` in `*.validator.ts` |
| **API version** | `/api/v1` prefix for public HTTP routes |
| **Target branch** | Feature work merges to `main` |
| **In-source docs** | TSDoc on every public export, `@remarks` on services / workers / processors / policy files, hand-written `<folder>.overview.md` for new folders, `schema: { summary, description, tags }` on every Fastify route, `pnpm tsdoc:check` must pass |

---

## Full-slice template — one requirement → production-ready slice

Fill this once and run **`/build-requirement`** (or paste it as your prompt). The AI validates it for completeness (missing fields are surfaced, never guessed), then drives the full build chain to a gate-passing vertical slice and emits a **reports bundle**. This is the autonomous path; the type-by-type sections below remain the detailed reference.

### Template

The canonical form is **[`requirement.template.md`](requirement.template.md)** (filled example: **[`requirement.example.md`](requirement.example.md)**). You don't have to fill it — give **`/build-requirement`** a direct task and it drafts the full 9-section document (data model, API, logic, i18n, seed, tests [unit/integration/e2e/smoke/contract/chaos], non-functionals, and a **section-9 file tree**) for your review, asks about anything it shouldn't guess, and iterates before building. Or fill the form yourself; keep the `## N.` headings as-is and mark anything N/A as `none`.

### What `/build-requirement` does

It runs the pipeline (each step is an existing skill), self-healing failed gates and escalating only on genuine ambiguity:

`schema-complete` → **domain-generator** (repository → service → controller → dto/validator/serializer/types → container + route registration) → `route-complete` → **workers-events** (if events) → **seed-maintainer** → **test-generator** → i18n + **tsdoc-export-guard** + **overview-doc-maintainer** + OpenAPI → **/pre-merge-review**.

**Definition of done:** `pnpm validate` + the route/domain gates + a live `pnpm verify:base` smoke + `/pre-merge-review` clean. It emits a **reports bundle** under `docs/builds/<date>-<feature>/`: build report (files, decisions, assumptions, deviations), a requirement→code→test traceability matrix, the review report, and a quality/security summary.

---

## Requirement types and details to provide

### 1. New domain or sub-domain (new resource/API surface)

**Details to provide:**

- **Domain** (must match an existing DB schema): `auth` | `user` | `tenancy` | `billing` | `notify` | `audit` | `upload`
- **Sub-domain name** (domain-prefixed, e.g. `organization-settings`, `member-invitation`): **\*\***\_**\*\***
- **Parent sub-domain** (if nested aggregate child): e.g. `organization` → `organization-api-key`, `webhook` → `webhook-event` — path is `sub-domains/<parent>/<child>/`
- **API shape**: list (GET), get-by-id (GET :id), create (POST), update (PATCH :id), delete (DELETE :id), or custom (describe path + method + body/query)
- **Access**: `public` | `authenticated` | `org-permission:<code>` | `global-role:admin` (or list which routes need which)
- **Database**: Do you need new tables? If yes: table name(s), columns (name, type, constraints) in brief.
- **Dependencies**: Any cross-domain calls? (e.g. "create membership when invitation is accepted")

**Defaults:** Sub-domain folder name is domain-prefixed; REST shape (`GET` list, `GET :id`, `POST`, `PATCH :id`, `DELETE :id`) unless you specify custom routes; tenant tables include `id`, `public_id`, `organization_id` (when tenant-owned), `created_at`, `updated_at`, `deleted_at` when soft-delete applies; one bundled e2e suite at `__tests__/<domain>.test.ts`.

**Skills to run (in order):**

1. **domain-generator** — `.cursor/skills/domain-generator/SKILL.md`
2. **schema-generator** (if new tables) — `.cursor/skills/schema-generator/SKILL.md`
3. **sql-design-guard** — `.cursor/skills/sql-design-guard/SKILL.md`
4. **db-migration-maintainer** (if new tables) — `.cursor/skills/db-migration-maintainer/SKILL.md`
5. **workers-events** (if events/queues/workers) — `.cursor/skills/workers-events/SKILL.md`
6. **route-catalog** — `.cursor/skills/route-catalog/SKILL.md`
7. **route-schema-doc-guard** — `.cursor/skills/route-schema-doc-guard/SKILL.md`
8. **test-generator** — `.cursor/skills/test-generator/SKILL.md`
9. **seed-maintainer** (if seed data needed) — `.cursor/skills/seed-maintainer/SKILL.md`
10. **tsdoc-export-guard** — TSDoc on every public export added — `.cursor/skills/tsdoc-export-guard/SKILL.md`
11. **overview-doc-maintainer** — `<folder>.overview.md` for the new domain (Template A.1) and the new sub-domain (Template A.2) — `.cursor/skills/overview-doc-maintainer/SKILL.md`
12. **system-narrative-maintainer** (only when adding a new domain) — update Domains table in `src/OVERVIEW.md`; add patterns/flows entries if introduced — `.cursor/skills/system-narrative-maintainer/SKILL.md`
13. **structure-maintainer** — `.cursor/skills/structure-maintainer/SKILL.md`
14. **code-smells-and-best-practices** — zero new lint issues in touched files; run `pnpm tsdoc:check` to confirm coverage budget is not exceeded

**Rules that will apply:**  
`core-be-src-architecture.mdc`, `domain-generator-sync.mdc`, `sql-design-guard-sync.mdc`, `no-placeholder-files.mdc`, `code-smells-and-best-practices-sync.mdc`, `testing-conventions.mdc`

---

### 2. New routes only (existing domain/sub-domain)

**Details to provide:**

- **Domain + sub-domain** (e.g. `tenancy` / `organization`): **\*\***\_**\*\***
- **New routes**: for each — HTTP method, path (e.g. `GET /organizations/:id/settings`), request body/query shape (brief), response shape (brief), access (`public` | `authenticated` | `org-permission:...` | `global-role:...`)

**Defaults:** Extend existing sub-domain layers only (no new domain scaffold); list routes use cursor pagination; access `authenticated` unless you name a permission code.

**Skills to run (in order):**

1. **domain-generator** (for layout reference) or implement in existing controller/service/validator/serializer
2. **route-catalog** — `.cursor/skills/route-catalog/SKILL.md`
3. **route-schema-doc-guard** — `.cursor/skills/route-schema-doc-guard/SKILL.md`
4. **test-generator** (add tests for new routes)
5. **seed-maintainer** (if new routes need seed data)
6. **tsdoc-export-guard** — TSDoc on any new public exports introduced by the route work; run `pnpm tsdoc:check`
7. **code-smells-and-best-practices**

**Rules that will apply:**  
`core-be-src-architecture.mdc`, `domain-generator-sync.mdc`, `code-smells-and-best-practices-sync.mdc`, `testing-conventions.mdc`

---

### 3. New event / queue / worker (background job)

**Details to provide:**

- **Domain + sub-domain** (e.g. `notify` / `webhook`): **\*\***\_**\*\***
- **Event name** (if event-driven): **\*\***\_**\*\***
- **Queue name** (BullMQ): **\*\***\_**\*\***
- **Job payload**: list of fields (e.g. `{ webhookId, payload, attempt }`)
- **Worker behavior**: what the worker does (e.g. "HTTP POST to endpoint, retry 3x, update delivery_attempt")
- **Who enqueues**: which service/handler emits the event or calls `enqueue*`

**Defaults:** Processor lives under domain `workers/`; job payload includes `organizationPublicId` for tenant-scoped work; DLQ + retries per existing queue patterns; event-bus handlers must not fail the HTTP request.

**Skills to run (in order):**

1. **workers-events** — `.cursor/skills/workers-events/SKILL.md`
2. **route-catalog** + **route-schema-doc-guard** (if any new HTTP route triggers the job)
3. **test-generator** (if new routes or worker tests)
4. **tsdoc-export-guard** — TSDoc summary + `@remarks` on every new export in `*.worker.ts` / `*.processor.ts` / queue / event files
5. **overview-doc-maintainer** (if a new domain/sub-domain folder is introduced)
6. **system-narrative-maintainer** (if the worker introduces a new pattern or end-to-end flow)
7. **structure-maintainer** (if new dirs)
8. **code-smells-and-best-practices** — run `pnpm tsdoc:check` to confirm coverage budget

**Rules that will apply:**  
`core-be-src-architecture.mdc`, `workers-events-sync.mdc`, `code-smells-and-best-practices-sync.mdc`

---

### 4. New or changed database schema (tables/columns)

**Details to provide:**

- **Domain** (DB schema name): **\*\***\_**\*\***
- **Sub-domain** (if any): **\*\***\_**\*\***
- **Table name** (snake_case, plural): **\*\***\_**\*\***
- **Columns**: name, type (e.g. `text`, `bigint`, `timestamp with time zone`, `jsonb`), `notNull()`, `default()`, unique, FK to table.column. Use `text` everywhere — never `varchar(n)`; enforce real length/format limits with a `CHECK` constraint (see `sql-design-guard` section C).
- **Indexes**: which columns, unique or not
- **Migration**: "add new migration file" or "change existing table X"

**Defaults:** New migration file (forward-only in PR); `text` columns not `varchar(n)`; indexes for FKs and common filters; `IF NOT EXISTS` / safe DDL per **db-migration-maintainer**.

**Skills to run (in order):**

1. **schema-generator** — `.cursor/skills/schema-generator/SKILL.md`
2. **sql-design-guard** — `.cursor/skills/sql-design-guard/SKILL.md`
3. **db-migration-maintainer** — `.cursor/skills/db-migration-maintainer/SKILL.md`
4. **seed-maintainer** (if seed data for new tables)
5. **structure-maintainer** (if new schema file)
6. **code-smells-and-best-practices**

**Rules that will apply:**  
`core-be-src-architecture.mdc`, `sql-design-guard-sync.mdc`, `code-smells-and-best-practices-sync.mdc`

---

### 5. New seed data or change to seeds

**Details to provide:**

- **What to seed**: e.g. "default plan", "super_admin user", "sample organization"
- **Script**: `pnpm db:seed` (minimal) or `pnpm db:seed:full` (full demo)
- **Idempotency**: can the seed run multiple times? (prefer yes)

**Defaults:** Idempotent seeds; minimal script for reference data, full script for demo fixtures; align with [routes.txt](../routes.txt) exposed APIs.

**Skills to run (in order):**

1. **seed-maintainer** — `.cursor/skills/seed-maintainer/SKILL.md`
2. **code-smells-and-best-practices**

**Rules that will apply:**  
`code-smells-and-best-practices-sync.mdc`

---

### 6. Porting from Supabase Edge Functions (migration)

**Details to provide:**

- **Source**: path or description of the Supabase function(s) (e.g. `supabase/functions/_shared/...` or "auth callback")
- **Target domain/sub-domain** in core-be: **\*\***\_**\*\***
- **Routes to expose** (method, path, body, response)
- **Env/secrets**: list any Supabase-specific env vars and their core-be equivalent (e.g. `SUPABASE_URL` → `DATABASE_URL`)

**Defaults:** Target domain follows canonical layout; map Deno handlers to Fastify routes + services; use **env-schema-add** for any new env vars.

**Skills to run (in order):**

1. **supabase-porting** — `.cursor/skills/supabase-porting/SKILL.md`
2. **domain-generator** or extend existing domain
3. **route-catalog** + **openapi-route-sync**
4. **test-generator**
5. **structure-maintainer**
6. **code-smells-and-best-practices**

**Rules that will apply:**  
`core-be-src-architecture.mdc`, `domain-generator-sync.mdc`, `code-smells-and-best-practices-sync.mdc`, `testing-conventions.mdc`

---

### 7. ESLint / pre-commit / CI / security pipeline change

**Details to provide:**

- **What changes**: e.g. "add rule X", "run Semgrep in CI", "change audit level"
- **Files**: `biome.json`, `.husky/pre-commit`, `.github/workflows/pr-ci.yml`, `.github/workflows/post-merge-ci.yml`, `.gitleaks.toml`, `.semgrepignore`, etc.

**Defaults:** PR merge gate stays **pr-ci.yml** + **pr-governance.yml**; post-merge deploy/release stays **post-merge-ci.yml**; do not weaken required checks in rulesets.

**Skills to run (in order):**

1. **code-quality-guard** — `.cursor/skills/code-quality-guard/SKILL.md`
2. **code-smells-and-best-practices** (if code under `src/` is touched)

**Rules that will apply:**  
`code-quality-guard-sync.mdc`, `code-smells-and-best-practices-sync.mdc`

---

### 8. Middleware / infra / security / production hardening

**Details to provide:**

- **What**: e.g. "add rate limit for login", "enable RLS for table X", "circuit breaker for new client"
- **Where**: middleware, `connection.ts`, `env.config.ts`, etc.

**Defaults:** Follow existing middleware registration in `src/shared/middlewares/`; document operational impact in the matching runbook under `docs/deployment/runbooks/` or `docs/reference/security/`.

**Skills to run (in order):**

1. **production-hardening-guard** — `.cursor/skills/production-hardening-guard/SKILL.md`
2. **structure-maintainer** (if new files or layout)
3. **code-smells-and-best-practices**

**Rules that will apply:**  
`production-hardening.mdc`, `core-be-src-architecture.mdc`, `code-smells-and-best-practices-sync.mdc`

---

### 9. Rename / move files or folders (structure change)

**Details to provide:**

- **Current path(s)**: **\*\***\_**\*\***
- **New path(s)**: **\*\***\_**\*\***
- **Reason**: e.g. "align with domain naming", "split sub-domain"

**Defaults:** Mechanical rename with import path updates; sync **structure-maintainer** artifacts (CLAUDE.md, skills, rules) when layout docs change.

**Skills to run (in order):**

1. **structure-maintainer** — `.cursor/skills/structure-maintainer/SKILL.md`
2. **domain-generator** (if domain layout changes)
3. **route-catalog** (if route files move)
4. **code-smells-and-best-practices**

**Rules that will apply:**  
`structure-maintainer-sync.mdc`, `core-be-src-architecture.mdc`, `domain-generator-sync.mdc` (if routes), `code-smells-and-best-practices-sync.mdc`

---

### 10. PR babysit / fix CI on a pull request

**Details to provide:**

- **PR number or branch name**
- **Failing check name(s)** (if known)
- **Scope**: fix only this PR vs also merge latest base branch

**Defaults:** Apply [pr-review.md](../process/pr-review.md) rubric; merge/rebase base branch when behind; never weaken CI to go green.

**Skills to run (in order):**

1. **ci-investigator** (if diagnosing one check) — `.cursor/skills/ci-investigator/SKILL.md`
2. **pr-babysit** — `.cursor/skills/pr-babysit/SKILL.md`
3. **before-commit-guard** (if pre-commit fails locally)
4. Skills from **skill-index** matching the code you change (routes, migrations, contract/chaos tests, etc.)

---

### 11. Split work into multiple PRs

**Details to provide:**

- **Goal** of the overall work
- **Preferred split** (optional): by domain, migration-first, etc.
- **Whether stacking** is acceptable

**Defaults:** Smallest reviewable slices (schema → API → workers); each slice should pass `pnpm ci:quality` or full gate as appropriate.

**Skills to run:**

1. **split-to-prs** — `.cursor/skills/split-to-prs/SKILL.md`
2. Per-slice skills from **skill-index** after each PR is carved out

---

### 12. Other or mixed requirement

**Details to provide:**

- **Goal**: 1–2 sentences.
- **Scope**: which domains/files (e.g. "billing and tenancy", "only auth controller").
- **Acceptance**: how to verify (e.g. "GET /api/v1/billing/plans returns 200", "lint and tests pass").

**Defaults:** Infer requirement type from scope; apply global defaults above; run **skill-index** triggers for every file category touched.

**Skills to run:**

- **Always:** Consult **skill-index** first, then run any skill whose trigger matches your changes.
- **Always:** **code-smells-and-best-practices** after editing `src/**/*.ts` (fix touched files; pre-commit/CI run full validate).
- **If routes change:** **route-schema-doc-guard**, **route-catalog**, **openapi-multilingual** (new tags), **seed-maintainer**.
- **If domain/structure changes:** **structure-maintainer**, **domain-generator** (if new scaffold).

**Rules that will apply:**  
All `.cursor/rules/*.mdc` whose globs match the files you change (see skill index "Auto-trigger rules" table).

---

## Plan confirmation (AI workflow)

After you send a requirement, the AI proposes **one** plan before editing code. You should not get repeated clarification questions unless something is destructive.

```mermaid
flowchart LR
  Intake[Intake details] --> Defaults[Apply smart defaults]
  Defaults --> Plan[AI proposes Plan]
  Plan --> Confirm{User: go / tweak / stop}
  Confirm -- go --> Execute[Run skills + edit]
  Confirm -- tweak --> Plan
  Confirm -- stop --> End[Stop]
```

### Plan contents (AI posts once)

1. **Requirement type** (1–12) and one-line goal.
2. **Fields** — what you provided vs what defaults apply.
3. **Skills** — ordered list from the matching section above.
4. **Files** — create/modify paths (domains, migrations, docs, workflows).
5. **Verification** — commands (e.g. `pnpm test`, `pnpm routes:catalog:check`, targeted domain test).

### Your reply

| Reply | Meaning |
| ----- | ------- |
| **go** | Proceed; no more questions unless a blocker below appears |
| **tweak …** | Adjust plan; AI revises plan once more if needed, then executes on next **go** |
| **stop** | Do not implement |

### When the AI may ask again (after **go**)

- Irreversible data loss or production-only secret handling.
- Breaking API contract without you acknowledging **Major** release.
- Ambiguous ownership between two domains with no default.

---

## Quick reference: all skills

| Skill                          | Path                                                     | When to invoke                                            |
| ------------------------------ | -------------------------------------------------------- | --------------------------------------------------------- |
| **skill-index**                | `.cursor/skills/skill-index/SKILL.md`                    | **First** — full catalog and triggers (44 project skills) |
| domain-generator               | `.cursor/skills/domain-generator/SKILL.md`               | New domain/sub-domain scaffold                            |
| route-catalog                  | `.cursor/skills/route-catalog/SKILL.md`                  | Any change to `*.routes.ts`                               |
| route-schema-doc-guard         | `.cursor/skills/route-schema-doc-guard/SKILL.md`         | Route `schema: { summary, description, tags }`          |
| workers-events                 | `.cursor/skills/workers-events/SKILL.md`                 | Events, queues, workers                                   |
| schema-generator               | `.cursor/skills/schema-generator/SKILL.md`               | New/changed Drizzle schema                                |
| sql-design-guard               | `.cursor/skills/sql-design-guard/SKILL.md`               | Schema design review                                      |
| db-migration-maintainer        | `.cursor/skills/db-migration-maintainer/SKILL.md`        | SQL in `migrations/`                                      |
| test-generator                 | `.cursor/skills/test-generator/SKILL.md`                 | Tests, validators, serializers                            |
| seed-maintainer                | `.cursor/skills/seed-maintainer/SKILL.md`                | Seed scripts or seed data                                 |
| structure-maintainer           | `.cursor/skills/structure-maintainer/SKILL.md`           | Renames, moves, layout sync                               |
| supabase-porting               | `.cursor/skills/supabase-porting/SKILL.md`               | Supabase Edge Functions → core-be (manual)                |
| code-quality-guard             | `.cursor/skills/code-quality-guard/SKILL.md`             | ESLint, Husky, CI security                                |
| production-hardening-guard     | `.cursor/skills/production-hardening-guard/SKILL.md`     | Middleware, infra, security                               |
| path-to-production-gate        | `.cursor/skills/path-to-production-gate/SKILL.md`        | Pre-release / deploy review                               |
| code-smells-and-best-practices | `.cursor/skills/code-smells-and-best-practices/SKILL.md` | Any edit under `src/`                                     |
| lint-warnings-handler          | `.cursor/skills/lint-warnings-handler/SKILL.md`          | Detail guide (via code-smells)                            |
| i18n-message-guard             | `.cursor/skills/i18n-message-guard/SKILL.md`             | User-facing messages / locales                            |
| openapi-multilingual           | `.cursor/skills/openapi-multilingual/SKILL.md`           | OpenAPI locale files                                      |
| env-schema-add                 | `.cursor/skills/env-schema-add/SKILL.md`                 | Env schema / `.env.example` (Secret vs Variable, sub-section choice) |
| docs-maintainer                | `.cursor/skills/docs-maintainer/SKILL.md`                | Hand-written `docs/` changes                              |
| docs-audit                     | `.cursor/skills/docs-audit/SKILL.md`                     | Full docs review (on request)                             |
| setup-infra-maintainer         | `.cursor/skills/setup-infra-maintainer/SKILL.md`         | `tooling/setup/` providers                                |
| ide-productivity-guard         | `.cursor/skills/ide-productivity-guard/SKILL.md`         | `.vscode/` project IDE config                             |
| dependency-security            | `.cursor/skills/dependency-security/SKILL.md`            | `package.json` / lockfile                                 |
| before-commit-guard            | `.cursor/skills/before-commit-guard/SKILL.md`            | Failed pre-commit / commit-ready                          |
| change-completeness-guard      | `.cursor/skills/change-completeness-guard/SKILL.md`      | Finishing any change — DoD: tests + cross-cutting + docs + rules + skills |
| pr-babysit                     | `.cursor/skills/pr-babysit/SKILL.md`                     | PR merge-ready loop (CI + comments)                       |
| split-to-prs                   | `.cursor/skills/split-to-prs/SKILL.md`                   | Split branch into reviewable PRs                          |
| ci-investigator                | `.cursor/skills/ci-investigator/SKILL.md`                | Diagnose one failing CI check                             |
| contract-test-maintainer       | `.cursor/skills/contract-test-maintainer/SKILL.md`       | Stripe/Resend/S3 nock contracts                           |
| chaos-test-maintainer          | `.cursor/skills/chaos-test-maintainer/SKILL.md`          | Toxiproxy chaos tests                                     |
| cursor-global-skills           | `.cursor/skills/cursor-global-skills/SKILL.md`           | Reference: Cursor built-in skills                         |
| **system-narrative-maintainer**| `.cursor/skills/system-narrative-maintainer/SKILL.md`    | Hand-authored `src/OVERVIEW.md` / `src/PATTERNS.md` / `src/FLOWS.md` / `src/POLICIES.md` |
| **overview-doc-maintainer**    | `.cursor/skills/overview-doc-maintainer/SKILL.md`        | Per-folder `<folder>.overview.md` (hand-written) |
| **route-schema-doc-guard**     | `.cursor/skills/route-schema-doc-guard/SKILL.md`         | Fastify route `schema: { summary, description, tags }`    |
| **tsdoc-export-guard**         | `.cursor/skills/tsdoc-export-guard/SKILL.md`             | TSDoc on every public export + `@remarks` on services / workers / processors / policy files; gated by `pnpm tsdoc:check` |

---

## Quick reference: rules

**Canonical inventory:** [skill-index → Always-applied rules, Policy rules, and Auto-trigger rules](../../.cursor/skills/skill-index/SKILL.md#auto-trigger-rules).

Rules auto-attach by file glob when you edit matching paths. Always-on: **engineering-principles.mdc**, **project-identity.mdc**. All others are scoped — see skill-index for the full table (44 rules).

---

**Summary:** For any new requirement, give the **details** from the matching section above (defaults fill the rest). The AI posts a **Plan** once; after **go**, it consults **skill-index**, runs **skills** in order, and **rules** auto-invoke on changed files. Before opening a PR, use [pr-review.md](../process/pr-review.md) and [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md).
