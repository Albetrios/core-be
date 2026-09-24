# Claude Code Guidelines for core-be

## New requirements — intake format

For **any new requirement** (new domain, routes, worker, schema, etc.), use the format and checklist in **`docs/getting-started/requirement-intake.md`**. That doc defines what details to provide and which skills/rules to invoke so the AI can perform best and keep docs, routes, tests, and lint in sync. Consult **`agent-os/skills/skill-index/SKILL.md`** first, then run the skills listed for the requirement type.

## Reuse before you create

Before adding a helper, wrapper, env var, constant or pattern, find the one that already does the job and use it; create something new only when nothing fits. If an existing one is close but not right, improve it — or say in the PR why new is better — **in the same PR**, never leaving old and new side by side. Detail and examples: principle #3 in [`agent-os/docs/principles.md`](agent-os/docs/principles.md).

## AI agent references (`agent-os/`)

`agent-os/` at the repo root is the single source of truth for all AI tooling.
Cursor reads agents/skills/rules via symlinks (`.cursor/agents → agent-os/agents`, etc.).
Claude Code reads `agent-os/` directly via `.claude/` symlinks (`agents`, `skills`, `commands`, `hooks`) — there is intentionally **no** `.claude/rules`: Claude Code follows `CLAUDE.md`, while the `.mdc` rule files are Cursor's glob auto-attach (`.cursor/rules`).

| File                                                                   | Purpose                                                                                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`REVIEW.md`](REVIEW.md)                                               | Review-time severity + skip-path instructions for `/code-review`, `/pre-merge-review`, and review agents              |
| [`agent-os/docs/principles.md`](agent-os/docs/principles.md)           | Engineering principles + project identity (full detail)                                                               |
| [`agent-os/docs/skill-triggers.md`](agent-os/docs/skill-triggers.md)   | File pattern → skill map (replaces reading 25 sync rules)                                                             |
| [`agent-os/docs/agents-catalog.md`](agent-os/docs/agents-catalog.md)   | All 11 agents with descriptions and use-when                                                                          |
| [`agent-os/docs/platform-access.md`](agent-os/docs/platform-access.md) | How to invoke agents on Cursor, Claude Code, Codex                                                                    |
| [`agent-os/agents/`](agent-os/agents/)                                 | Agent definition files                                                                                                |
| [`agent-os/skills/`](agent-os/skills/)                                 | Skill definition files                                                                                                |
| [`agent-os/rules/`](agent-os/rules/)                                   | Cursor rule files (also accessible via `.cursor/rules/` symlink)                                                      |
| [`agent-os/hooks/`](agent-os/hooks/)                                   | Claude Code hook scripts                                                                                              |
| [`agent-os/commands/`](agent-os/commands/)                             | Cross-platform custom slash commands (Claude `.claude/commands`, Cursor `.cursor/commands`, Codex `~/.codex/prompts`) |

## API Contract (Non-Negotiable)

See **`agent-os/skills/api-contract-guard/SKILL.md`** (rule: `agent-os/rules/api-contract.mdc`):

- Route params: snake_case + semantic (`{plan_id}`, `{subscription_id}`, never `{id}`); entity-id params registered in `PARAM_NAME_TO_ENTITY` (non-entity params — `{provider}`, `{slug}` — are the only exemptions). The active organization is the signed `org` JWT claim — routes carry NO `{organization_id}` path segment; the active-organization resource is singular `/tenancy/organization` (sub-resources nest under it); switch active organization via `/auth/switch-to-personal` / `/auth/switch-to-organization`
- Public ids: Paddle-style `<prefix>_<21 [a-z0-9]>` via `generatePublicId(entity)`; external field is always `id`
- Body field casing: request body (`*.dto.ts`) and response body (`*.serializer.ts`) property keys are **snake_case** (`file_name`, `created_at`); the external id stays `id`; validation `errors[].field` values are snake_case too. Internal TS identifiers may stay camelCase. Exceptions passed through verbatim: third-party/browser-native payloads (Stripe webhooks, OAuth, WebAuthn W3C JSON) and JWT claims. Enforced by `src/tests/unit/api/snake-case-body-keys.policy.unit.test.ts`
- Method→status policy: success is **200** for every method except DELETE (**204**) — no exemptions (Stripe-shaped uniform model; 200 stays true for idempotent replays and upserts where 201 would lie). POST is middleware-enforced (`method-status-policy.middleware.ts` rewrites POST 201/202/204 → 200); the other methods are enforced by the `validate:route-success-coverage` gate
- Error codes: when to set 400/401/403/404/406/409/413/415/422/429 — see **`docs/reference/api/response-codes.md`** (400 on all POST/PATCH/PUT, omitted only when truly nothing to validate; 409/422 mutating only; never invent statuses)
- Headers: `Authorization: Bearer`, `X-Idempotency-Key` (required on the `idempotencyRequired` writes; see the `I` column in `docs/routes.txt`), `X-Captcha-Token` (public auth forms), `X-CSRF-Token` (refresh only), `Stripe-Signature` (Stripe-sent); ecosystem X- forms kept (`X-Request-Id`, `X-Api-Key`, `X-RateLimit-*`, …)

## Architecture Rules (Non-Negotiable)

- HTTP controllers **coordinate**, never enforce invariants
- Services express **intent**; they may wrap a unit of work in `withTransaction` for atomicity, but issue no raw SQL and own no DB connection — repositories own the SQL
- Postgres is the **only source of truth**
- Workers are **pull-based**, never push-based
- Cross-domain service imports are **allowed** for READ/WRITE where needed
- Cross-domain reads/writes are handled via service imports (no separate use-cases layer)

## Naming Conventions (Non-Negotiable)

Detail and examples live in scoped Cursor rules (auto-attach when editing `src/**/*.ts`):

- **[full-names-only.mdc](.cursor/rules/full-names-only.mdc)** — no abbreviations in identifiers OR prose (`organization` not `org`, incl. plurals/compounds); intentional compact WIRE literals are the only survivors — the `org_` public-id prefix, the JWT claim keys `org`/`sv`, third-party payloads; Fastify `req`/`reply` exempt
- **[object-params.mdc](.cursor/rules/object-params.mdc)** — options objects for 2+ params; repos and framework callbacks exempt
- **[no-digits-in-names.mdc](agent-os/rules/no-digits-in-names.mdc)** — no digits in identifiers we own (`firstPage`, never `page1`); a digit is a version, a duplicate or a shrug. Exempt: the API `v1` segment, vendor/standard names (`S3`, `OAuth2`, `SHA256`), a third-party export renamed **at the import**, audit-finding citations in comments, and digits in values
- Sub-domain folders **must** prefix with domain/resource name (`organization-settings`, `webhook-event`, …)

## Domain Structure

Domains live under `src/domains/<domain>/`. Each domain has sub-domains with this layout:

### Canonical layout

