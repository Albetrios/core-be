# Pre-production review — 2026-05-15

> **Current deferrals (not duplicated here):** see [observability.md](../deployment/runbooks/observability.md). This file is a **dated snapshot**; add a new file under `docs/reviews/` for later reviews.
> **Update (2026-05-15):** Prometheus/Grafana integration was **temporarily removed** (`prom-client`, `/metrics`, worker metrics port, `METRICS_*` env vars, deploy secrets). **Still in place:** Sentry, Pino logs, health probes, idempotency cache cardinality sampling (bounded Redis SCAN + log / Sentry thresholds via worker), and all security items below (MCP auth, idempotency scoping, RLS, tests).

## Summary

Baseline quality gates pass locally (`pnpm audit`, `pnpm validate`, `pnpm validate:domain`). Integration tests require a reachable Postgres/Redis (`docker compose up -d` + `DATABASE_URL` in `.env`). **Blockers addressed in this change set:** MCP authentication, scoped idempotency keys, RLS on `notify.notifications`, Prometheus `/metrics` with bearer auth, local `docker-compose.yml`, and deploy workflow env wiring for Sentry/metrics.

## Satisfied

- **Zero dependency vulnerabilities** — `pnpm audit` clean; overrides in `package.json`
- **CI quality pipeline** — lint, typecheck, domain validation, Gitleaks, Semgrep (`.github/workflows/ci.yml`)
- **Security middleware** — Helmet, CORS (prod allowlist), JWT (RS256 in production), rate limits, idempotency (`src/shared/middlewares/`)
- **RLS** — Multi-tenant tables in `migrations/20260215000002_enable_rls.sql` + `notify.notifications` in `migrations/20260515000001_notifications_rls.sql`
- **Observability** — Sentry (errors/traces/profiling), Pino structured logs, health probe (`/health`)
- ~~**Prometheus metrics**~~ — removed temporarily (was `GET /metrics` + BullMQ counters)
- **Circuit breakers** — Stripe, S3, Resend (`src/infrastructure/resilience/circuit-breaker.ts`)
- **Worker hardening** — RSS monitoring, stalled job config, graceful shutdown

## Gaps addressed (P0)

| Item                         | Area          | Resolution                                                                                                                                                                                          |
| ---------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthenticated MCP          | Security      | JWT + `super_admin`/`admin` on `/api/v1/mcp` and `/mcp`                                                                                                                                             |
| Global idempotency keys      | Security      | Keys scoped: `idempotency:{organization}:{user}:{key}`                                                                                                                                                       |
| Missing RLS on notifications | Database      | Migration `20260515000001_notifications_rls.sql`                                                                                                                                                    |
| No Prometheus/Grafana path   | Observability | Prometheus **removed temporarily**; **idempotency cardinality** covered by repeatable job `idempotency-cardinality` + `IDEMPOTENCY_CARDINALITY_*` env thresholds — re-enable Prometheus when needed |
| Missing docker-compose       | DX            | `docker-compose.yml` (Postgres 16 + Redis 7)                                                                                                                                                        |
| Deploy env gaps              | CI/CD         | `SENTRY_*`, `METRICS_*` in [reusable-railway-deploy.yml](../../.github/workflows/reusable-railway-deploy.yml)                                                                                                                            |

## High (P1) — addressed in follow-up (2026-05-15)

- **Cross-tenant integration tests** — `src/tests/security/tenant-isolation.test.ts`
- **Rate-limit assertions** — `src/tests/security/rate-limiting.test.ts` asserts `429` on auth login abuse
- **Connection pool + RLS GUC** — `tenant-context.ts` (`withOrganizationContext` + SET LOCAL); `tenant-rls-concurrency.test.ts`
- **Container scanning** — Trivy scan on `core-be:ci` in CI `docker-build` job
- **Auth tests from route catalog** — `route-catalog-auth.ts` + catalog-driven `auth-enforcement.test.ts`
- **Dedicated security CI job** — `security-tests` runs `pnpm test:security`

## Optional improvements (addressed)

- **Grafana Loki** — Documented in [observability.md](../deployment/runbooks/observability.md) (Railway stdout → Grafana Cloud Loki)
- **OpenTelemetry** — Deferred; Sentry covers errors/traces/profiling (noted in observability doc)
- **Route catalog automation** — `pnpm routes:catalog` / `pnpm routes:catalog:check` in CI quality job

## Dependency table

| Package               | Status                   | Action                            |
| --------------------- | ------------------------ | --------------------------------- |
| All direct/transitive | No known vulnerabilities | `pnpm audit` pass                 |
| `prom-client`         | Added ^15.1.3            | New direct dependency for metrics |

## Monitoring

| Signal  | Tool                                                   |
| ------- | ------------------------------------------------------ |
| Metrics | Prometheus (Grafana Cloud scrape) + Grafana dashboards |
| Errors  | Sentry                                                 |
| Logs    | Pino → stdout (Railway log drain)                      |

See [observability.md](../deployment/runbooks/observability.md).

## Baseline gate results (2026-05-15)

| Command                          | Result                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Pass                                                                                                 |
| `pnpm deps:audit`                | Pass (no vulnerabilities)                                                                            |
| `pnpm validate`                  | Pass                                                                                                 |
| `pnpm validate:domain`           | Pass                                                                                                 |
| `pnpm test:coverage`             | **Blocked** — local `DATABASE_URL` auth failure (Neon credentials); use `docker compose` + local URL |
| `pnpm test:security`             | Run after DB available                                                                               |
| `pnpm test:performance`          | Run after DB available                                                                               |

## Implementation backlog (completed)

1. Idempotency scoping + unit tests
2. MCP admin auth + security tests
3. Notifications RLS migration
4. Prometheus metrics (API + worker port)
5. `docker-compose.yml`
6. Deploy + `.env.example` sync
7. Grafana dashboard + documentation
