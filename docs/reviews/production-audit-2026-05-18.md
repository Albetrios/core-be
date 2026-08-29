<!-- markdownlint-disable MD025 MD022 MD032 MD036 MD051 MD024 MD041 MD040 MD031 MD007 MD012 MD009 MD026 MD013 MD046 MD038 -->

# Production audit — core-be (2026-05-18)

> **Method:** Principal-engineer review of the full in-scope stack (Node 24, Fastify, Drizzle, Postgres RLS, Redis, BullMQ, Vitest, Docker, Railway CI). Evidence is file-anchored; technologies outside the repo scope (K8s-primary, GraphQL, Prometheus-as-required) are excluded per audit charter.
>
> **Prior snapshots:** [production-readiness-2026-05-15.md](./production-readiness-2026-05-15.md) (P0 fixes), [full-codebase-review-deliverables.md](./full-codebase-review-deliverables.md). This audit **confirms** most P0/P1 items from 2026-05-15 remain in place and adds delta findings from the current tree (821 TS files, 333 tests, 135 routes, 23 migrations).

---

# Executive Summary

| Dimension | Score (0–100) | Notes |
| --------- | ------------- | ----- |
| **Overall** | **79** | Strong foundations; gaps are mostly scale, observability depth, and a few API/security edges |
| Security | 82 | RLS FORCE, JWT RS256 prod, MCP/dashboard gated; BullMQ payload validation and numeric API IDs are gaps |
| Reliability | 80 | DLQ, graceful shutdown, Stripe idempotency ledger; organization-scoped RLS txn holds pool slots per request |
| Scalability | 72 | Default `DATABASE_POOL_MAX=10`, per-request pinned transactions, limited load-test route coverage |
| Maintainability | 86 | Domain layout, skills, CI gates, route catalog; a few large services |
| DevOps | 88 | Multi-job CI, Trivy, HEALTHCHECK, non-root image |
| Testing | 81 | 90%/95% coverage thresholds, RLS matrix; HTTP tenant-isolation suite thin on billing/upload |

**Production readiness verdict:** **Moderately Ready** (controlled production / early enterprise); not **Enterprise Ready** until metrics path, broader tenant-isolation HTTP coverage, and SAML/advanced compliance are addressed.

**Regression vs 2026-05-15:** No regressions found on MCP auth, scoped idempotency, notifications RLS, or security CI job. Prometheus remains intentionally removed ([observability runbook](../deployment/runbooks/observability.md)).

---

# Top 20 Critical Issues