```text
src/domains/<domain>/
  <domain>.routes.ts          # Route registration (FastifyPluginAsync)
  <domain>.container.ts       # DI container (repos → services); export services for routes/controllers
  events/                     # Optional: register<Domain>EventHandlers() aggregator
    index.ts
  seed/                       # Optional: present when this level owns tables (see Seeding)
    index.ts                  # Domain root: exports a DomainSeedModule (name + dependsOn)
    <domain>.reference.seed.ts  # Idempotent reference/bootstrap data
    <domain>.bulk.seed.ts     # Scaled rows for tables this level owns
    <domain>.faker.ts         # Level-specific faker generators
  __tests__/                  # Domain e2e, domain-level unit, domain factories (see Testing)
    <domain>.test.ts
    factories/                # Optional: cross-sub-domain test helpers (e.g. tenancy permission.factory)
    unit/
  sub-domains/                # Multi-resource domains only (omit for audit, upload)
    <sub-domain>/             # Top-level resource (sibling under sub-domains/)
      <sub-domain>.controller.ts
      <sub-domain>.service.ts
      <sub-domain>.repository.ts
      <sub-domain>.dto.ts
      <sub-domain>.validator.ts
      <sub-domain>.serializer.ts
      <sub-domain>.types.ts
      <sub-domain>.schema.ts  # When this resource owns tables
      seed/                   # Optional: present when this resource owns tables
        index.ts              # Sub-domain: exports a SeedContribution (parent composes it)
        <sub-domain>.reference.seed.ts
        <sub-domain>.bulk.seed.ts
        <sub-domain>.faker.ts
      __tests__/              # Sub-domain unit, nested e2e (see Testing)
        unit/                 # incl. events/ — leaf event-handler suites (never events/__tests__/)
        <sub-domain>.test.ts  # Optional: dedicated route suite (tenancy organization children)
      events/                 # Optional: types, handlers, *-emit.ts
      queues/                 # Optional: BullMQ enqueue helpers
      workers/                # Optional: BullMQ processors
      <nested-sub-domain>/    # Optional: aggregate child (lifecycle tied to parent)
        <nested-sub-domain>.controller.ts
        ...                   # Same layer files as parent sub-domain
        seed/                 # Optional: SeedContribution when this child owns tables
        __tests__/unit/       # Tests co-located on the nested resource
```

**Import path:** `@/domains/<domain>/sub-domains/<sub-domain>/...` or, for nested children, `@/domains/<domain>/sub-domains/<parent>/<nested>/...`.

Flat domains (`audit`, `upload`) keep layers at domain root (no `sub-domains/`). Bundled domains (`auth`, `user`) use `sub-domains/` for resources; domain root may also have `<domain>.controller.ts`, `<domain>.service.ts`, etc.

### Domain and sub-domain mapping

| Domain (folder) | Sub-domains (folders)                                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **audit**       | (single domain, no sub-domains)                                                                                                                                                                                                                                                             |
| **auth**        | auth-method (email verification-code, oauth as services in auth-method/; verification-token/ nested persistence module — service/repository/schema, no routes), auth-session, auth-mfa, auth-mfa-session (Redis MFA challenge-ticket store shared by auth-mfa/auth-webauthn), auth-webauthn |
| **user**        | user-settings, user-notification-preferences, user-data-export                                                                                                                                                                                                                              |
| **tenancy**     | organization (organization-settings, organization-notification-policy, organization-api-key), membership (member-invitation), member-roles (member-role-permission), permission                                                                                                             |
| **billing**     | plan, subscription, stripe-webhook                                                                                                                                                                                                                                                          |
| **notify**      | notification, webhook (webhook-event, webhook-delivery)                                                                                                                                                                                                                                     |
| **upload**      | (single domain, no sub-domains)                                                                                                                                                                                                                                                             |

**Permission resolution** (tenancy domain, not under `shared/`):

- `src/domains/tenancy/sub-domains/permission/authorization.service.ts` — resolve user organization permissions (Redis-cached)
- `src/domains/tenancy/sub-domains/permission/permission-cache.service.ts` — Redis cache helpers for permission sets

### File naming

- Domain/sub-domain folders: **singular** or **kebab-case** for multi-word (`member-roles`, `member-invitation`).
- Files inside a sub-domain: **singular** for the main resource (`user.service.ts`, `organization.repository.ts`).
- Controllers export: `create<Resource>Controller(service)` or `create<Resource>Controller(container)` when multiple sub-domain services are wired.
- Always prefix sub-domain directories with parent domain name.

### Sub-domain nesting (sub-domains may contain sub-domains)

A **top-level sub-domain** is a direct child of `sub-domains/<name>/`. A **nested sub-domain** is a folder inside a parent sub-domain when the child’s lifecycle is tied to the parent aggregate.

| Rule                                                                                      | Example                                                                             |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Sibling resources** live under `sub-domains/` only                                      | `sub-domains/plan/`, `sub-domains/subscription/`                                    |
| **Nested sub-domains** live inside the parent sub-domain folder                           | `sub-domains/webhook/webhook-event/`                                                |
| **Organization children** nest under `organization/`                                      | `sub-domains/organization/organization-api-key/`, `organization-settings/`          |
| **Membership / member-roles children** nest under parent                                  | `sub-domains/membership/member-invitation/`, `member-roles/member-role-permission/` |
| **Prefix** multi-word names with domain/resource name                                     | `organization-settings`, `member-invitation`, `webhook-event`                       |
| **Implementation modules** (not separate API resources) stay as services in parent folder | `auth-method/email-login.service.ts`, `oauth/` under `auth-method/`                 |
| Prefer depth ≤ 4 under `domains/<domain>/` for new work                                   | Flatten if a nested folder has no distinct routes or tests                          |

Nested resources use the **same layer files** (controller, service, repository, validator, serializer, dto, types, schema) and the **same optional** `events/`, `queues/`, `workers/`, `__tests__/` as top-level sub-domains.

See **`docs/reference/architecture/domains-and-public-api-design.md`** for route strategies, tests, and examples.

## Infrastructure

