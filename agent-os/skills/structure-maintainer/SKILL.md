---
name: structure-maintainer
description: Keeps core-be project structure standards up to date. Use after any directory/file naming changes, new layers, or moving code across domains/infrastructure/shared/tooling/tests.
trigger: CLAUDE.md, AGENTS.md, agent-os/rules/**, agent-os/skills/**, agent-os/agents/**, agent-os/mcp/**, .mcp.example.json, .mcp.default.json
triggerNote: Structure/naming; MCP template mirrors must stay identical (mcp-config test)
indexNote: keep project structure/naming standards + docs/rules in sync
---

# Structure maintainer (core-be)

## Purpose

This skill ensures that when the **project structure changes**, the repo's "source of truth" docs and Cursor rules/skills are updated **in the same PR** so the conventions don't drift.

## After updating code structure: update these

Whenever you change code structure (e.g. add a domain, rename layers, add infrastructure), you **must** update the following so rules and skills stay in sync:

- **Rules:** `agent-os/rules/core-be-src-architecture.mdc` — ensure it matches current layout and naming. `agent-os/rules/seed-conventions.mdc` (if the `seed/` dir layout or seed contract changed).
- **Skills:**
  - `agent-os/skills/domain-generator/SKILL.md` (scaffolding and sub-domain list)
  - `agent-os/skills/workers-events/SKILL.md` (if events/queues/workers paths changed)
  - `agent-os/skills/seed-maintainer/SKILL.md` (if the `seed/` dir layout, seed contract, or tiers changed)
  - `agent-os/skills/supabase-porting/SKILL.md` (if Supabase porting conventions changed)
  - `agent-os/skills/db-migration-maintainer/SKILL.md` (if SQL migration conventions changed)
  - `agent-os/skills/test-generator/SKILL.md` (if test layout or scripts changed)
  - `agent-os/skills/overview-doc-maintainer/SKILL.md` (if a new folder role appears that needs a new `<folder>.overview.md` template)
  - `agent-os/skills/tsdoc-export-guard/SKILL.md` (if the TSDoc coverage gate inputs changed)
  - Any other `agent-os/skills/*/SKILL.md` that references paths or layer names
- **Docs:** `CLAUDE.md` (architecture and domain layout), `README.md` (project structure and diagrams), `AGENTS.md` (agent entry + custom subagents).
- **Agents:** `agent-os/agents/*.md` — keep in sync with **AGENTS.md** custom subagents table when adding or renaming subagents.
- **System narratives**: when a new domain folder appears under `src/domains/`, also invoke **system-narrative-maintainer** to add the row to `src/OVERVIEW.md` Domains table.

Then run the **Checklist** below and verify with `pnpm typecheck` (and tests if applicable).

## Current source-of-truth conventions

### Canonical domain layout (required)

Domain folder = DB schema. Multi-resource domains use `sub-domains/` for API resources. **Sub-domains may contain nested sub-domains** (aggregate children). Flat domains (`audit`, `upload`) keep layers at domain root.

```text
src/domains/<domain>/
  <domain>.routes.ts
  <domain>.container.ts
  events/                     # optional: register<Domain>EventHandlers() aggregator
  seed/                       # optional: when this level owns tables (see Seed layout)
  __tests__/                  # domain e2e, unit, factories (see Test layout)
  sub-domains/                # required except audit, upload
    <sub-domain>/             # top-level resource
      ... layers ...
      seed/                   # optional: when this resource owns tables
      __tests__/unit/         # optional
      events/ | queues/ | workers/   # optional
      <nested-sub-domain>/    # optional aggregate child (webhook-event, organization-api-key, …)
        ... layers ...
        seed/                 # optional: when this child owns tables
        __tests__/unit/
```

Import: `@/domains/<domain>/sub-domains/<sub-domain>/...` or `@/domains/<domain>/sub-domains/<parent>/<nested>/...`.

### Import path conventions

| Tree | Allowed | Forbidden |
| ---- | ------- | --------- |
| `src/**/*.ts` | `@/domains/...`, `@/shared/...`, `@/infrastructure/...`, `@/core/...`; same-folder `./` | Parent-relative `../` |
| `tooling/**/*.ts` | `@tooling/setup/...`, `@tooling/openapi/...`, etc.; same-folder `./` | Parent-relative `../` |

Enforced by `src/tests/global/import-paths.global.test.ts`. Rule: `agent-os/rules/import-paths.mdc`.

### Infrastructure layout

```text
src/infrastructure/
  database/
    connection.ts             # Postgres + Drizzle
    base-repository.ts        # Pagination helper
    transaction.ts            # withTransaction()
    pg-schemas.ts             # Shared pgSchema definitions
    pool/                     # Pool tuning helpers
    safety/                   # Statement timeout, RLS helpers
    utils/                    # Shared DB utilities
    contexts/          # database-context.ts (3 scope patterns + dispatcher) + database-context-runtime.ts
    migration/         # migrate.ts, migration runner
  cache/
    redis.client.ts           # Redis connection (+ bullmq-redis.client.ts, redis-lock.util.ts,
                              # redis-prefix / redis-url / redis-url.parse utils, redis.constants.ts,
                              # assert-redis-tls-safety.ts, redis-topology-warn.util.ts)
  queue/
    connection.ts             # Queue Redis re-export + getBullMQConnectionOptions
    health.ts                 # BullMQ readiness helper
    scheduler.ts              # Repeatable retention job registration
    queue.constants.ts        # Shared queue names / constants
    bootstrap.ts              # Domain worker registration + DLQ hooks
    queue-dashboard.ts        # Optional Bull Board
    dlq/               # DLQ: dead-letter.ts, dead-letter.repository.ts, dead-letter.schema.ts, dlq-auto-retry.worker.ts
    commit-dispatch/   # Recovery worker, executor, store
    worker-runtime/    # worker-options.ts, worker-registration.registry.ts
  mail/
    mail.service.ts
    mail-outbox.repository.ts
    mail-outbox.schema.ts
    resend-api.error.ts
    queues/
    workers/
    templates/
  storage/
    storage.service.ts        # + object-storage.port.ts, s3-adapter.ts, s3-error.util.ts, public-media-url.util.ts
  payment/
    stripe.client.ts          # Stripe SDK client + helpers (customer, subscription, webhook)
  outbound/            # Outbound HTTP call safety (outbound-fetch / call / defaults / error / redaction)
  resilience/          # Circuit breaker + retry-with-backoff (circuit-breaker.ts, retry-with-backoff.util.ts, lua/)
  api-reference/       # API reference helpers (scalar-api-reference.ts)
  observability/       # sentry/, tracing/ (OTel), metrics/, idempotency-cardinality/, dlq-depth/,
                       # redis-saturation/, posthog/, unhandled-rejection.handler.ts
  mcp/                 # mcp-server.ts, mcp-capabilities.ts, mcp-client-guide.ts
