# Project Structure Guide

Conventions, layer matrix, request flow, and known inconsistencies for `src/`. For canonical layout rules, see [CLAUDE.md](../../../CLAUDE.md) and [domains-and-public-api-design.md](../architecture/domains-and-public-api-design.md).

---

## 1. Directory structure

The full `src/` file tree is **not** duplicated here (it drifts from code quickly).

| Source | Use |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [CLAUDE.md](../../../CLAUDE.md) | Domain → sub-domain (and nested sub-domain) layout, tests, dependency rules |
| [domains-and-public-api-design.md](./domains-and-public-api-design.md) | Layout variants, nesting rules, tests (§1.5), route-file strategy |
| [documentation-system.md](./documentation-system.md) | Layered docs system (system narratives, per-folder overviews, TSDoc, route schema) |
| [`src/OVERVIEW.md`](../../../src/OVERVIEW.md) | Top of the system narrative tree — domain map, infra modules, cross-cutting overview |
| [`src/PATTERNS.md`](../../../src/PATTERNS.md) | Cross-cutting patterns (RLS context, idempotency, transactional outbox, audit emission, …) |
| [`src/FLOWS.md`](../../../src/FLOWS.md) | End-to-end flows (signup, webhook ingest, billing reconciliation, …) |
| [`src/POLICIES.md`](../../../src/POLICIES.md) | Policy constants and the rationale behind each tunable |
| `.cursor/skills/be-domain-generator/SKILL.md` | Scaffolding checklist for new domains/resources |
| `.cursor/skills/be-test-generator/SKILL.md` | Where to put unit, e2e, and event-handler tests |
| [docs/routes.txt](../../routes.txt) | Generated route catalog (`pnpm routes:catalog`) |
| `pnpm tool:project-structure-tree` | Print current `src/` tree to stdout (skips `__tests__/`, caches) |

---

## 2. File Responsibilities

| Suffix           | Responsibility                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `.routes.ts`     | Fastify route registration; receives container or service(s), registers HTTP handlers         |
| `.controller.ts` | Thin HTTP handlers: parse request, call service(s), return response                           |
| `.validator.ts`  | Function-based input validation using Zod `.safeParse()`, throws `ValidationError`            |
| `.dto.ts`        | Zod schemas for request body/query/params validation                                          |
| `.serializer.ts` | Function-based response shaping (e.g. `serializeOrganization(row)`)                           |
| `.service.ts`    | Business logic; uses repositories, validators; may call other domain services or enqueue jobs |
| `.repository.ts` | Drizzle DB access; imports schema and connection                                              |
| `.types.ts`      | TypeScript domain types and interfaces                                                        |
| `.schema.ts`     | Drizzle table/column definitions (snake_case, co-located in domain)                           |
| `.container.ts`  | DI: instantiates repositories, services; exports services for routes/controllers              |

**Other files**

| Suffix / pattern                                                    | Inferred purpose                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `.permissions.ts`                                                   | Permission code constants for the domain (consumed by permission seeding and authorization) |
| `.constants.ts`                                                     | Domain-specific constants (e.g. upload)                                               |
| `.seed.ts`                                                          | Seed data and reference data for the domain                                           |
| `*.queue.ts`                                                        | BullMQ queue definition and enqueue helpers (under `queues/`)                         |
| `*.worker.ts`                                                       | BullMQ job processor (under `workers/`)                                               |
| `authorization.service.ts`                                          | Permission resolution (tenancy/permission)                                            |
| `permission-cache.service.ts`                                       | Redis permission cache (tenancy/permission)                                           |
| `email-login.service.ts`, `oauth.service.ts`                         | Auth-method-specific auth flows                                                       |
| `verification-token.repository.ts` / `verification-token.schema.ts` | Verification token entity under auth-method                                           |
| `webhook-delivery-attempt.repository.ts`                            | Webhook delivery attempt entity under webhook                                         |

**In-source documentation files**

| File             | Where it lives                                        | Owner skill |
| ---------------- | ----------------------------------------------------- | --------------------------------------- |
| `<folder>.overview.md`    | At meaningful boundaries (domains, sub-domains, infra subsystems, test suites). Hand-written: Purpose, design decisions, failure modes, tuning | be-overview-doc-maintainer |
| TSDoc            | Inline on every public export in `*.ts` (canonical, gated by `pnpm tsdoc:check`) | be-tsdoc-export-guard |
| Route schema     | Inline `schema.summary` / `schema.description` / `schema.tags` on every Fastify route (drives OpenAPI) | be-route-schema-doc-guard |