```text
src/infrastructure/
  database/
    connection.ts             # Exports: database, sql, closeDatabase
    base-repository.ts        # Abstract BaseRepository with paginate()
    transaction.ts            # withTransaction() helper
    resource-quota-lock.util.ts # Advisory-lock guard for resource caps (per-scope count+insert serialization)
    pg-schemas.ts             # Shared pgSchema definitions (auth, tenancy, billing, notify, audit, upload)
    migration/migrate.ts      # Migration runner (+ migration-version.ts, migration-execution-mode.ts)
    contexts/                 # DB context wrappers (request / organization / tenant / user / retention / worker / system-audit-insert / global-admin / audit-outbox-drain) that set the RLS GUC
    pool/                     # Pool instrumentation (organization-rls-checkout-counter.ts)
    safety/                   # Boot guards: assert-database-rls-safety.ts, assert-database-tls-safety.ts, assert-connection-budget.ts
    utils/                    # batch-delete, capped-count, connection-url, force-rls-tables.constants, database-handle.types
  cache/
    redis.client.ts           # Redis connection (managed service)
    bullmq-redis.client.ts    # Separate BullMQ Redis client (logical DB) + redis-url / redis-prefix utils
                              # + redis.constants.ts, assert-redis-tls-safety.ts (boot guard), redis-topology-warn.util.ts,
                              #   redis-lock.util.ts (withRedisLock compare-and-del lock), redis-url.parse.util.ts
  queue/
    connection.ts             # Re-exports Redis for BullMQ + getBullMQConnectionOptions()
    health.ts                  # BullMQ readiness helper (notification queue client ping)
    bootstrap.ts              # Registers repeatable jobs + starts domain workers; attaches DLQ hooks
    scheduler.ts              # Central BullMQ repeatable-job registry (cron index for retention workers)
    queue.constants.ts        # Shared queue names / constants
    queue-dashboard.ts        # Bull-Board dashboard wiring (/admin/queues)
    worker-runtime/           # Worker tuning + lifecycle: worker-options.ts, worker-processor.util.ts, worker-close.util.ts, worker-registration.registry.ts, worker-health.server.ts, scheduler-registry-audit.ts
    dlq/                      # Dead-letter subsystem: dead-letter.ts (per-source `<queue>-dlq` + final-retry Sentry), dead-letter.repository.ts/.schema.ts, dlq-auto-retry.*, dlq-replay.util.ts, poison-job.util.ts
    commit-dispatch/          # Post-commit dispatch recovery: commit-dispatch.executor.ts/.store.ts, commit-dispatch-recovery.worker.ts/.processor.ts
  mail/
    mail.service.ts           # Resend email service
    resend-api.error.ts       # Structured Resend API error (counts as a circuit-breaker failure)
    mail-outbox.schema.ts     # Transactional outbox table (shared infrastructure pattern)
    mail-outbox.repository.ts # Outbox persistence (not domain-owned)
    templates/                # HTML email templates (base, verification-code, invitation)
    queues/
      mail.queue.ts           # BullMQ queue + recordOutboxEmail / dispatchOutboxEmail
    workers/
      mail.worker.ts          # BullMQ processor for email delivery (+ mail-outbox-sweeper.worker.ts)
  payment/
    stripe.client.ts          # Stripe SDK client + helpers (customer, subscription, webhook)
  storage/
    storage.service.ts        # S3 storage service (presigned URLs, head object)
    s3-adapter.ts             # S3 adapter behind object-storage.port.ts (+ public-media-url.util.ts, s3-error.util.ts)
  outbound/                   # Hardened outbound HTTP for third-party calls: outbound-fetch.ts (timeouts, redaction),
                              # outbound-call.ts, outbound-defaults.ts, outbound-error.ts, outbound-redaction.ts, index.ts
  resilience/                 # Circuit breaker + retry-with-backoff for outbound/third-party calls (circuit-breaker.ts, retry-with-backoff.util.ts, lua/)
  api-reference/              # Scalar API-reference wiring (scalar-api-reference.ts)
  observability/
    sentry/sentry.ts          # Sentry: errors, tracing, continuous profiling (V8 CpuProfiler), structured logs (+ sentry-sampling.util.ts)
    tracing/                  # OpenTelemetry: otel.ts, trace-context.util.ts, trace-context-job-fields.schema.ts
    metrics/                  # Prometheus / metrics registry (HTTP, DB-pool, BullMQ, business, event-loop)
    idempotency-cardinality/  # Bounded SCAN of idempotency keys → threshold log / Sentry (constants, service, worker; scheduled in queue/scheduler.ts)
    dlq-depth/                # DLQ depth + DB-pool alert sampling (service, worker, constants)
    redis-saturation/         # Redis used_memory/maxmemory ratio + BullMQ waiting-depth sampling (sampled by dlq-depth worker)
    posthog/                  # PostHog product-analytics client (posthog.ts)
    unhandled-rejection.handler.ts  # Burst-tolerant unhandledRejection policy
  mcp/
    mcp-server.ts             # MCP (ENABLE_MCP_SERVER, dynamic import; @modelcontextprotocol/sdk optionalDependency): POST /api/v1/mcp
    mcp-capabilities.ts       # Canonical MCP tools/resources (shared by MCP server + OpenAPI /reference UI)
    mcp-client-guide.ts       # Client integration guide served as the core-be://client-guide MCP resource
```

## Shared

```text
src/shared/
  config/
    env.config.ts             # Environment validation entry (Zod)
    env-schema.ts             # Split Zod env schema
    load-env-files.ts         # .env.<NODE_ENV> then .env.local override loader
    worker-concurrency.util.ts
  errors/
    app.error.ts              # Base AppError + ERROR_CODE_TO_SNAKE
    auth.error.ts             # NotFoundError, UnauthorizedError, ForbiddenError, etc.
    validation.error.ts       # ValidationError
    configuration.error.ts    # ConfigurationError
    index.ts                  # Re-exports all
  types/
    index.ts                  # AuthContext, PaginatedResult (minimal by design)
  constants/                  # index.ts + billing, limits, notification, pagination,
                              # project-identity, query-limits, roles, security, ttl
  utils/                      # sub-categorized helpers (import full paths below)
    auth/ http/ i18n/ idempotency/ identity/ infrastructure/ security/ text/ validation/
    infrastructure/logger.util.ts   # Pino logger
    http/response.util.ts           # successResponse, paginatedResponse
    http/request.util.ts            # getRequestIdentifier, requireAuth
    http/api-versioning.util.ts     # buildPublicApiPrefix; applyPublicApiVersionHeader
  middlewares/                # registered via middlewares/index.ts → registerMiddleware()
    core/                     # auth, error-handler, idempotency, compression, i18n, metrics, health
    rate-limit/               # global + per-route limits
    security/                 # cors, helmet, captcha, api-key-auth, encryption
    session/                  # cookie session + CSRF origin pre-handler
    tenant/                   # claim-derived request.organizationId (header removed); RLS GUC
  locales/
    en/, es/                  # common.json, errors.json, mail.json, success.json, openapi.json
```

## Queue Infrastructure — Domain-Owned Jobs and Processors

- **Infrastructure only**: Connection (Redis), **scheduler** (repeatable retention cron registry), **bootstrap** that registers schedulers and starts each worker.
- **Jobs and processors**: Live in **respective domains only** — never in `common` or `shared`.
- Layout:
  - `infrastructure/queue/`: `connection.ts`, `health.ts`, `scheduler.ts` (all `upsertJobScheduler` calls for retention), `dlq/dead-letter.ts` (per-queue `<name>-dlq` + final-failure Sentry), `worker-runtime/` (worker options + lifecycle), `bootstrap.ts`
  - `domains/<domain>/<sub-domain>/queues/*`: Queue definition + enqueue helpers
  - `domains/<domain>/<sub-domain>/workers/*`: BullMQ processor(s)
- **No** `infrastructure/queue/processors/` — processors live in domains.

## Domain events (in-process) vs BullMQ workers

These are **not** the same:

- **Event bus** (`src/core/events/event-bus.ts`): in-process, runs in the API process immediately after a successful service write. Handlers enqueue side effects and **must not** fail the HTTP request.
- **BullMQ workers** (`src/infrastructure/queue/bootstrap.ts`, `pnpm dev:worker`): async, durable jobs in Redis processed in a separate worker process (retries, DLQ).