```

### Shared layout

```text
src/shared/
  config/env.config.ts
  errors/{app,validation,auth,configuration}.error.ts, index.ts
  types/index.ts
  constants/index.ts
  utils/                      # grouped by concern (http/, security/, infrastructure/, …)
  middlewares/
    core/                     # auth, error-handler, health, request-context, …
    security/                 # cors, helmet, captcha, …
    session/                  # cookie session helpers
    tenant/                   # organization-rls-transaction settlement stub (header middleware removed)
    rate-limit/               # global + route presets
    index.ts                  # registerMiddleware()
  locales/                    # i18next resources (en/, es/ — common, errors, mail, success, openapi)
```

### Core layout

```text
src/core/
  events/            # event-bus.ts, register-event-handlers.ts
```

### Repo root tooling (`tooling/`)

Outside `src/` — not part of the runtime app. Do not merge with `src/scripts/` (those may import `@/`).

```text
tooling/
  setup/              # Project/environment scaffolding helpers (agent/, codegen/, common/, envs/, github/, railway/);
                      # the external-infra wizard lives in a separate infrastructure repository
  setup/setup.config.json   # Canonical project + hosted-environment config (committed)
  agent-os/           # agent-os generators, checks, lock (pnpm agent-os:*)
  audit/              # Dependency/audit tooling
  chaos/              # Toxiproxy chaos harness support
  ci/                 # Build/CI guards (check-dockerfile-sync.mjs, check-dist-imports.mjs)
  dev/                # Local dev helpers (wait-for-local-postgres.sh → pnpm compose:wait)
  openapi/            # OpenAPI + route catalogs (route-catalog/, route-examples/)
  route-coverage/     # Route success-coverage budget (route-success-coverage-budget.json)
  sonar/              # Local SonarQube gate scripts
  tsdoc-coverage/     # TSDoc coverage ratchet (budget.json)
  validate/           # health-check.sh, lockfile-sync.sh
  vitest/             # Vitest project configs (projects.ts, chaos/contract configs)
