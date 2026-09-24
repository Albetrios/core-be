---
name: be-production-hardening-guard
description: Enforces production-readiness checks across the codebase — security headers, JWT/CORS/rate limits, DB pool and SSL, Redis, external-service circuit breakers, logging redaction, worker resource limits, and CI/CD scanning. Use before deploying to production or after changing middleware, infrastructure, or security-related code.
indexNote: production-readiness across middleware / infra / security config
---

# Production hardening guard (core-be)

## Purpose

Enforce production-readiness checks across the codebase. Verifies security headers, error handling, logging redaction, connection management, and other hardening measures are in place.

## When to Use

- Before deploying to production
- After modifying middleware, infrastructure, or security-related code
- Triggered automatically by `be-production-hardening.mdc` rule
- During code review of infrastructure changes

## Checklist

### Security

- [ ] JWT uses RS256 (or HS256 with 32+ char secret)
- [ ] Access tokens expire in 15 minutes
- [ ] Account lockout after 10 failed attempts (30 min)
- [ ] Helmet middleware configured with strict CSP
- [ ] CORS restricted to `ALLOWED_ORIGINS` (mandatory in production)
- [ ] Rate limiting on all sensitive endpoints (login, email verification-code, password reset)
- [ ] X-Idempotency-Key support for write operations

### Database

- [ ] Connection pool configured (max, idle_timeout, connect_timeout, max_lifetime)
- [ ] `DEPLOYMENT_TOTAL_REPLICA_COUNT` set in production; `assertPostgresConnectionBudget()` passes at startup
- [ ] SSL enabled in production (`rejectUnauthorized: true`)
- [ ] Transaction timeout via `withTransaction()` (default 10s)
- [ ] No raw SQL in domain code (use Drizzle query builder)

### Redis

- [ ] Retry strategy with exponential backoff (capped at 5s)
- [ ] Key prefix (`core:`) to namespace entries
- [ ] Production: `REDIS_URL` points at the shared managed Redis instance; `REDIS_BULLMQ_URL` is unset or the same endpoint while using the current single-instance topology — see `docs/deployment/runbooks/redis-topology.md`
- [ ] Close timeout (5s) for graceful shutdown
- [ ] Error logging on connection failures

### External Services

- [ ] Circuit breakers for Stripe, S3, Resend — see `docs/reference/reliability/external-service-resilience.md`
- [ ] Sentry `captureMessage` on circuit OPEN / HALF_OPEN / recovery
- [ ] Stripe webhook ingress plugin verifies signatures before controllers
- [ ] S3 error logging on HeadObject failures
- [ ] Webhook delivery with retry logic

### Logging

- [ ] Pino logger with `redact` for sensitive fields
- [ ] Structured logging (JSON in production)
- [ ] Sentry integration for error capturing and tracing

### Worker Process

- [ ] RSS monitoring (warn at 512 MB)
- [ ] Graceful shutdown with worker close handlers
- [ ] BullMQ stalled job configuration: `lockDuration`, `stalledInterval`, `maxStalledCount` in `src/infrastructure/queue/worker-runtime/worker-options.ts`; all workers use shared options and log on `stalled` event

### Resource Limits

- [ ] Container memory limit set on platform (Railway service / Kubernetes `limits.memory`)
- [ ] `NODE_OPTIONS=--max-old-space-size=<~75 percent of memory limit>` set per service
- [ ] Worker RSS warning threshold aligned with memory limit
- [ ] CPU `requests` set; CPU `limits` avoided (Node single-threaded throttling)

### CI/CD

- [ ] `pnpm audit` hard-fail (no audit-level; any vulnerability fails CI)
- [ ] Gitleaks secret scanning
- [ ] Semgrep SAST scanning
- [ ] Docker HEALTHCHECK in Dockerfile
- [ ] `.env` file guard in PR checks

## How to Run

1. Read this skill file.
2. Go through each checklist item.
3. For each unchecked item, verify the relevant file exists and contains the expected configuration.
4. Report any gaps found.