Typical flow: `service` → `eventBus.emit` → handler → `recordOutboxEmail()` (+ `dispatchOutboxEmail()` on commit) → mail worker. Worker/runtime paths (no request transaction) call `recordOutboxEmail()` + `dispatchOutboxEmail()` directly.

- **Registration (two paths)** — bootstrap order matters:
  1. `buildApp()` → `registerEventHandlers()` ([`register-event-handlers.ts`](src/core/events/register-event-handlers.ts)) **before** routes — auth + tenancy email handlers only.
  2. `registerRoutes()` → [`domain-containers.plugin.ts`](src/domains/domain-containers.plugin.ts) → `registerNotifyContainer()` → `registerNotifyEventHandlers()` — notify handlers registered after the DI container is composed.
- **Rule:** Handlers that only enqueue mail (`recordOutboxEmail()`) or have no container deps → register via `register-event-handlers.ts`. Handlers that need repositories from the composition root → register in the domain’s `register*Container()` (notify today).
- **Example (core path):** `tenancy/sub-domains/membership/member-invitation/` — service emits; handler calls `recordOutboxEmail()`.
- **Example (container path):** `notify/events/notify.event-handlers.ts` → `registerWebhookDeliveryEventHandlers()` — subscribes to `NOTIFY_EVENT.WEBHOOK_DELIVERY_REQUESTED` and enqueues outbound webhook delivery.

| Registrar                               | Event types (examples)                                                                | Side effect             |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------- |
| `registerAuthMethodEventHandlers`       | `AUTH_EVENT.EMAIL_VERIFICATION_CODE_REQUESTED`, `AUTH_EVENT.PASSWORD_RESET_REQUESTED` | Mail queue              |
| `registerMemberInvitationEventHandlers` | `MEMBER_INVITATION_EVENT.CREATED`, `RESENT`                                           | Mail queue              |
| `registerNotifyEventHandlers`           | `NOTIFY_EVENT.WEBHOOK_DELIVERY_REQUESTED`                                             | BullMQ webhook delivery |

## Key Patterns