System-level narratives sit at the `src/` root only: `src/OVERVIEW.md`, `src/PATTERNS.md`, `src/FLOWS.md`, `src/POLICIES.md` (owner: be-system-narrative-maintainer). There is no auto-generated `DOCS.md` aggregator.

---

## 3. Domain vs Sub-domain File Matrix

| File             | Domain (root)                                            | Sub-domain (no API)                                                                                                              | Sub-domain (has API)                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.routes.ts`     | ✅ (audit, auth, billing, notify, tenancy, upload, user) | ❌                                                                                                                               | ✅ (tenancy: organization, membership, member-roles, permission). Billing/notify sub-domains register via parent composers (`billing.routes.ts`, `notify.routes.ts`) — see Section 7. |
| `.controller.ts` | ✅ where domain has HTTP API                             | ✅ (e.g. member-invitation, organization-settings, stripe-webhook, user-data-export, webhook-event)              | ✅                                                                                                                                                                                    |
| `.validator.ts`  | ✅ where domain has input                                | ✅ or ❌ by sub-domain                                                                                                           | ✅                                                                                                                                                                                    |
| `.dto.ts`        | ✅ where domain has input                                | ✅ or ❌ by sub-domain                                                                                                           | ✅                                                                                                                                                                                    |
| `.serializer.ts` | ✅ where domain returns shaped data                      | ✅ or ❌ by sub-domain                                                                                                           | ✅                                                                                                                                                                                    |
| `.service.ts`    | ✅                                                       | ✅                                                                                                                               | ✅                                                                                                                                                                                    |
| `.repository.ts` | ✅ or ❌ (auth has no domain repo)                       | ✅                                                                                                                               | ✅                                                                                                                                                                                    |
| `.types.ts`      | ✅ where present                                         | ✅ or ❌ by sub-domain                                                                                                           | ✅                                                                                                                                                                                    |
| `.schema.ts`     | ✅ where domain has tables                               | ✅ or ❌ by sub-domain                                                                                                           | ✅                                                                                                                                                                                    |
| `.container.ts`  | ✅ (all 7 domains)                                       | ❌                                                                                                                               | ❌                                                                                                                                                                                    |

**Inconsistencies**

- **Sub-domain has controller but no routes file:** Many sub-domains are exposed only via the parent domain routes (e.g. member-invitation, organization-settings, organization-api-key, organization-notification-policy, webhook-event). Their controllers are used by the parent `billing.routes.ts` or `tenancy.routes.ts` or `notify.routes.ts`; the sub-domain does not have its own `.routes.ts` that is mounted.
- **`user-data-export`:** aggregates GDPR export data by calling `list*ForUserDataExport` on auth, tenancy, notify, and audit services (see `wireCrossDomainServices`).

---

## 4. Request / Response Flow

**Standard flow (all domains, including auth and user with multiple sub-domain services):**

```text
HTTP Request
    │
    ▼
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│ .routes.ts  │────▶│ .controller │────▶│ .validator   │
│ (register)  │     │ (thin)      │     │ / .dto       │
└─────────────┘     └──────┬──────┘     └──────┬───────┘
                           │                    │
                           ▼                    ▼
                    ┌──────────────┐     ┌──────────────┐
                    │ .service     │────▶│ .repository  │────▶ .schema / DB
                    │ (or sub-svc) │     └──────┬───────┘
                    └──────┬───────┘            │
                           │                    ▼
                           │             ┌──────────────┐
                           └────────────▶│ .serializer  │────▶ Response
                                         └──────────────┘