```

### Build-time scripts

```text
src/scripts/    # Build-time + operational scripts (may import @/, unlike tooling/)
  admin/        # admin-token, load-test-credentials, dlq-replay, rotate-field-secrets, worker-health, …
  codegen/      # generate-openapi.ts → docs/openapi/openapi.json, generate-route-catalog.ts,
                # generate-project-structure-tree.ts, generate-dbdiagram.ts, Postman/Scalar uploads, …
  ops/          # api-smoke-test, db-migrate-dry-run, jwt/secrets key rotation, memory-soak, settle-check, …
  seed/         # seed orchestrator + contract (bulk.ts, bulk-config.ts, seed-contract.ts,
                # production-guard.ts, seed-registry.ts, minimal.ts, full.ts); <folder>.overview.md
  tooling/      # run-pre-commit-guard.ts and other repo-tooling entry points
  validators/   # validate-domain.ts + domain/route/constants validators (pnpm validate:*)
```

### Seed layout

- Every folder that **owns tables** (domain, sub-domain, nested sub-domain) carries a co-located `seed/` dir: `<name>.reference.seed.ts`, `<name>.bulk.seed.ts`, `<name>.faker.ts`, `index.ts`.
- `seed/index.ts` exports a `SeedContribution` **except** a top-level domain's, which exports a `DomainSeedModule` (`name` + `dependsOn`). Parents fold children up with `composeContributions(...)`; the orchestrator (`src/scripts/seed/bulk.ts`) registers one module per domain.
- Three tiers: `pnpm db:seed` (reference) · `pnpm db:seed:full` (demo) · `pnpm db:seed:bulk` (scaled). Detail: **seed-maintainer**, `agent-os/rules/seed-conventions.mdc`, `src/scripts/seed/seed.overview.md`.
- **Validator allowlist**: `seed/` is permitted at domain root by the domain-structure validator (`src/scripts/validators/domain/validate-domain.ts`).

### Test layout

- **Vitest** (all under `src/`):
  - **Common**: `src/tests/` — helpers, shared factories, security, performance, global, chaos, contract.
  - **Domain bundled e2e**: `src/domains/<domain>/__tests__/<domain>.test.ts`.
  - **Domain unit / policy**: `src/domains/<domain>/__tests__/unit/`.
  - **Domain factories**: `src/domains/<domain>/__tests__/factories/` (e.g. tenancy `permission.factory.ts`).
  - **Sub-domain unit**: `sub-domains/<r>/__tests__/unit/` or `sub-domains/<parent>/<child>/__tests__/unit/`.
  - **Sub-domain e2e** (optional): `sub-domains/<parent>/<child>/__tests__/<child>.test.ts`.
  - **Event handlers / emit**: `sub-domains/<r>/__tests__/unit/events/` (never `events/__tests__/`)
- **Commands**: `pnpm test:unit` (unit + `__tests__/unit/events/`); `pnpm test:e2e` (excludes `__tests__/unit/`); `pnpm test` runs all.
- **k6 load**: `src/tests/load/k6/` (not Vitest).
- **Detail**: `agent-os/skills/test-generator/SKILL.md`, `agent-os/rules/testing-conventions.mdc`.

### Naming rules

- **Full names only**: `repository` not `repo`, `organization` not `org`, `database` not `db`, `request` not `req` (except Fastify conventions).
- **Sub-domain directories**: always domain-prefixed (`user-settings`, `organization-settings`, `member-role-permission`, `webhook-event`).
- **Drizzle schema**: snake_case column property names matching Postgres.

## Mandatory update targets when structure changes

When any of the above conventions change, update these files so they remain accurate:

- `agent-os/skills/skill-index/SKILL.md` (master skill trigger map and enforcement layers — update when adding skills or changing pre-commit/CI checks)
- `CLAUDE.md` (human-facing architecture rules)
- `README.md` (high-level structure overview + Architecture Diagrams: API Request Flow, Event-Bus and BullMQ Flow)
- `agent-os/rules/core-be-src-architecture.mdc` (Cursor rule enforcement hints)
- `agent-os/skills/domain-generator/SKILL.md` (scaffolding conventions)
- `agent-os/skills/workers-events/SKILL.md` (events/queues/workers conventions)
- `agent-os/skills/supabase-porting/SKILL.md` (Supabase porting)
- `agent-os/skills/db-migration-maintainer/SKILL.md` (SQL migrations)
- `agent-os/skills/test-generator/SKILL.md` (testing pyramid and layout)
- `agent-os/skills/openapi-route-sync/SKILL.md` (OpenAPI route metadata)
- `agent-os/skills/cursor-global-skills/SKILL.md` (Cursor built-in skills reference)
- `agent-os/skills/route-catalog/SKILL.md` (route listing conventions)
- `agent-os/skills/code-quality-guard/SKILL.md` (ESLint, pre-commit, CI security pipeline)
- Any other `agent-os/skills/*/SKILL.md` that references paths or layer names
- **Docs**: When docs are reorganized or renamed, run **docs-maintainer** to update `docs/README.md` and cross-links (see `agent-os/skills/docs-maintainer/SKILL.md`).
- **Load-test docs**: `docs/reference/testing/load-testing.md` and `src/tests/load/k6/README.md` must stay in sync when k6 scenarios (`src/tests/load/k6/scenarios/*.js`), load-test scripts (`src/scripts/admin/load-test-credentials.ts`, `src/scripts/admin/admin-token.ts`), or npm scripts (`load:health`, `load:auth`, `tool:load-test-credentials`, `tool:admin-token`; legacy `scripts:*`) change.

## Checklist (run every time)

1. **Scan for drift**
   - Search for old folder/layer names (e.g. `handlers/`, `repos/`, `schemas/`, `guards/`, `plugins/`) and update references.
   - Ensure examples use current filenames: `*.controller.ts`, `*.repository.ts`, `*.validator.ts`, `*.dto.ts`, `*.serializer.ts`.

2. **Confirm dependency boundaries**
   - Controllers import services (or container deps) only (no repositories/database).
   - Services import own repositories/validators + shared errors/core utilities.
   - Repositories import database connection/schemas + own domain types only.

3. **Confirm naming conventions**
   - Full names in code and file names (`repository`, `organization`, `database`, `request`).
   - Sub-domain directories use domain prefix.

4. **Update rule text**
   - Ensure `agent-os/rules/core-be-src-architecture.mdc` matches the current structure and naming.

5. **Verify**
   - `pnpm typecheck`
   - `pnpm test` (or at least ensure tests compile if integration is skipped)

## Output expectation

When invoked, return:

- A list of structure changes detected
- Exact file updates made (docs/rules/skills)
- Any follow-up suggestions (optional)
