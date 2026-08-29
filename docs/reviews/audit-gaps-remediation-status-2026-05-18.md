# Audit gaps remediation — status (2026-05-18)

Tracks implementation of the consolidated plan from [production-audit-2026-05-18.md](./production-audit-2026-05-18.md) (P0–P3, 77 tasks). Source plan: `.cursor/plans/audit_gaps_task_list_3175cdae.plan.md` (do not edit the plan file).

**Last verification:** `pnpm validate` and **`pnpm ci:local` pass** (2026-05-19). `pnpm test:coverage` — **~2,151 tests**, Stage 5 per-file thresholds green (~**99.3%** statements, **~97.7%** branches).

---

## Summary

| Tier | Tasks | Code status | CI / ops |
| ---- | ----- | ----------- | -------- |
| **P0** (7) | Blockers | **Done** in tree | Migrations applied locally (`20260518*` × 8) |
| **P1** (18) | High | **Done** in tree | Coverage + CI gate green |
| **P2** (30) | Medium | **Done** in tree | Metrics opt-in documented (`METRICS_ENABLED`) |
| **P3** (22) | Backlog | **Done** except deferrals | See [deferred](#deferred--intentional) |

---

## P0 — Implemented (reference)

| ID | Item | Key artifacts |
| -- | ---- | ------------- |
| P0-01 | BullMQ Zod at enqueue + worker | `bullmq-job-validation.util.ts`, `*.job.schema.ts`, mail/stripe/notification/webhook queues + workers |
| P0-02 | Permission cache invalidation | `member-role-permission.service.ts`, `membership.service.ts` |
| P0-03 | MFA TOTP encrypt at rest | `field-secret-encryption.util.ts`, `auth-mfa.service.ts` |
| P0-04 | Webhook signing secret encrypt; API omits secret | `webhook.service.ts`, `webhook.serializer.ts`, `webhook-delivery.worker.ts` |
| P0-05 | `auth.verification_tokens` RLS policies | `migrations/20260518000001_verification_tokens_rls_policies.sql` |
| P0-06 | Stripe webhook fail-closed without organization | `stripe-webhook-organization.util.ts` |
| P0-07 | Header vs path organization mismatch → 400 | `tenant.middleware.ts`, i18n `organizationHeaderPathMismatch` |
| Audit #5 | Stripe webhook signature at HTTP layer boundary | `stripe-webhook-ingress.plugin.ts`, `stripe-webhook.routes.ts` (`/stripe` prefix encapsulation), `stripe-webhook-ingress.policy.unit.test.ts` |

---

## P1 — Implemented (reference)

OAuth PKCE, membership public IDs, sessions/notification-prefs/notifications RLS, subscription webhook SQL organization scope, event emits via services, subscription Stripe compensation, tenant security tests (billing/upload), Stripe duplicate webhook integration test, S3 presign + `POST /uploads/:publicId/confirm`, CI/deploy alignment, pool/RLS docs. (Legacy billing-document and payment-instrument tables were later dropped — Stripe is the source of truth for those entities.)

New migrations (apply with `pnpm db:migrate`):

- `20260518000002_auth_sessions_rls.sql`
- `20260518000003_user_notification_preferences_rls.sql`
- `20260518000004_notifications_rls_tighten.sql`
- `20260518000005_organization_notification_policy_public_id.sql`
- `20260518000006_billing_provider_id_indexes.sql`
- `20260518000007_upload_force_rls.sql`
- `20260518000008_webhook_delivery_event_key.sql`

---

## Coverage and CI gate — resolved

Stage 5 thresholds: **90%** global per file (services/repos/controllers/shared); **95%** for `src/domains/auth/**`, `billing/**`, `tenancy/**`, and auth/tenant middleware.

Re-check:

```bash
pnpm test:coverage 2>&1 | grep '^ERROR:'   # expect no output
pnpm ci:local
```

**2026-05-19:** Unit tests added for audit-touched services/repos; `pnpm test:coverage` and `pnpm ci:local` pass with no `ERROR:` lines.

### Test stability (integration / e2e)

Flaky organization-scoped integration tests were fixed by:

| Change | Why |
| ------ | --- |
| Exclude `*.integration.test.ts` / `*.e2e.test.ts` from Vitest `default` project | Same files were also in `e2e`, causing duplicate runs and `cleanupDatabase()` races |
| `test` / `test:coverage` run `--project default --project e2e --maxWorkers=1` | Single worker against shared Postgres |
| `injectAuthenticatedOrganizationMutation()` in `test-http-inject.helper.ts` | Org RLS transactions commit in `onResponse` after `inject()` returns; follow-up reads need a short yield |
| `organization-api-key` rotate: fail if `softDelete` returns null | Prevents duplicate active keys when delete does not apply |

Key test helpers: `waitForOrganizationRlsTransactionCommit`, `injectAuthenticatedOrganizationMutation` (`src/tests/helpers/test-http-inject.helper.ts`). Vitest layout: `tooling/vitest/projects.ts`.

---

## Production and environment (required before deploy)

| Item | Action |
| ---- | ------ |
| **`SECRETS_ENCRYPTION_KEY`** | Set in production (64 hex chars). Optional in `.env.example`. Without it, MFA/webhook secrets fall back to `RESPONSE_ENCRYPTION_KEY` or JWT-derived key — **rotate after setting dedicated key**. |
| **Existing plaintext secrets** | Re-save MFA methods and webhook signing secrets (or run one-time migration script) so DB values use `v1:` prefix. |
| **Migrations** | Run `pnpm db:migrate` on every environment (8 new `20260518*` files). |
| **OpenAPI drift** | After route changes, run `pnpm docs:generate:multilang` locally (gitignored specs; `pnpm docs:check` in CI). |
| **Redis** | `REDIS_URL` shared by cache, idempotency, rate limits, circuit breakers, and BullMQ; see [redis-topology.md](../deployment/runbooks/redis-topology.md). |

---

## Local development notes

### `schema_migrations` out of sync

If `pnpm db:migrate` fails with “relation already exists”, the DB was created before the custom migration runner tracked filenames. **Do not** repeat ad-hoc backfill in shared environments. For local Docker only:

1. Insert rows for migrations already applied (everything before `20260518000001_*`).
2. Re-run `pnpm db:migrate`.

Fresh clones with `pnpm compose:up && pnpm db:migrate` should not need backfill.

### Commands checklist

```bash
pnpm compose:up && pnpm compose:wait
pnpm db:migrate
pnpm docs:generate:multilang   # if docs:check fails
pnpm validate
pnpm test:coverage             # Stage 5 thresholds + full suite
pnpm ci:local                  # full PR gate
```

---

## Deferred / intentional

| ID | Item | Reason |
| -- | ---- | ------ |
| P2-shared-middlewares-rename | Rename `src/shared/middlewares/` → `middlewares/` | **Deferred** — ~55+ path references (code + docs); exceeds &lt;50-file codemod threshold; run as dedicated PR with `rg` + `git mv` |
| P2-shared-utils-reorg (full) | Group all `src/shared/utils/` by concern | **Done** (2026-05-20) — `http/`, `security/`, `validation/`, `infrastructure/`, `auth/`, `i18n/`, `identity/`, `idempotency/`, `text/`; deep imports; duplicate `middleware/` removed |
| P3-04 | Billing `userId` naming cleanup | Low value vs churn; full-names rule elsewhere (legacy billing-document tables removed — no longer applicable) |
| P3-20 | Enterprise SAML / DR / data residency doc section | Captured as gaps in main audit §11; no new doc section |
| P2-26 | Prometheus required in prod | **Done** — `METRICS_ENABLED` defaults true in production; see [observability runbook](../deployment/runbooks/observability.md) |
| Audit medium/low (2026-05-20) | CAPTCHA, PaymentProvider port, k6 expansion, system-table RLS, Redis prefix, queue dashboard read-only, `DATABASE_RLS_SCOPED_CONTEXTS` default, tenant HTTP tests, idempotency 409 regression | **Done in code** — see remediation PR |
| Audit #4 (Redis single instance) | Cache + idempotency + BullMQ on one node | **Accepted for now** (2026-05-20) — production uses one shared Redis instance; setup emits only `REDIS_URL`; [redis-topology.md](../deployment/runbooks/redis-topology.md) |
| P3-13 | Chaos/load as release checklist only | Advisory; documented in runbook |
| Audit #13 | MCP SDK in prod `dependencies` | **Done** — `optionalDependencies` + dynamic SDK load; `validate:mcp-optional-dependency`; Docker `--no-optional` by default |
| Audit #14 | Migration timestamp mix 2025/2026 | **Done** — monotonic lint + `pnpm db:migrate:next-prefix` + [migrations.md](../reference/data/migrations.md#migration-filename-ordering) |

---

## Audit document drift (update when closing remediation)

[production-audit-2026-05-18.md](./production-audit-2026-05-18.md) was written as review-only. Several **Top 20** items are now addressed in code but still read as open in that file:

| Audit # | Title | Remediation |
| ------- | ----- | ----------- |
| 1 | BullMQ Zod | P0-01 |
| 5 | Numeric policy IDs | P2-01 (`public_id`) |
| 13–15 | Permission cache invalidation | P0-02 |
| (security) | MFA/webhook plaintext | P0-03, P0-04 |
| (security) | Header/path organization mismatch | P0-07 |
| 3 | Tenant HTTP tests billing/upload | P1-10 (extended; not full route matrix) |
| 4 | Redis single instance (cache + BullMQ) | Accepted for now: one shared Redis instance across development and production |
| 9 | Circuit breakers audited (Stripe / Resend / S3) | SDK import CI guard (`external-sdk-coverage.global.test.ts`), ESLint allowlist, `CircuitBreakerOpenError`, mail/stripe-webhook custom backoff, Resend transient retry — [external-service-resilience.md](../reference/reliability/external-service-resilience.md) |

When remediation is complete, add a short **“Remediation (2026-05-18)”** section to the audit or mark items satisfied in Top 20 — do not rewrite historical narrative.

---

## Optional follow-ups (not blocking merge)

- `pnpm routes:catalog` — confirm route catalog includes `POST /api/v1/uploads/:publicId/confirm` (present in `docs/routes.txt`).
- Integration test: full magic-link + session cookie under `pnpm test:e2e` with Docker.
- Staging: post-deploy `GET /health` after Railway deploy (wired in `reusable-railway-deploy.yml`).
- Re-enable Prometheus when SLOs require it (P2-26).

---

*Status doc for remediation tracking. Re-run `pnpm test:coverage` and `pnpm ci:local` before merge if test or Vitest config changes.*