```

---

## 5. Data Layer Separation

| Layer      | File             | Represents                                        |
| ---------- | ---------------- | ------------------------------------------------- |
| Schema     | `.schema.ts`     | DB table/column definitions (Drizzle, snake_case) |
| DTO        | `.dto.ts`        | Request input validation (Zod schemas)            |
| Types      | `.types.ts`      | TypeScript domain types / interfaces              |
| Serializer | `.serializer.ts` | Response shaping (row → API shape)                |

**Domains/sub-domains with all four (schema, dto, types, serializer):**

- **Domain root:** audit, upload, user.
- **Sub-domains:** subscription, plan, member-invitation, member-role-permission, membership, member-roles (member-role), organization, organization-settings, organization-notification-policy, organization-api-key, permission, user-settings, user-notification-preferences, user-data-export, webhook.

**Domains/sub-domains missing one or more:**

| Location                      | Missing                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| auth (root)                   | .schema.ts at domain root (schemas in sub-domains)                       |
| billing (root)                | .controller, .validator, .dto, .serializer, .repository, .types, .schema |
| notify (root)                 | .controller, .validator, .dto, .serializer, .repository, .types, .schema |
| tenancy (root)                | .controller, .validator, .dto, .serializer, .repository, .types, .schema |
| auth-method                   | .dto, .validator, .serializer, .controller (API via auth.routes)         |
| auth-session                  | .dto, .validator, .controller (has .serializer)                          |
| auth-mfa                      | .dto, .validator, .serializer, .controller, .types (schemas split as auth-mfa-method / auth-mfa-recovery-code) |
| auth-mfa-session              | single-file Redis challenge-ticket store (`auth-mfa-session.ts`) — no layer files by design |
| auth-webauthn                 | .types, .controller (layers use the `webauthn.*` prefix; persistence as `webauthn-credential.repository/.schema`) |
| verification-token (nested)   | persistence-only module: .service, .repository, .schema only (no routes) |
| user-settings                 | .controller (routes served via user.routes)                              |
| user-notification-preferences | .controller (routes served via user.routes)                              |
| notification                  | .types                                                                   |
| permission                    | .validator                                                               |
| stripe-webhook                | .dto, .validator, .repository (event persistence as `stripe-webhook-event.repository.ts`) |
| webhook-event                 | .dto, .schema, .validator                                                |
| webhook-delivery (nested)     | .repository only (+ worker); no routed layer files                       |

---

## 5.1 Shared utilities (`src/shared/utils/`)

Utilities are grouped by concern. Prefer **deep imports** (e.g. `@/shared/utils/http/response.util.js`); `index.ts` re-exports the public API for transitional use.

| Folder | Examples |
| ------ | -------- |
| `http/` | `request.util`, `response.util`, `pagination.util`, `api-versioning.util`, `fastify-server.util`, `http-cache.util` |
| `security/` | `jwt.util`, `password.util`, `encryption.util`, `field-secret-encryption.util`, `allowed-origins.util`, `webhook-url.util`, `webhook-outbound-fetch.util` |
| `validation/` | `validation.util`, `bullmq-job-validation.util`, `file-magic.util`, `omit-undefined.util` |
| `infrastructure/` | `logger.util`, `postgres-error.util`, `readiness-probes.util`, `application-lifecycle.util`, `audit-record.util` |
| `identity/` | `public-id.util`, `public-id-param.util`, `uuid.util` |
| `auth/` | `authorization.util`, `global-admin-role.util` |
| `i18n/` | `translate-request.util`, `i18n-response.util` |
| `idempotency/` | `idempotency-key.util` |
| `text/` | `email.util`, `html-escape.util` |

**Middleware** (Fastify plugins) lives in `src/shared/middlewares/` — grouped by concern (`core/`, `security/`, `session/`, `tenant/`, `rate-limit/`) and registered via `registerMiddleware()` from `@/shared/middlewares/index.js`.

### Import path conventions

| Tree | Allowed | Forbidden |
| ---- | ------- | --------- |
| `src/**/*.ts` | `@/domains/...`, `@/shared/...`, `@/infrastructure/...`, `@/core/...`; same-folder `./` | Parent-relative `../` |
| `tooling/**/*.ts` | `@tooling/setup/...`, `@tooling/openapi/...`, etc.; same-folder `./` | Parent-relative `../` |

Always use `.js` extensions in import specifiers. CI gate: `src/tests/global/import-paths.global.test.ts`.

---

## 6. Access Rules (Actual)

### Within-domain

| Layer      | Imports                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller | Own service(s) from container, own serializer, own validator; `@/shared/utils/http/response.util.js`, `@/shared/utils/http/request.util.js`, `@/shared/errors/index.js`, Fastify types |
| Service    | Own repositories, own validators, other domains’ **services** (not repositories), `@/shared/errors`, infrastructure (e.g. mail queue, Stripe client, storage) as needed      |
| Repository | Own schema(s), `@/infrastructure/database/connection.js`; some extend `BaseRepository`. No repository imports another repository class (only schema imports for joins).      |

### Cross-domain

| From                                                                                                               | To                                                                                              | Use                                              | READ/WRITE        |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------- |
| organization.controller.ts                                                                                         | audit/audit.service.js                                                                          | Type-only `AuditService` for createOrganization  | WRITE (audit log) |
| auth (auth.service, email verification-code, oauth, auth-method, auth-mfa, auth-session)                                        | user/user.service.js                                                                            | UserService (findByEmail, createFromOAuth, etc.) | READ/WRITE        |
| tenancy/membership/member-invitation.service                                                                       | user/user.service.js                                                                            | UserService                                      | READ              |
| billing (subscription) services                                       | tenancy/organization/organization.service.js                                                    | OrganizationService                              | READ              |
| audit/audit.service                                                                                                | user/user.service.js, organization/organization.service.js                                      | UserService, OrganizationService                 | READ              |
| notify/notification.service                                                                                        | user/user.service.js                                                                            | UserService                                      | READ              |
| notify/webhook.service                                                                                             | tenancy/organization/organization.service.js                                                    | OrganizationService                              | READ              |
| upload/upload.service                                                                                              | user/user.service.js, organization/organization.service.js, permission/authorization.service.js | UserService, OrganizationService, permissions    | READ              |
| user/user-data-export/user-data-export.service                                                                 | auth/auth-session, tenancy/membership, notify/notification, audit/audit services (via `wireCrossDomainServices`) | GDPR export                                      | READ              |
| tenancy sub-services (membership, member-role, organization-settings, etc.)                                        | organization.repository (same domain)                                                           | Within-tenancy only                              | READ              |

### Queues and email

- `email-login.service.ts` → `eventBus.emit()` → handler → `recordOutboxEmail()` (see Event bus)
- `auth-method.service.ts` → `eventBus.emit()` → handler → `recordOutboxEmail()`
- `member-invitation.service.ts` → `eventBus.emit()` → handler → `recordOutboxEmail()` (see Event bus)

### Event bus

- `src/core/events/event-bus.ts` defines `EventBus` and `eventBus` singleton with `on()` and `emit()`.
- `src/core/events/register-event-handlers.ts` registers domain handlers from `buildApp()` before routes.
- **Member invitation:** `member-invitation.service.ts` emits `tenancy.member_invitation.created` / `tenancy.member_invitation.resent`; handlers in `tenancy/events/`.

### Violations and follow-up

- **None (layer cleanup pass):** No controller imports another controller. Cross-domain access uses other domains' services only; each service uses its own domain's repository.
- **Follow-up (separate PRs):** Optional `WebhookDeliveryService` extraction for `webhook-delivery.worker.ts` (worker already uses `createWorker*Repository(databaseHandle)` and `createTenantScopedBullMQWorker` — no `getRequestDatabase()`). New domain events/jobs only when product needs them. Tenancy sub-services using `organization.repository` within the tenancy domain is **intentional** — do not “fix” by injecting `OrganizationService` everywhere.

---

## 7. Route Mounting

**Root registration (`src/routes.ts`):**

| Mount path                          | Route file / export                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/api/v1/audit`                     | `auditRoutes(audit.auditService)` from `@/domains/audit/audit.routes.js`                         |
| `/api/v1/auth`                      | `authRoutes(auth)` from `@/domains/auth/auth.routes.js`                                          |
| `/api/v1/users`                     | `userRoutes(user)` from `@/domains/user/user.routes.js`                                          |
| `/api/v1/tenancy`                   | `tenancyRoutes({ ...tenancy, auditService })` from `@/domains/tenancy/tenancy.routes.js`         |
| `/api/v1/billing`                   | `billingRoutes(billing)` from `@/domains/billing/billing.routes.js`                              |
| `/api/v1/notify`                    | `notifyRoutes(notify)` from `@/domains/notify/notify.routes.js`                                  |
| `/api/v1/uploads`                   | `uploadRoutes(upload.uploadService)` from `@/domains/upload/upload.routes.js`                    |
| (conditional) `/admin/queues`       | `registerQueueDashboard(app, { auditService })` from `@/infrastructure/queue/queue-dashboard.js` |
| (conditional) `/api/v1/mcp`, `/mcp` | MCP server from `@/infrastructure/mcp/mcp-server.js`                                             |