- **Route flow**: HTTP Request → Middleware → Controller → Service → Repository
- **DI flow**: Container (repos → services) → Routes (controllers) → `src/routes.ts` (domain containers + route registration)
- **API versioning**: Major versions use `/api/v1`, …; additive/non-breaking changes ship on the same major, a breaking change gets a new major prefix — see **`docs/reference/api/api-versioning.md`** and `src/shared/utils/http/api-versioning.util.ts`.
- **Data lifecycle**: Soft-delete (`deleted_at`), revocation vs immutable billing ledgers, session/audit retention — see **`docs/reference/data/data-lifecycle-deletion.md`**.
- **Controllers**: Thin layer; export `create<Resource>Controller(service)` or `create<Resource>Controller(container)` returning handler map. Use `getRequestIdentifier()` and `requireAuth()` from `@/shared/utils/http/request.util.js`; the auth middleware eagerly attaches `request.principalScope`; controllers narrow it via `requireOrganizationScope(request)` (organization-required, 403) or `requireUserScope(request)` (real user required) and relay the scope into services.
- **Validation**: DTO (Zod schemas in `.dto.ts`), Validator (function-based, calls `.safeParse()`, throws `ValidationError`)
- **Serializer**: Function-based response shaping in `.serializer.ts` (e.g. `serializeOrganization(row)`)
- **Containers**: `<domain>.container.ts` handles DI; export services for routes/controllers. Multi-sub-domain domains (auth, user, billing, tenancy) wire sub-domain services via the container — controllers call the appropriate service directly.
- **Errors**: Typed errors from `src/shared/errors/index.ts`
- **Responses**: Helpers from `src/shared/utils/http/response.util.ts` (`successResponse`, `paginatedResponse`) + global formatting in `src/shared/middlewares/core/error-handler.middleware.ts`
- **i18n**: All user-facing response messages (error `detail`, validation `errors[].message`, success `message`) go through i18next. Use translation keys in errors and success payloads; error handler and controllers translate with `request.t()`. English is the default locale; add new keys to `src/shared/locales/en/` first, then other locales. See **`docs/reference/runtime/internationalization.md`**.
- **Request helpers**: `src/shared/utils/http/request.util.ts` exports `getRequestIdentifier(request)` and `requireAuth(request)` — use these in ALL controllers.
- **Auth**: Fastify auth plugin in `src/shared/middlewares/core/auth.middleware.ts`, decorates `request.auth` (JWT RS256 via `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`). Session cookie (`session_id`) CSRF model and Origin checks for refresh: **`docs/reference/security/csrf-and-session-cookies.md`**
- **Tenant**: `request.organizationId` is claim-derived by the auth middleware (the `X-Organization-Id` header was removed; `tenant/` retains only the no-op settlement stub)
- **Organization context / RLS**: Organization context flows from the signed `org` JWT claim: the auth middleware attaches `request.principalScope` (and the claim-derived `request.organizationId`); the Postgres session variable `app.current_organization_public_id` is set per unit of work by `withAppDatabaseContext`. Workers and processors must not call `getRequestDatabase()` — it returns the GUC-less pool and throws in worker runtime (enforced by `no-direct-db-in-services.global.test.ts`, code review, and the `guard-edits.sh` hook); importing DB-handle types or `setLocalDatabaseConfig` from `database-context-runtime` is allowed (e.g. `audit-outbox-drain.processor.ts`). Use the two context wrappers over the three scope patterns (`withAppDatabaseContext` with a `PRINCIPAL_SCOPE.REQUEST/.JOB/.VERIFIED`-minted scope or a pre-auth `SESSION_SCOPE.ARTIFACT` — the scope decides the GUCs; `withMaintenanceDatabaseContext` with a frozen `MAINTENANCE_SCOPE.<kind>` for bypasses) and pass the returned `databaseHandle` into `createWorker*Repository(databaseHandle)` factories or `runOrganizationScopedWorkerJob` / `runGlobalRetentionWorkerJob` / `runUserScopedWorkerJob` from `src/infrastructure/queue/worker-runtime/worker-processor.util.ts`. Tenant-scoped jobs must include `organizationPublicId` in the job payload. The context directory holds exactly two files — `src/infrastructure/database/contexts/database-context.ts` (the three scope patterns + registries) and `database-context-runtime.ts` (plumbing) — pinned by `context-directory-standard.policy.unit.test.ts`; the `app.global_retention_cleanup` RLS bypass clauses are defined in the consolidated baseline migration `migrations/00000000000000_init.sql`.
- **DB**: `src/infrastructure/database/connection.ts` singleton + Drizzle queries in repositories; repositories may extend `src/infrastructure/database/base-repository.ts` for `paginate()`
- **Config**: Environment variables from `src/shared/config/env.config.ts`. `NODE_ENV` is `local | development | production` (the enum rejects `test`/`staging`; the Vitest suite runs as `development`; an out-of-enum value fails loudly at boot). `development`/`production` are the two DEPLOY targets; `local` is a developer's machine (primary file `.env.local`). Runtime code **never** compares or branches on `NODE_ENV` — it is compared only in `env-schema.ts` (the enum field + `.refine()` constraints on parsed `data`). The pre-schema loader `load-env-files.ts` reads `NODE_ENV` solely to name the `.env.<NODE_ENV>` file (no comparison). Every environment-varying behaviour is an explicit env flag with a **static production-safe default** (+ a production `.refine()` for security flags); the dev value ships ACTIVE in `.env.example` and the test harness (`src/tests/setup.ts`) sets test values. Three non-negotiable env-flag principles (detail in the env-schema-add skill): (1) **conditions live in the env layer** — the `.refine()` in `env-schema.ts` owns every prod-forbidden/allowed-when rule, and runtime code reads one specific `env.FLAG` boolean without re-deriving the condition or combining flags; (2) **one thing → exactly one env variable** — never gate a single behaviour on two flags (`env.A && env.B`), e.g. the destructive wipe helpers gate on `env.TEST_MODE` **alone**; (3) **casing** — env vars are `UPPER_SNAKE_CASE`, while a `snake_case` name like `debug_verification_code` is an API body field, not an env var. Enforced by [`no-nodeenv-branching.global.test.ts`](src/tests/global/no-nodeenv-branching.global.test.ts), the `guard-edits.sh` R4 pre-edit hook, and the env-schema-add skill. Env files are **root only**: `.env.example` is the single committed template; per-environment `.env.<environment>` files (e.g. `.env.development`, `.env.production`) and `.env.local` are gitignored. Hosted environment mapping lives in `tooling/setup/setup.config.json` (canonical); `pnpm github:sync` reads it directly. Project identity is generated from that manifest via `pnpm tool:generate-project-identity` — the runtime constants, the CI composite action, `.github/CODEOWNERS`, the production environment's reviewer handles, `package.json` identity fields, `sonar-project.properties`, and Compose `container_name:` values. Its `:check` mode (in `ci:quality` and pre-commit) additionally fails on any hardcoded project slug or GitHub owner outside the generated targets and the self-validating `IDENTITY_LITERAL_ALLOWLIST`. Scaffold and push with `pnpm github:sync`. Consistency and remote drift: `pnpm github:sync --check`. Runtime loader (`src/shared/config/load-env-files.ts`) reads `.env.${NODE_ENV ?? 'local'}` (default `local`, matching the env schema — an unset NODE_ENV is a developer's machine), then layers the gitignored `.env.local` on top as a machine-local override (`.env.local` is gitignored **and** dockerignored, so it is absent in production — no runtime `NODE_ENV` guard needed). `.env.local` plays two roles from the one loader: with the default (unset) `NODE_ENV=local`, it IS the primary file (self-contained, the `!== primary` check skips the override step); when a DEPLOY target sets `NODE_ENV=development`/`production` explicitly, `.env.local` becomes the machine-local override layered on top of `.env.<environment>`. Scaffold a self-contained `.env.local` (`.env.example` + generated JWT keys/`SECRETS_ENCRYPTION_KEY` + localhost `DATABASE_URL`/`REDIS_URL`) with `pnpm setup:local` or `pnpm setup:local --only-env`.

## Dependency Rules

- HTTP controllers may import: services (or container deps), `@/shared/utils/http/request.util.js`, `@/shared/utils/http/response.util.js`, shared errors
- Services may import: **same-domain** repositories, own validators/types, shared errors, `eventBus`, `logger`. For **cross-domain** reads/writes, import the other domain's **service** only — never its repository or schema.
- Repositories may import: DB connection, schema, own domain types; may extend BaseRepository. Repositories may import other domains' **schemas** for joins only (same bounded context or documented exception).
- Containers may import: own domain repositories, services. Accept cross-domain deps as parameters. Export services for route registration.
- Routes may import: own domain controllers, container types. Must use `FastifyPluginAsync` pattern.

### Import paths

See **[import-paths.mdc](.cursor/rules/import-paths.mdc)** — `@/` in `src/`, `@tooling/` in tooling, same-folder `./` only, never `../`. Enforced by [`import-paths.global.test.ts`](src/tests/global/import-paths.global.test.ts).

## Drizzle ORM Conventions

- **Always use `snake_case`** for column property names in Drizzle schema definitions
- Column names must match the actual Postgres column names exactly
- Table names: plural, snake_case (`organizations`, `subscriptions`)
- Schema files are **co-located in domains**: `src/domains/<domain>/<sub-domain>/<sub-domain>.schema.ts`
- Shared `pgSchema` definitions live in `src/infrastructure/database/pg-schemas.ts`

## Seeding

- **Per-domain `seed/` dir**: Every folder that owns tables (domain, sub-domain, nested sub-domain) gets a co-located `seed/` directory holding `<name>.reference.seed.ts` (idempotent reference data), `<name>.bulk.seed.ts` (scaled rows for that level's tables), `<name>.faker.ts` (level-specific generators), and `index.ts`. Each domain still seeds **only its own tables** — no cross-domain insert logic inside domains.
- **Seed contract** (`src/scripts/seed/seed-contract.ts`): Each `seed/index.ts` exports a `SeedContribution` (`seedReference?` / `seedBulk?` hooks) **except** a top-level domain's, which exports a `DomainSeedModule` (`SeedContribution` plus `name` + `dependsOn`). Parents fold their children up with `composeContributions(...)` (nested sub-domain → sub-domain → domain). Cross-domain parent ids (organizations/users) flow through a `SeedRegistry` on the `SeedContext`: the user/tenancy seeders append created parents; downstream domains read them. This preserves "no cross-domain insert logic inside domains" — cross-domain wiring lives only in the orchestrator/context.
- **Orchestrator** (`src/scripts/seed/bulk.ts` + `bulk-config.ts`): Registers one `DomainSeedModule` per domain (`SEED_MODULES` in `src/scripts/seed/modules.ts`), topologically orders them by `dependsOn` (`orderModules` in `seed-contract.ts`), runs every `seedReference` first, then every `seedBulk`. Behind a production guard (`production-guard.ts`, `assertBulkSeedAllowed`); reproducible via `SEED`; idempotent (count-and-resume or `onConflictDoNothing`).
- **Three tiers** (all share the contract/seeders): `pnpm db:seed` (minimal/reference only), `pnpm db:seed:full` (fixed demo data), `pnpm db:seed:bulk` (scaled volume via profiles). Profiles `demo` / `edge` / `load` set base counts; `SCALE` multiplies volume-bearing counts (bounded by `HARD_CAP`); per-knob env overrides `BULK_ORGS`, `BULK_USERS_PER_ORG`, `BULK_AUDIT_MONTHS`, `BULK_AUDIT_PER_ORG_PER_MONTH`. Example: `BULK_PROFILE=load SCALE=5 pnpm db:seed:bulk`.
- **Route alignment**: Seed data should support what the API exposes. When routes are added, removed, or updated, run **route-catalog** skill (`pnpm routes:catalog`) and **seed-maintainer** so seeds stay aligned with routes.
- **Conventions and detail**: scoped rule `.cursor/rules/seed-conventions.mdc` (auto-attaches under `src/domains/**` and `src/scripts/seed/**`); skill `.cursor/skills/seed-maintainer/SKILL.md`; overview `src/scripts/seed/seed.overview.md`. The domain-structure validator allows `seed/` at domain root.

## Context7 (version-wise backend docs)

This repo uses **Context7 MCP** for up-to-date, version-specific documentation. Scope is **backend only** (Fastify, Drizzle, BullMQ, Postgres, Node). Add `use context7` to prompts when asking about library APIs or setup; mention versions (e.g. Fastify 5, Drizzle 0.45) for version-specific docs.

## MCP servers (agent tooling)

Two committed, secret-free templates define the agent-only MCP set (each mirrored under [`agent-os/mcp/`](agent-os/mcp/)):

- **Default auto-start pair — [`.mcp.default.json`](.mcp.default.json): `codegraph` + `headroom`** (zero-config local CLIs, no token). `pnpm setup:local`, the session-start hook, and the cloud bootstrap declare both in the gitignored `.mcp.json` so they are present before the first prompt.
- **On-demand set — [`.mcp.example.json`](.mcp.example.json): the full set** (`context7`, `core-be:api`, `neon`, `sentry`, `railway`, `aws`, `stripe`, `semgrep`, `sonarqube`, `redis`, `postman`, `resend`, `dashboards`, `serena`, `ast-grep`, `codegraph`, `headroom`; most need a provider token). Scaffold with **`pnpm mcp:setup`** — all, or a subset by name (`pnpm mcp:setup stripe sentry`); `pnpm mcp:setup:default` for just the pair, `pnpm mcp:setup --list` for status (per-server runtime/token catalog: **`docs/integrations/agentic-third-party-tooling.md`**). The pair in `.mcp.default.json` mirrors its entries in `.mcp.example.json` — the `mcp-config` global test blocks drift.

On **Claude Code web** the live MCP set is loaded by the platform from the environment's MCP settings (web UI), **not** `.mcp.json` — configure `codegraph` + `headroom` there to auto-start, and add others as needed. `Composio`, `Descript`, and `Slack` are intentionally **not** part of this project. See **`docs/integrations/claude-code-web-environment.md`** and **`docs/integrations/agentic-third-party-tooling.md`**.

## Headroom (agent context compression)

All AI agents (Claude Code, Cursor, Codex) share the **Headroom MCP** server (part of the default auto-start MCP pair; wired in `.mcp.example.json` ↔ `agent-os/mcp/mcp.example.json`) as a context-compression layer. Route large, low-signal text — long command/CI/test output, logs, whole-file reads, RAG/search chunks — through `headroom_compress` before loading it into context (same answers, far fewer tokens); use `headroom_retrieve` when exact bytes are needed and `headroom_stats` to check savings. Do **not** compress small outputs or content applied verbatim (diffs, code to edit, migration SQL, secrets). Setup: `pip install "headroom-ai[mcp]"` then `headroom mcp install`. Detail: rule **`agent-os/rules/headroom-context-compression.mdc`** (`alwaysApply`).

## Keeping Docs and Skills in Sync

When **code or architecture changes**, consult **`.cursor/skills/skill-index/SKILL.md` first** — it maps what changed to which skill(s) to run (no duplicate invocations).

**Definition-of-done (every change):** a code change is finished only when its **own tests, cross-cutting test suites, docs, rules, and skills** have all moved with it — see **change-completeness-guard** (always-applied rule: `agent-os/rules/change-completeness.mdc`). When a single fact (a count, a route set, a constant, an env key, a header) lives in more than one place, grep the literal across `src/`, `docs/`, and `agent-os/` so no mirror is left stale.

**Enforcement:** Agent skills generate/fix artifacts once → pre-commit (`lint-staged`, `typecheck`, `validate:domain`, `tsdoc:check`) → CI (`pnpm validate`, `routes:catalog:check`, `tsdoc:check`, env-example sync).

**Human docs** (when layout changes): `CLAUDE.md`, `README.md`, `.cursor/rules/`, skills — via **structure-maintainer**. Hand-written `docs/**/*.md` — via **docs-maintainer**.

All skills live under `.cursor/skills/`; the skill-index trigger map and auto-trigger rules table are the canonical list.

### In-source documentation system

Every directory under `src/` participates in the in-source documentation system. There are four layers, each with a single source of truth — there is intentionally no auto-generated `DOCS.md` aggregator.

| Layer                               | File                                                                    | Owner skill                     |
| ----------------------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| System narratives                   | `src/OVERVIEW.md`, `src/PATTERNS.md`, `src/FLOWS.md`, `src/POLICIES.md` | **system-narrative-maintainer** |
| Per-folder overviews (hand-written) | `src/<folder>/<folder>.overview.md` at meaningful boundaries            | **overview-doc-maintainer**     |
| TSDoc on exports (canonical)        | every `*.ts` file's `export <kind> <name>` declaration                  | **tsdoc-export-guard**          |
| Route schema (drives OpenAPI)       | `schema: { summary, description, tags }` on Fastify route registrations | **route-schema-doc-guard**      |

The hard gate is `pnpm tsdoc:check` — a **budget-driven ratchet** at [`tooling/tsdoc-coverage/budget.json`](tooling/tsdoc-coverage/budget.json). Counts of `MISSING_DESCRIPTION` and `MISSING_REMARKS` may decrease but may not increase; the budget is at 0/0, so the gate now holds full coverage — any new undocumented export fails. Runs on pre-commit (step 8) and CI (`ci:local`, `ci:quality`).

See [docs/reference/architecture/documentation-system.md](docs/reference/architecture/documentation-system.md) for the full system, including why the auto-generated DOCS.md aggregator was retired.

## Testing

- **Test framework**: Vitest + `fastify.inject()` (helpers in `src/tests/helpers/test-http-inject.helper.ts`)
- **Cross-cutting tests**: `src/tests/` — helpers, shared factories, security, performance, chaos, contract, cross-cutting e2e flows (`src/tests/e2e/` — signup, billing onboarding, data-export deletion), smoke (`src/tests/smoke/`), bench (`src/tests/bench/`), SQL fixtures (`src/tests/fixtures/`); k6 under `src/tests/load/k6/`
- **Domain tests** (co-located with code):
  - **Bundled e2e**: `src/domains/<domain>/__tests__/<domain>.test.ts` (auth, billing, notify, user, tenancy, audit, upload)
  - **Domain integration**: `src/domains/<domain>/__tests__/integration/*.integration.test.ts` — **required** for routed domains (`validate:domain` requires a `.test.ts` under `__tests__/integration/`; the `.integration.test.ts` suffix is enforced by `validate:test-naming`); route smoke + focused in-process HTTP contracts
  - **Domain flow e2e** (optional): `src/domains/<domain>/__tests__/e2e/*.e2e.test.ts` — multi-step end-to-end flows (e.g. login, organization onboarding, webhook delivery)
  - **Domain unit / policy scans**: `src/domains/<domain>/__tests__/unit/` (e.g. ledger immutability, tombstone reads)
  - **Domain factories**: `src/domains/<domain>/__tests__/factories/` when helpers span sub-domains (e.g. `tenancy/__tests__/factories/permission.factory.ts`)
  - **Sub-domain unit**: `sub-domains/<resource>/__tests__/unit/*.validator.unit.test.ts` (or nested: `sub-domains/<parent>/<child>/__tests__/unit/`)
  - **Sub-domain e2e** (when split from monolith): `sub-domains/<parent>/<child>/__tests__/<child>.test.ts` (e.g. organization-api-key)
  - **Event handlers / emit**: `sub-domains/<resource>/__tests__/unit/events/` (register leaf handlers only in tests; never `events/__tests__/`)
- **Commands**: `pnpm test:unit` (unit + `__tests__/unit/events/`), `pnpm test:e2e` (excludes `__tests__/unit/`), `pnpm test` (all)
- **Detail**: `.cursor/skills/test-generator/SKILL.md`, `.cursor/rules/testing-conventions.mdc`
- **Chaos suite**: `src/tests/chaos/**/*.chaos.test.ts` — see **`docs/reference/reliability/chaos-testing.md`**
- **Contract tests**: `src/tests/contract/**` — see **`docs/reference/testing/contract-tests.md`**
- **k6 load tests**: `src/tests/load/k6/scenarios/` — see **`docs/reference/testing/load-testing.md`**

## Git branch naming

Working branches are `<type>/<short-description>`; `main` is the only long-lived branch. Enforced by [`.husky/pre-push`](.husky/pre-push) (rule: `agent-os/rules/git-branch-naming.mdc`, owner: **code-quality-guard**).

**AI web sessions start on a throwaway name.** Claude Code web assigns `claude/<platform-slug>` (e.g. `claude/session-request-wx3euu`) before the container boots. The slug is generated platform-side and is **not configurable from this repo** — no file here changes it. Rename it to a meaningful name rather than shipping it.

**Name the branch before the first push.** The cloud git proxy accepts a push to *any* branch name but **rejects every form of delete** (`git push --delete`, `git push :ref`, and `DELETE /git/refs/...` → 403). A `claude/*` branch that has already been pushed therefore cannot be cleaned up from inside the session. Renaming first means the throwaway name never reaches the remote:

```sh
git branch -m docs/american-spelling-organization      # rename in place, BEFORE any push
git push -u origin docs/american-spelling-organization
```

Already pushed as `claude/*`? Leave it — it auto-deletes when the PR squash-merges. Never open a second PR just to fix a branch name.

**Deriving the name** — `<type>` is the change's conventional-commit type (`feat`, `fix`, `hotfix`, `refactor`, `docs`, `test`, `chore`, `ci`, `perf`, `build`, `style`, `revert`, matching `BRANCH_TYPES` in `.husky/pre-push`); `<short-description>` is kebab-case, 2–5 words, ≤ 40 chars, naming the change itself (never a ticket id or a date). Keep it aligned with the commit subject and PR title.

| Change | Branch |
| ------ | ------ |
| Fix British spelling in a doc | `docs/american-spelling-organization` |
| Add `POST /billing/invoices` | `feat/billing-invoice-route` |
| RLS scope bug on `webhook_event` | `fix/webhook-event-rls-scope` |
| Bump Fastify to 5.3 | `chore/bump-fastify-5-3` |

## Commands

Script namespaces: `ci:*`, `compose:*`, `test:*`, `validate:*`, `db:*`, `docs:*`, `routes:*`, `load:*`, `chaos:*`, `tool:*`, `setup:*`, `mcp:*`, `security:*`, `sonar:*`, `deps:*`, `agent-os:*`, `github:*`, `tsdoc:*`, `docker:*`, `dashboards:*`, `ops:*`, `sbom:*`, `guard:*`, `dev:*`, `build:*`, `lint:*`, `format:*`, `health:*`, `coverage:*`, `env:*`, `start:*`, `verify:*`. List all: `pnpm run`.

Local SonarQube quality gate (pre-commit): `pnpm sonar:up` / `sonar:scan` / `sonar:down` / `sonar:reset`. The pre-commit hook (`pnpm guard:pre-commit`, step 17) blocks a commit when SonarQube has any open issue on the deployed-app surface; the gate is mandatory — there is no bypass, every issue must be resolved. See **`docs/reference/quality/sonarqube-local.md`**.

- `pnpm build` — compile to `dist/` (`tsc` + `tsc-alias`); `pnpm build:check` fails if `@/` aliases remain
- `pnpm dev` — run Fastify server (tsx watch)
- `pnpm dev:worker` — run BullMQ worker process (tsx watch)
- `pnpm lint` — run Biome (lint + format check on `src/` and `tooling/`)
- `pnpm format` — run Biome formatter (`biome format --write`)
- `pnpm typecheck` — TypeScript type check
- `pnpm knip` — dead-code gate (unused files / dependencies / binaries; config `knip.jsonc`). Blocking on those high-signal categories; the noisy `exports`/`types` analysis is deferred. Own PR-CI lane, folded into the `quality-gate` aggregate.
- `pnpm health` / `pnpm health:fix` — phased local health orchestrator (`tooling/validate/health-check.sh`): runs every gate, **continues through failures**, prints a PASS/FAIL table; `--fix` auto-repairs lint + format first. Complements the fail-fast `pnpm ci:local`. `pnpm quality` = `health` + `sonar:scan`.
- `pnpm compose:up` / `pnpm compose:down` — start/stop Postgres + Redis (Docker Compose)
- `pnpm compose:wait` — wait until Compose Postgres accepts connections (fails fast if service not running)
- `pnpm db:migrate` — run SQL migrations from `migrations/`
- `pnpm db:migrate:lint` — scan `migrations/*.sql` for migration-safety violations (blocking DDL, missing IF NOT EXISTS, etc.)
- `pnpm docs:generate` — generate OpenAPI spec to `docs/openapi/openapi.json` (default locale en) or `docs/openapi/openapi.{locale}.json` when `OPENAPI_LOCALE` is set (gitignored)
- `pnpm docs:generate:multilang` — generate OpenAPI specs for all locales (en, es) from `src/shared/locales/{locale}/openapi.json`; see **openapi-multilingual** skill
- `pnpm docs:check` — verify OpenAPI generator output is in sync (works on fresh clones; specs are gitignored)
- `pnpm docs:postman` — convert OpenAPI spec to Postman Collection at `docs/postman-collection.json`
- `pnpm docs:upload` — upload Postman Collection to workspace (requires `POSTMAN_API_KEY` + `POSTMAN_WORKSPACE_ID`)
- `pnpm docs:upload:scalar` — publish the OpenAPI document to the Scalar Registry (requires `SCALAR_API_KEY` + `SCALAR_NAMESPACE`; optional `SCALAR_SLUG`, default `core-be`)
- `pnpm docs:upload:hosted` — run both hosted uploads (Postman workspace + Scalar Registry)
- `pnpm docs:all` — generate OpenAPI spec + Postman Collection in one step
- `pnpm test` — run all Vitest tests (serial)
- `pnpm test:unit` — unit only (`--project unit` in `tooling/vitest/projects.ts`: `src/tests/unit` + domain `__tests__/unit/`)
- `pnpm test:integration` — `src/tests/integration`
- `pnpm test:e2e` — domain route tests (excludes `__tests__/unit/`)
- `pnpm test:global` — global regression (`src/tests/global`; alias `pnpm test:regression`)
- `pnpm test:coverage` — all tests with V8 coverage (CI)
- `pnpm test:performance` — performance tests
- `pnpm test:security` — security test suite
- `pnpm test:rls-role` — runs the **e2e** and **integration** lanes with the pool under test opened as the RLS-subject `core_be_app` role. Every other lane connects as a role that BYPASSES row-level security (Compose's `POSTGRES_USER: core` is a superuser; the local operator role carries `rolbypassrls`), so a path reaching a FORCE RLS table without a database context reads rows there and **none** in production. Harness fixtures use the operator connection (`src/tests/helpers/operator-database.ts`). CI job: `RLS application role (whole connection)`
- `pnpm test:chaos` — Toxiproxy chaos / fault-injection suite (`tooling/vitest/chaos.config.ts`; see `docs/reference/reliability/chaos-testing.md`)
- `pnpm test:contract` — outbound HTTP contracts for Stripe, Resend, S3 (`tooling/vitest/contract.config.ts`; see `docs/reference/testing/contract-tests.md`)
- `pnpm chaos:up` / `pnpm chaos:down` — start/stop the Toxiproxy sidecar (`docker compose --profile chaos`)
- `pnpm chaos:provision` — register Postgres + Redis listener proxies (`src/tests/chaos/provision-proxies.ts`)
- `pnpm test:api-smoke` — live API smoke (server running + seed)
- `pnpm verify:base` — end-to-end gate: migrate → seed (minimal + full) → API smoke (auto-detects/launches server + worker) → validate
- `pnpm routes:catalog` / `pnpm routes:catalog:check` — regenerate or verify `docs/routes.txt`
- `pnpm validate:route-success-statuses` — verify `tooling/openapi/route-catalog/route-success-statuses.json` (declared happy-path status per route) stays in sync with `docs/routes.txt`
- `pnpm validate:route-schema-docs` — verify every route registration (incl. `health.middleware.ts`, `mcp-server.ts`) declares `schema.summary`/`description`/`tags` (drives OpenAPI operation docs)
- `pnpm validate:route-organization-scope` — verify `tooling/openapi/route-catalog/route-organization-scope.json` (the catalog `O` column: `both` or team-only `team`) stays in sync with `docs/routes.txt`
- `pnpm validate:route-success-coverage` — observed-status gate after a full `pnpm test`: fails on declared-vs-observed drift; uncovered-routes count ratchets via `tooling/route-coverage/route-success-coverage-budget.json`; also verifies every observed sub-500 status is documented in the generated OpenAPI spec
- `pnpm routes:examples` — refresh `tooling/openapi/route-examples/route-examples.json` (sanitized request/response samples per route+status, embedded in OpenAPI as `captured` examples) from a capture run: `ROUTE_EXAMPLE_CAPTURE=1 pnpm test && pnpm routes:examples`
- `pnpm ci:local` — PR gate: validate + domain + routes + migrate lint + env example + full test
- `pnpm ci:quality` — static CI quality slice (audit, validate, domain, contract tests, routes, env example, migrate lint)
- `pnpm validate` — lint + typecheck + markdown lint (`biome check` covers lint + formatting; `docs:lint` is folded in because markdownlint otherwise runs only at pre-commit/pre-push, and a `--no-verify` commit skips it)
- `pnpm test:bench` — autocannon single-endpoint benchmark
- `pnpm validate:domain` — validate domain structure (CI gate)
- `pnpm deps:audit` — run `pnpm audit` (must pass; CI fails on any vulnerability)
- `pnpm deps:update` — safe patch/minor updates within ranges; run audit + validate + test after
- `pnpm db:seed` — seed minimal dev data (reference/bootstrap only)
- `pnpm db:seed:full` — seed full demo data (fixed demo set)
- `pnpm db:seed:bulk` — scaled bulk seed via the orchestrator; `BULK_PROFILE` (`demo`/`edge`/`load`), `SCALE`, per-knob `BULK_*` overrides (e.g. `BULK_PROFILE=load SCALE=5 pnpm db:seed:bulk`)
- `pnpm db:viewer` — local DB Viewer (`tooling/db-viewer/`): loopback-only ER board for Drizzle schemas + `migrations/*.sql` replay; per-boot session token in the printed URL
- `pnpm init:project` — adopt this repo as a NEW project: rewrites the identity manifest, regenerates every identity artifact, resyncs the lockfile, and reports leftovers of the previous name. Identity-only by default; `--reset-history` additionally performs the destructive fork reset (confirmed by phrase), `--dry-run` previews, `--yes` + flags run non-interactively. Playbook: **`docs/getting-started/adopting-as-template.md`**
- `pnpm github:sync` — consistency, scaffold, rulesets, GitHub Environments, push `.env.<environment>` values; `--check` read-only; `--dry-run` preview (single trunk: `main` is the repo default, so no branch is created)
- `pnpm github:tool:governance-mode` — switch the merge + production-deploy review posture between `personal` and `team` (atomically flips the coupled review fields in `.github/rulesets/<branch>.json` + `.github/environments/production.json`; `team` derives reviewers from `.github/CODEOWNERS` and needs ≥2 owners, then run `pnpm github:sync`). `pnpm github:tool:governance-mode:check` guards the two files against an inconsistent/deadlocking combo. See **`docs/deployment/ci-cd/branch-protection.md`**
- **Merge policy — never merge on red (enforced, not convention):** the `main` ruleset has **no `bypass_actors`**, so a PR with any failing or pending required check (`Quality gate`, `Checks`) **cannot be merged by anyone — the repo owner included**. Never re-add `bypass_actors` to `.github/rulesets/main.json`, and never merge with `--admin` / the merge API to skip a red gate: a flaky-red required check is **re-run (or its branch updated) to green**, never bypassed. `strict up-to-date` is off so a green PR merges cleanly via `gh pr merge --squash`; `required_signatures` is intentionally absent (unsigned branch commits — GitHub signs the squash-merge commit on `main` regardless). Pinned by [`src/tests/unit/ci/rulesets.policy.unit.test.ts`](src/tests/unit/ci/rulesets.policy.unit.test.ts).
- `pnpm tool:sync-env-example` — report env schema vs .env.example diff and PR snippet; use `--fix` to append missing vars
- `pnpm tool:project-structure-tree` — print `src/` directory tree to stdout (see `docs/reference/architecture/project-structure-guide.md`)