| # | Title | Severity | Category | Section |
| - | ----- | -------- | -------- | ------- |
| 1 | [BullMQ job payloads lack Zod validation at enqueue](#issue-bullmq-no-zod) | High | Security | §2, §5 |
| 2 | [Organization RLS transaction pins a pool connection for entire HTTP request](#issue-rls-txn-pool) | High | Scalability | §3, §6 |
| 3 | [Cross-tenant HTTP tests omit billing, upload, audit domains](#issue-tenant-http-gaps) | High | Testing | §7 |
| 4 | [No Prometheus/metrics scrape path (deferred)](#issue-no-prometheus) | Medium | Observability | §9 |
| 5 | [Internal numeric IDs exposed in organization-notification-policy API](#issue-numeric-policy-id) | Medium | API | §4 |
| 6 | [GDPR export uses cross-domain Drizzle reads without repository/RLS layering](#issue-gdpr-export-layer) | Medium | Architecture | §1 |
| 7 | [Default Postgres pool size (10) may bottleneck under concurrent organization traffic](#issue-db-pool-default) | Medium | Performance | §6 |
| 8 | [Cookie refresh allows absent `Origin` (non-browser clients)](#issue-cookie-origin-absent) | Medium | Security | §2 |
| 9 | [Subscription service complexity (~296 LOC) increases change risk](#issue-subscription-god) | Medium | Maintainability | §1 |
| 10 | [k6 load scenarios cover subset of 135 routes](#issue-k6-coverage) | Medium | Testing | §7 |
| 11 | [Idempotency middleware applies to all write routes without per-route catalog](#issue-idempotency-catalog) | Low | API | §4 |
| 12 | [Stripe webhook events table has no RLS (by design) — requires strict worker scoping](#issue-stripe-ledger-no-rls) | Low | Database | §3 |
| 13 | [Mail outbox table has no tenant RLS](#issue-mail-outbox-no-rls) | Low | Database | §3 |
| 14 | ~~`withTransaction` only used in removed billing repository, not centralized in services~~ — **Resolved**: legacy local payment-instrument domain removed (Stripe owns payment instruments); rule now applies to surviving multi-write services | — | — | — |
| 15 | [ENABLE_MCP_SERVER defaults false but tests default true](#issue-mcp-test-env) | Low | DevOps | §8 |
| 16 | [Deploy workflow may still reference removed `METRICS_*` secrets](#issue-metrics-env-stale) | Low | DevOps | §8 |
| 17 | ~~Billing repositories do not filter `deleted_at` in grep sample~~ — **Resolved**: legacy billing-document tables and repositories removed during schema consolidation (Stripe is the source of truth) | — | — | — |
| 18 | [Queue dashboard enables destructive ops for super_admin only — operational blast radius](#issue-queue-dashboard) | Low | Operations | §2 |
| 19 | [SAML / advanced SSO not implemented](#issue-no-saml) | Improvement | Compliance | §11 |
| 20 | [Data residency and automated backup/DR not implemented in code](#issue-dr-gap) | Medium | Operations | §11 |

---

# Immediate Must-Fix

Before broad production traffic or enterprise onboarding:

1. Add **Zod parse** (or shared schema) at BullMQ `queue.add` boundaries for all job types ([mail](#issue-bullmq-no-zod), [stripe-webhook](#issue-bullmq-no-zod), [notification](#issue-bullmq-no-zod), [webhook-delivery](#issue-bullmq-no-zod)).
2. Extend **`tenant-isolation.security.test.ts`** (or catalog-driven security tests) to **billing** subscription and **upload** list routes.
3. Document and load-test **organization RLS transaction** pool impact; tune `DATABASE_POOL_MAX` / connection limits on Railway per [resource-limits runbook](../deployment/runbooks/resource-limits.md).
4. Add **`public_id`** to organization-notification-policy (migration + serializer) or document numeric ID as intentional with rate limits.
5. Reconcile **deploy env** with observability deferral (remove stale `METRICS_*` if still in workflow).

---

# 30 / 60 / 90 Day Roadmap

| Window | Focus |
| ------ | ----- |
| **30 days** | BullMQ Zod payloads; billing/upload tenant HTTP tests; policy `public_id`; env/deploy cleanup; run `pnpm test:coverage` on CI DB consistently |
| **60 days** | Re-enable Prometheus per observability runbook; expand k6 to top 20 routes by traffic; pool/RLS-txn load test |
| **90 days** | SAML/SSO spike; automated backup verification runbook; GDPR export refactor behind repositories; subscription service decomposition |

---

# Deep findings (14 sections)

## 1. Architecture

### Satisfied strengths

- Thin central [`src/routes.ts`](../../src/routes.ts) registers seven domains under `/api/v1` via `domainContainersPlugin`.
- No cross-domain **repository** imports from `*.service.ts` (grep clean except same sub-domain dispatch).
- No DB access in controllers (no `@/infrastructure/database` in `*.controller.ts`).
- Documented flat sub-domains (e.g. nested children promoted to direct sub-domains per layout rules).

---

### GDPR export bypasses repository layer (documented exception)

#### Severity
Medium

#### Category
Architecture

#### Current Problem
`UserDataExportService` issues cross-schema Drizzle queries directly, bypassing domain repositories and HTTP RLS middleware. This is documented in CLAUDE.md but increases coupling and makes tenant-isolation testing harder for export paths.

#### Evidence
[`src/domains/user/sub-domains/user-data-export/user-data-export.service.ts`](../../src/domains/user/sub-domains/user-data-export/user-data-export.service.ts) lines 51–76: `getRequestDatabase().select()` across `users`, `memberships`, `organizations`, `sessions`, `notifications`, `logs`.

#### Production Risk
Schema drift in any domain breaks export; a bug in `userPublicId` scoping could over-fetch another user's organization memberships. Blast radius: GDPR compliance incident.

#### Recommended Fix
Keep export orchestration in the sub-domain but delegate reads to each domain's **read-only service methods** (or a dedicated export repository module per domain). Add integration test asserting user A cannot export user B's data.

#### Implementation Priority
Before enterprise onboarding

#### Estimated Complexity
Large

---

### Subscription service size and Stripe coupling

#### Severity
Medium

#### Category
Maintainability

#### Current Problem
`SubscriptionService` (~296 lines) mixes Stripe SDK calls, validation, and repository sync—elevated regression risk for billing-critical paths.

#### Evidence
[`src/domains/billing/sub-domains/subscription/subscription.service.ts`](../../src/domains/billing/sub-domains/subscription/subscription.service.ts) — imports `stripe.client` and multiple validators in one class.

#### Production Risk
Billing bugs on plan change / cancel under load; difficult code review.

#### Recommended Fix
Extract Stripe adapter calls to existing `stripe.client` helpers only; split read vs write methods or introduce a small `subscription-stripe-sync.service.ts` for webhook-aligned updates.

#### Implementation Priority
Technical debt backlog

#### Estimated Complexity
Medium

---

### Transactions live in repository layer only

#### Severity
Low

#### Category
Architecture

#### Current Problem
Project convention places multi-write atomicity in services via `withTransaction`. The original audit flagged a now-removed local payment-instrument repository as the lone usage; that sub-domain has since been removed (Stripe owns payment instruments). The rule still applies to any surviving multi-write service.

#### Evidence
[`src/infrastructure/database/transaction.ts`](../../src/infrastructure/database/transaction.ts); [`transaction-rollback.integration.test.ts`](../../src/tests/integration/database/transaction-rollback.integration.test.ts) exercises rollback. Re-check `withTransaction` usage under `src/domains/` when adding multi-write flows.

#### Production Risk
Future multi-write service methods may commit partial state.

#### Recommended Fix
When adding multi-table writes, use `withTransaction` in the **service** (or repository private method called from service), not ad-hoc sequential awaits.

#### Implementation Priority
Before scale

#### Estimated Complexity
Small

---

## 2. Security

### Satisfied strengths

- JWT RS256 required in production (`env-schema` refine); 15-minute access tokens ([`jwt.util.ts`](../../src/shared/utils/security/jwt.util.ts)).
- MCP routes require JWT + `super_admin`/`admin` ([`mcp-server.ts`](../../src/infrastructure/mcp/mcp-server.ts) lines 291–311).
- Idempotency keys scoped per organization/user ([`idempotency.middleware.ts`](../../src/shared/middlewares/core/idempotency.middleware.ts) `resolveIdempotencyScope`).
- Stripe webhook signature + raw body ([`stripe-webhook-ingress.plugin.ts`](../../src/domains/billing/sub-domains/stripe-webhook/stripe-webhook-ingress.plugin.ts); controller enqueues only).
- Session refresh Origin check when `ALLOWED_ORIGINS` set ([`cookie-session-origin.pre-handler.ts`](../../src/shared/middlewares/cookie-session-origin.pre-handler.ts)).

---

### BullMQ job payloads lack Zod validation {#issue-bullmq-no-zod}

#### Severity
High

#### Category
Security

#### Current Problem
All four domain queues define TypeScript `interface` job data only. A compromised producer, bug, or manual queue dashboard add could enqueue malformed payloads; workers trust shape at runtime.

#### Evidence
- [`src/infrastructure/mail/queues/mail.queue.ts`](../../src/infrastructure/mail/queues/mail.queue.ts) — `MailJobData` interface, no `safeParse`
- [`src/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.ts`](../../src/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.ts)
- [`src/domains/notify/sub-domains/notification/queues/notification.queue.ts`](../../src/domains/notify/sub-domains/notification/queues/notification.queue.ts)
- [`src/domains/notify/sub-domains/webhook/queues/webhook-delivery.queue.ts`](../../src/domains/notify/sub-domains/webhook/queues/webhook-delivery.queue.ts)

#### Production Risk
Worker exceptions, wrong-tenant delivery if `organizationPublicId` missing, DLQ storms. Probability: medium after dashboard misuse or code bug.

#### Recommended Fix
Add `*.job.schema.ts` with Zod per queue; `safeParse` in `enqueue*` helpers; throw before `queue.add`. Mirror pattern from route DTOs.

#### Implementation Priority
Immediate

#### Estimated Complexity
Medium

---

### Cookie session refresh permits missing Origin {#issue-cookie-origin-absent}

#### Severity
Medium — **resolved (2026-05-20)**

#### Category
Security

#### Resolution
Production **`POST /api/v1/auth/refresh`** requires **`Origin`** on the allowlist **or** CSRF double-submit (`X-CSRF-Token` matching `csrf_token` cookie). `Referer` fallback is disabled in production. See [`csrf-and-session-cookies.md`](../reference/security/csrf-and-session-cookies.md).

---

### Queue dashboard super_admin mutations

#### Severity
Low

#### Category
Operations

#### Current Problem
`ENABLE_QUEUE_DASHBOARD` exposes Bull Board with pause/retry/obliterate APIs for `super_admin`, audited to `audit.logs`.

#### Evidence
[`queue-dashboard.ts`](../../src/infrastructure/queue/queue-dashboard.ts) lines 198–218; security test [`queue-dashboard-audit.security.test.ts`](../../src/tests/security/infrastructure/queue-dashboard-audit.security.test.ts).

#### Production Risk
Operational mistake replays poison jobs or empties queues.

#### Recommended Fix
Keep disabled in production unless needed; restrict to break-glass VPN; consider read-only dashboard mode.

#### Implementation Priority
Before scale

#### Estimated Complexity
Small

---

## 3. Database

### Satisfied strengths

- FORCE RLS on tenant tables ([`20260516000006_force_row_level_security.sql`](../../migrations/00000000000000_init.sql)).
- Notifications RLS added 2026-05-15 ([`20260515000001_notifications_rls.sql`](../../migrations/00000000000000_init.sql)).
- Stripe webhook idempotency ledger ([`stripe-webhook.service.ts`](../../src/domains/billing/sub-domains/stripe-webhook/stripe-webhook.service.ts) `tryClaimEvent`).
- Security test matrix for FORCE RLS ([`rls-matrix.security.test.ts`](../../src/tests/security/rls/rls-matrix.security.test.ts)).

---

### Organization RLS transaction holds pool connection {#issue-rls-txn-pool}

#### Severity
High

#### Category
Scalability

#### Current Problem
When `X-Organization-Id` is set, `organizationRlsTransactionMiddleware` pins one Postgres checkout for the **entire** request (BEGIN + SET LOCAL until response). Under high concurrency this exhausts `DATABASE_POOL_MAX` (default 10) faster than autocommit-per-query handlers.

#### Evidence
[`organization-rls-transaction.middleware.ts`](../../src/shared/middlewares/tenant/organization-rls-transaction.middleware.ts) lines 49–58 comment and implementation.

#### Production Risk
503s / timeouts when pool saturated; slow handlers block slots for 30s statement timeout.

#### Recommended Fix
Load-test organization-scoped routes; increase `DATABASE_POOL_MAX` and Railway Postgres limits; keep handlers short; consider narrowing middleware to routes that truly need RLS GUC on same connection.

#### Implementation Priority
Before scale

#### Estimated Complexity
Medium

---

### System tables without tenant RLS (intentional)

#### Severity
Low

#### Category
Database

#### Current Problem
`billing.stripe_webhook_events` and `auth.mail_outbox` have no RLS—documented as system tables. Workers must not expose them via HTTP.

#### Evidence
[`20260517000003_stripe_webhook_events_and_subscription_monotonic.sql`](../../migrations/00000000000000_init.sql) header comment; [`20260516000007_mail_outbox.sql`](../../migrations/00000000000000_init.sql).

#### Production Risk
Low if workers use explicit scoping; SQL injection or raw admin tools could read global mail queue.

#### Recommended Fix
Ensure `core_be_app` role has minimal privileges; no HTTP routes to these tables.

#### Implementation Priority
Before enterprise onboarding

#### Estimated Complexity
Small

---

### Legacy billing-document repository soft-delete filtering — **Resolved**

#### Resolution

Legacy billing-document and payment-instrument tables were dropped during schema consolidation. The billing surface is now subscription-only — Stripe is the source of truth for those entities (users access them via the Stripe Customer Portal). No local soft-delete parity needed.

---

## 4. API

### Satisfied strengths

- Single public version prefix `/api/v1` ([`api-versioning.util.ts`](../../src/shared/utils/http/api-versioning.util.ts)).
- Route catalog 135 routes, CI `routes:catalog:check`.
- i18n keys in auth errors ([`auth.middleware.ts`](../../src/shared/middlewares/core/auth.middleware.ts)).
- Global write idempotency middleware.

---

### Numeric internal IDs in notification policy API {#issue-numeric-policy-id}

#### Severity
Medium

#### Category
API

#### Current Problem
`OrganizationNotificationPolicyOutput.id` is `number` (internal PK), unlike other resources using `public_id` as `id`.

#### Evidence
[`organization-notification-policy.serializer.ts`](../../src/domains/tenancy/sub-domains/organization/organization-notification-policy/organization-notification-policy.serializer.ts) line 11: `id: row.id`; routes use `:policyId` integer paths.

#### Production Risk
Enumeration of policies; inconsistent API contract for clients; harder to merge data across environments.

#### Recommended Fix
Add `public_id` column + migration; serialize `id: row.public_id`; deprecate numeric path with sunset header.

#### Implementation Priority
Before enterprise onboarding

#### Estimated Complexity
Medium

---

### Idempotency on all writes

#### Severity
Low

#### Category
API

#### Current Problem
Idempotency middleware applies to all POST/PUT/PATCH/DELETE when `Idempotency-Key` header present; route catalog does not document which routes **require** it for Stripe forwarding.

#### Evidence
[`idempotency.middleware.ts`](../../src/shared/middlewares/core/idempotency.middleware.ts) `WRITE_METHODS`.

#### Production Risk
Client confusion; duplicate subscription creates if client omits key.

#### Recommended Fix
Document required idempotency routes in OpenAPI + route catalog; forward key to Stripe in subscription create (optional improvement from path-to-production-gate).

#### Implementation Priority
Technical debt backlog

#### Estimated Complexity
Small

---

## 5. Reliability

### Satisfied strengths

- API shutdown: queues → Redis → DB → Sentry ([`shutdown.middleware.ts`](../../src/shared/middlewares/core/shutdown.middleware.ts)).
- Worker shutdown: workers → DLQ queues → Redis → DB ([`worker.ts`](../../src/worker.ts)).
- Event bus swallows handler errors ([`event-bus.ts`](../../src/core/events/event-bus.ts) lines 24–31).
- DLQ + Sentry on final failure ([`dead-letter.ts`](../../src/infrastructure/queue/dlq/dead-letter.ts)).
- Stripe async processing via queue after HTTP 200 ack.

---

### Stripe webhook HTTP ack before processing completes

#### Severity
Low

#### Category
Reliability

#### Current Problem
Controller enqueues job and returns 200 immediately; failures happen in worker. Correct for Stripe retries but requires DLQ monitoring.

#### Evidence
[`stripe-webhook.controller.ts`](../../src/domains/billing/sub-domains/stripe-webhook/stripe-webhook.controller.ts) `enqueueStripeWebhook`.

#### Production Risk
Silent billing drift if worker down; mitigated by Stripe retries + event ledger.

#### Recommended Fix
Alert on DLQ depth (existing `DLQ_DEPTH_*` cron); integration test for failed worker + retry.

#### Implementation Priority
Before scale

#### Estimated Complexity
Small

---

## 6. Performance

### Satisfied strengths

- Statement and idle-in-transaction timeouts on pool ([`connection.ts`](../../src/infrastructure/database/connection.ts)).
- Redis key prefix and retry strategy (production-hardening checklist).
- Compression middleware registered first in stack.

---

### Default DB pool max 10 {#issue-db-pool-default}

#### Severity
Medium

#### Category
Performance

#### Current Problem
`DATABASE_POOL_MAX` defaults to 10 per API process. Combined with per-request RLS transactions, effective concurrency is low.

#### Evidence
[`connection.ts`](../../src/infrastructure/database/connection.ts) line 48: `max: env.DATABASE_POOL_MAX ?? 10`.

#### Production Risk
Latency spikes under parallel organization users.

#### Recommended Fix
Set `DATABASE_POOL_MAX` per Railway instance size; horizontal scale API replicas; monitor pool wait time in logs.

#### Implementation Priority
Before scale

#### Estimated Complexity
Small

---

### k6 scenario coverage limited {#issue-k6-coverage}

#### Severity
Medium

#### Category
Performance

#### Current Problem
Eight k6 scripts exist (health, billing, auth-onboarding, webhooks, etc.) but 135 routes exist—many permission-gated organization routes untested under load.

#### Evidence
[`src/tests/load/k6/scenarios/`](../../src/tests/load/k6/scenarios/) listing; [`docs/routes.txt`](../routes.txt) 135 routes.

#### Production Risk
Undiscovered hot-path regressions (permission cache, RLS subqueries).

#### Recommended Fix
Add k6 scenarios for top N routes from production analytics; run in `load-tests.yml` on schedule.

#### Implementation Priority
Before scale

#### Estimated Complexity
Medium

---

## 7. Testing

### Satisfied strengths

- Per-file coverage 90% global, 95% auth/billing/tenancy + auth/tenant middleware ([`vitest.config.ts`](../../vitest.config.ts)).
- RLS matrix security suite.
- Dedicated `pnpm test:security` CI job.
- Chaos (Toxiproxy) and contract (nock) configs exist.

---

### Cross-tenant HTTP tests omit billing and upload {#issue-tenant-http-gaps}

#### Severity
High

#### Category
Testing

#### Current Problem
`tenant-isolation.security.test.ts` covers tenancy settings/memberships and notify webhooks only—not billing subscriptions or uploads.

#### Evidence
[`tenant-isolation.security.test.ts`](../../src/tests/security/rls/tenant-isolation.security.test.ts) — 4 cases, no `/api/v1/billing/...` paths.

#### Production Risk
Authorization bug in billing controller could ship despite green CI.

#### Recommended Fix
Extend tests or use catalog-driven `auth-enforcement` pattern for all `PERM:` routes in `docs/routes.txt`.

#### Implementation Priority
Immediate

#### Estimated Complexity
Medium

---

### Coverage gate requires live Postgres

#### Severity
Low

#### Category
Testing

#### Current Problem
2026-05-15 review noted local `pnpm test:coverage` blocked without Docker DB; CI runs with DB but local drift possible.

#### Evidence
[production-readiness-2026-05-15.md](./production-readiness-2026-05-15.md) baseline table.

#### Production Risk
Developers merge without running full coverage locally.

#### Recommended Fix
Document `docker compose up` + `DATABASE_URL` in CONTRIBUTING; keep CI as source of truth.

#### Implementation Priority
Technical debt backlog

#### Estimated Complexity
Small

---

## 8. DevOps & infrastructure

### Satisfied strengths

- Multi-stage Dockerfile, `USER node`, API `HEALTHCHECK` ([`Dockerfile`](../../Dockerfile)).
- CI: quality-static, test-with-db, api-smoke, chaos, docker-build + Trivy ([`.github/workflows/pr-ci.yml`](../../.github/workflows/pr-ci.yml)).
- Gitleaks, Semgrep, `pnpm audit` in quality pipeline.
- `docker-compose.yml` for Postgres 16 + Redis 7.

---

### Prometheus / METRICS env deferral {#issue-no-prometheus}

#### Severity
Medium

#### Category
Observability

#### Current Problem
~~Prometheus removed~~ — **resolved in code (2026-05-20):** `prom-client`, `GET /metrics` on API and worker (`startWorkerHealthServer` in `src/worker.ts`), audit metrics (`event_loop_lag_ms`, `pg_pool_*`, `http_request_duration_seconds`, `bullmq_jobs_waiting`). **`METRICS_ENABLED` defaults true in production**; set **`METRICS_SCRAPE_TOKEN`** and configure an external scraper (Grafana Alloy / Prometheus).

#### Evidence
[observability.md](../deployment/runbooks/observability.md); [`src/infrastructure/observability/`](../../src/infrastructure/observability/).

#### Production Risk
No scrape-based SLOs until env + external Prometheus/Grafana are enabled.

#### Recommended Fix
Set `METRICS_ENABLED=true` and `METRICS_SCRAPE_TOKEN` on API + worker; configure platform scraper. See observability runbook § Prometheus (opt-in).

#### Implementation Priority
Before scale (ops enablement only)

#### Estimated Complexity
Small (ops)

---

### MCP enabled in test setup by default

#### Severity
Low

#### Category
DevOps

#### Current Problem
`src/tests/setup.ts` sets `ENABLE_MCP_SERVER ??= 'true'` while production schema defaults false—tests may miss prod config.

#### Evidence
[`src/tests/setup.ts`](../../src/tests/setup.ts); [`env-schema.ts`](../../src/shared/config/env-schema.ts) `ENABLE_MCP_SERVER` default false.

#### Production Risk
Low; accidental MCP enable in prod if env mis-set.

#### Recommended Fix
Assert MCP routes 404 when flag false in smoke test.

#### Implementation Priority
Technical debt backlog

#### Estimated Complexity
Small

---

## 9. Observability

### Satisfied strengths

- Sentry init before server/worker; uncaught/unhandled handlers exit after flush.
- Pino redaction paths ([`logger.util.ts`](../../src/shared/utils/infrastructure/logger.util.ts)).
- Health live/ready; BullMQ readiness in infrastructure health.
- Idempotency cardinality + DLQ depth repeatable jobs.

### Gaps

- Prometheus in code, opt-in in prod — see [#issue-no-prometheus](#issue-no-prometheus); Grafana/scraper still external.
- OpenTelemetry deferred to Sentry traces.

---

## 10. Maintainability

### Satisfied strengths

- AGENTS.md, CLAUDE.md, 30+ skills, `pnpm validate:domain`.
- Biome replaces ESLint/Prettier; Husky pre-commit.
- Sub-domain layout migration largely complete.

### Gaps

- Large billing/auth services (see §1).
- Minor abbreviation in comments (`org` in authorization JSDoc) — tests use `org` in fixtures only.

---

## 11. Enterprise & scale readiness

| Feature | Status |
| ------- | ------ |
| SAML / SSO | **Not implemented** (gap only) |
| GDPR export | Implemented via user-data-export (layering debt) |
| Data residency | Not in code |
| SOC2 audit trail | Audit domain + queue dashboard audit; not full SIEM |
| i18n | en/es locales |
| Prometheus SLOs | Deferred |

---

## 12. Dependencies

### Satisfied strengths

- `pnpm audit` clean per 2026-05-15 and full-codebase review.
- ioredis override documented in deliverables.

### Watch items

- `@modelcontextprotocol/sdk` for MCP — keep updated.
- Stripe SDK — contract tests under `src/tests/contract/`.

---

## 13. Code quality

### Satisfied strengths

- Strict env Zod schema with production JWT key refine.
- Typed errors + i18n in middleware.
- Event bus isolated from HTTP failure path.

---

## 14. Incident prevention scenarios

| Scenario | Trigger | Blast radius | Mitigation |
| -------- | ------- | ------------ | ---------- |
| **Duplicate Stripe webhook** | Stripe retries same `event.id` | Double subscription state | `tryClaimEvent` ledger + monotonic `last_stripe_event_created_at` |
| **Queue explosion** | Webhook fan-out / mail backlog | Redis memory, slow workers | DLQ depth worker; rate limits; `removeOnComplete` limits in queue options |
| **DB pool exhaustion** | Traffic spike + RLS txn per request | All organization routes 503 | Tune `DATABASE_POOL_MAX`, scale replicas, shorten handlers |
| **Auth bypass** | Missing `requireOrganizationPermission` on new route | Cross-tenant data | Route catalog + `auth-enforcement` / expand tenant-isolation tests |
| **Billing bug** | Out-of-order subscription events | Wrong plan/status | Monotonic migration functions; webhook service tests |
| **Migration failure** | Unsafe DDL in prod | Downtime | `pnpm db:migrate:lint`; no destructive without flag |
| **Config drift** | `.env` missing `ALLOWED_ORIGINS` in prod | CORS throw at startup | `env-schema` production refine |
| **Clock/timezone** | Stripe `event.created` vs DB `timestamptz` | Skipped updates | Store UTC; use Stripe timestamp in monotonic guard |

---

# Architecture recommendations (long-term)

Stay **modular monolith**: domains remain deployment units of ownership; extract only when measurable pain (billing webhook throughput, notify delivery). Prefer:

1. **Read models** for heavy list endpoints before microservices.
2. **Outbox pattern** (mail outbox already) for all external side effects.
3. **Public IDs everywhere** in external APIs (fix policy numeric ID).

---

# Technical debt priorities

1. BullMQ Zod payloads  
2. Tenant HTTP tests for billing/upload  
3. Notification policy `public_id`  
4. GDPR export repository refactor  
5. Subscription service split  
6. k6 expansion  

---

# Missing enterprise features (gaps only)

- SAML / OIDC enterprise SSO  
- Prometheus + Grafana SLO dashboards  
- Automated cross-region DR  
- Data residency controls  
- CAPTCHA on public auth (out of scope unless added)

---

# Production readiness verdict

**Moderately Ready** — suitable for production with monitoring and the Immediate Must-Fix list; not **Enterprise Ready** without SSO, metrics, and broader compliance automation.

---

# Future scaling risks

- Org-scoped RLS transaction × default pool size  
- Permission cache invalidation storms on role changes  
- Redis idempotency key cardinality (mitigated by sampling worker)  
- BullMQ single Redis namespace (use prefix per AGENTS parallel worktree contract for multi-env only)

---

# Observability gaps summary

- No scrape metrics (deferred)  
- Logs only to stdout (Railway drain) — Loki documented optional  
- Sentry sampling rates should be reviewed at 10× traffic  

---

# Security risks summary

- BullMQ payload validation  
- Cookie refresh without Origin  
- Numeric policy IDs  
- MCP/queue dashboard if misconfigured env flags  

---

# Reliability risks summary

- Async Stripe processing dependency on workers  
- Pool saturation under RLS pinning  
- External provider outages (circuit breakers present for Stripe/S3/Resend)  

---

# Testing gaps summary

- Billing/upload HTTP tenant isolation  
- k6 vs full route surface  
- Local coverage without Docker  

---

# Final recommendations

1. Run **`pnpm ci:local`** on every release candidate (includes coverage).  
2. Treat [production-hardening-guard](../../.cursor/skills/production-hardening-guard/SKILL.md) as pre-deploy checklist.  
3. Re-run this audit after major domain additions or Prometheus re-enable.  
4. Keep [production-readiness-2026-05-15.md](./production-readiness-2026-05-15.md) as historical snapshot; use **this file** as the current full audit.

---

*Audit completed 2026-05-18. Reviewer: automated principal-engineer pass (Cursor agent).*

**Remediation (code):** P0–P3 implementation tracked in [audit-gaps-remediation-status-2026-05-18.md](./audit-gaps-remediation-status-2026-05-18.md). Remaining gate: per-file coverage on touched modules (`pnpm test:coverage`).