**Tenancy sub-routes (registered inside `tenancy.routes.ts`):**

- `organizationRoutes(...)` — no extra prefix (routes under `/api/v1/tenancy`)
- `membershipRoutes(...)` — no extra prefix
- `memberRoleRoutes(...)` — no extra prefix
- `permissionRoutes(...)` — no extra prefix

**Billing and notify route composition:** `billing.routes.ts` and `notify.routes.ts` are thin composers that `app.register()` sub-domain route plugins (same pattern as `tenancy.routes.ts`).

---

## 8. DB Schema to Domain Mapping

**Shared namespaces:** `src/infrastructure/database/pg-schemas.ts` defines `authSchema`, `tenancySchema`, `billingSchema`, `notifySchema`, `auditSchema`, `uploadSchema`.

**Infrastructure exception:** `src/infrastructure/mail/mail-outbox.schema.ts` — transactional outbox table shared across domains (not under `domains/`).

**Schema files by domain (all under `src/domains/`):**

| Domain  | Schema files                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth    | auth-method/auth-method.schema.ts, auth-method/verification-token/verification-token.schema.ts, auth-session/auth-session.schema.ts, auth-mfa/auth-mfa-method.schema.ts, auth-mfa/auth-mfa-recovery-code.schema.ts, auth-webauthn/webauthn-credential.schema.ts                                                                                                                                                                                                         |
| user    | user.schema.ts, user-settings/user-settings.schema.ts, user-notification-preferences/user-notification-preferences.schema.ts                                                                                                                                                                                                                                                                                                              |
| tenancy | organization/organization.schema.ts, organization-settings/organization-settings.schema.ts, organization-notification-policy/organization-notification-policy.schema.ts, organization-api-key/organization-api-key.schema.ts, membership/membership.schema.ts, member-invitation/member-invitation.schema.ts, member-role/member-role.schema.ts, member-role-permission/member-role-permission.schema.ts, permission/permission.schema.ts |
| billing | plan/plan.schema.ts, subscription/subscription.schema.ts, stripe-webhook/stripe-webhook.schema.ts                                                                                                                                                                                                                                                                                                    |
| notify  | notification/notification.schema.ts, webhook/webhook.schema.ts                                                                                                                                                                                                                                                                                                                                                                            |
| audit   | audit.schema.ts                                                                                                                                                                                                                                                                                                                                                                                                                           |
| upload  | upload.schema.ts (`upload.uploads` table)                                                                                                                                                                                                                                                                                                                                                                                                 |

