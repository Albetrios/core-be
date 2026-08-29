# Sentry alert rules (Sentry-only)

Operational alerts for **core-be** use **Sentry** issue and metric alerts only. There is no PagerDuty integration in this repository.

---

## Prerequisites

1. `SENTRY_DSN` configured on API and worker services ([observability runbook](../deployment/runbooks/observability.md)).
2. `RAILWAY_GIT_COMMIT_SHA` set on deploy so releases group regressions by commit ([reusable-railway-deploy.yml](../../.github/workflows/reusable-railway-deploy.yml)).
3. Production environment tag: `SENTRY_ENVIRONMENT=production` (or per-env names).

---

## Recommended alert rules

Create these in **Sentry → Alerts → Create Alert** (issue or metric alert). Tune thresholds after one week of baseline traffic.

| Alert | Type | Condition | Action |
| ----- | ---- | --------- | ------ |
| **API error spike** | Issues | Events ≥ 50 in 5m, filter `environment:production`, `level:error` | Email + Slack (Sentry integration) |
| **Worker final failure** | Issues | New issue, fingerprint contains `worker_final_failure` | Email + Slack |
| **Unhandled startup** | Issues | Message/tag `server_startup` or `worker_startup` | Email (page on-call manually if needed) |
| **DLQ growth signal** | Issues | `captureMessage` from DLQ depth worker at `warning` or `error` | Email |
| **Idempotency cardinality critical** | Issues | Message contains `idempotency cardinality` and level `error` | Email |
| **P95 transaction regression** | Metric | `transaction.duration` p95 > 2s for 10m, exclude `/livez` and `/readyz` | Email |
| **DB pool exhaustion** | Issues | Message `database.pool.exhaustion.high` or `database.pool.exhaustion.critical` | Email + Slack |

Pool exhaustion alerts are emitted by the API process when organization-scoped RLS checkouts or cluster `pg_stat_activity` counts exceed configured ratios for consecutive polls (`DB_POOL_*` env vars). This path is **independent** of `METRICS_ENABLED`.

---

## What we do not alert on in Sentry

- `/livez` and `/readyz` transactions (dropped in `beforeSendTransaction`).
- Expected `401` / `403` auth noise (review periodically; add inbound filters if noisy).
- Stripe webhook signature failures from scanners (use Sentry inbound filters on user-agent or path if needed).

---

## Runbook links

- [observability.md](../deployment/runbooks/observability.md) — metrics, logs, health endpoints
- [resource-limits.md](../deployment/runbooks/resource-limits.md) — memory and pool sizing
- [worker-scaling.md](../deployment/runbooks/worker-scaling.md) — queue depth and worker replicas

---

## Escalation

Sentry notifications go to the team channel configured in the Sentry project. For production incidents, follow your team’s manual escalation process (no automated PagerDuty wiring in this repo).