**Schemas with no matching repository:** `user-data-export` owns `user_data_exports` via `user-data-export.schema.ts`. Mail outbox schema is infrastructure-owned.

**Repositories with no matching schema in same folder:**

- **webhook-event:** has `webhook-event.repository.ts` but no `webhook-event.schema.ts`; likely uses webhook schema or shared table.

---

## 9. Naming Conventions (Actual)

**Sub-domain directory prefix patterns:**

- **user:** `user-settings`, `user-notification-preferences`, `user-data-export`
- **organization (under tenancy):** `organization-settings`, `organization-notification-policy`, `organization-api-key`
- **membership:** `member-invitation`
- **member-roles:** `member-role-permission`
- **auth:** `auth-method`, `auth-session`, `auth-mfa`, `auth-webauthn`
- **billing:** `stripe-webhook` (no billing- prefix)
- **webhook (under notify):** `webhook-event`

**Inconsistencies:**

- **plan**, **subscription** do not use a `billing-` prefix (standalone names under billing).

---

## 10. Missing / Inconsistent Items Report

- **webhook-event:** repository exists, no `webhook-event.schema.ts`.
- **notify/webhook-delivery:** nested implementation folder under `webhook/` (repos, queues, workers, events) — not a separate API resource.
- **auth-mfa-session:** Redis ticket store (no HTTP routes); exempt from standard layer matrix.
- **CLAUDE.md / domains-and-public-api-design.md:** Domain mapping tables include `user-data-export` and nested `organization-api-key` under `organization` (keep in sync when adding sub-domains).
- **No orchestrator layer:** Multi-sub-domain domains (**auth**, **user**, **billing**, **tenancy**, **notify**) wire sub-domain services via `<domain>.container.ts`; controllers call the appropriate service directly.
- **Sub-domains missing standard files:** A few sub-domains still lack .dto, .validator, .serializer, .types, or .controller as documented in Section 5 (e.g. auth-method, auth-session, auth-mfa, stripe-webhook, webhook-event, notification, permission); user-data-export, plan, user-settings, and user-notification-preferences now carry the full data-shape set.
- **Test layout:** Domain e2e at `<domain>/__tests__/`; sub-domain and **nested** sub-domain unit/e2e under `sub-domains/.../__tests__/`; event handler tests under `__tests__/unit/events/` (not `events/__tests__/`); shared tenancy helpers at `tenancy/__tests__/factories/permission.factory.ts`. See **CLAUDE.md** § Testing and **domains-and-public-api-design.md** §1.5. `src/tests/node_modules/` is gitignored Vite cache (do not commit).
