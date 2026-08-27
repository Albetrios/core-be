# External service resilience

Outbound HTTP to Stripe, Resend, and S3 uses a **Redis-backed circuit breaker** ([`circuit-breaker.ts`](../../../src/infrastructure/resilience/circuit-breaker.ts)) shared across API replicas. State changes are logged and reported to Sentry via `captureMessage`.

Notify **outbound webhooks** (customer URLs) use a separate **in-memory** [opossum](https://github.com/nodeshift/opossum) circuit per destination webhook in [`webhook-outbound-circuit.ts`](../../../src/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-outbound-circuit.ts) — not cluster-wide. Breakers are cached in a bounded LRU+TTL map keyed by internal webhook id (cap 5,000, idle TTL 1h), so URL churn and multi-tenant growth cannot leak breakers and a URL update reuses the same breaker rather than orphaning it.

---

## Coverage matrix

| Integration | Wrapped | Not wrapped (by design) |
| ----------- | ------- | ------------------------ |
| **Stripe** | All SDK calls in [`stripe.client.ts`](../../../src/infrastructure/payment/stripe.client.ts) except webhook HMAC | `constructStripeWebhookEvent` (local signature verify) |
| **Resend** | `sendEmail` in [`mail.service.ts`](../../../src/infrastructure/mail/mail.service.ts) | — |
| **S3** | `headObject`, `getObject`, `putObject`, `deleteObject` in [`s3-adapter.ts`](../../../src/infrastructure/storage/s3-adapter.ts) and [`storage.service.ts`](../../../src/infrastructure/storage/storage.service.ts) | `createPresignedUploadUrl` (local signing only) |
| **Notify webhooks** | `fetchWebhookWithCircuitBreaker` (opossum, per process) | — |

OAuth provider `fetch` calls (Google/GitHub) are **not** circuit-wrapped today.

---

## External calls and database transactions

With `DATABASE_RLS_SCOPED_CONTEXTS=true` (default), HTTP handlers do **not** pin a Postgres checkout for the full request. Still avoid awaiting Stripe / S3 / Resend inside `withPrincipalDatabaseContext` / `withTransaction` callbacks — network latency should not run while a DB transaction is open.

**CI guard:** `pnpm test:global` runs [`rls-context-network-isolation.global.test.ts`](../../../src/tests/global/rls-context-network-isolation.global.test.ts) — fails when outbound network calls appear inside database context callbacks under `src/domains/`.

**Pattern:** resolve provider state first (or after DB writes), then call external APIs outside the scoped DB wrapper. Subscription create already calls `paymentProvider.createSubscription` before `repository.create`.

---

## How to verify (audit #9)

- **CI guard:** `pnpm test:global` runs [`external-sdk-coverage.global.test.ts`](../../../src/tests/global/external-sdk-coverage.global.test.ts) — fails if `stripe`, `resend`, or `@aws-sdk/client-s3` are imported outside the four infrastructure wrapper modules (type-only `stripe` imports elsewhere are allowed).
- **Editor guard:** ESLint `no-restricted-imports` mirrors the same allowlist under `src/` (excluding tests and scripts).
- **Contract / chaos:** `pnpm test:contract` resets breaker state between specs; `pnpm test:chaos` includes Redis-partition circuit behavior.

---

## Thresholds (Redis-backed breakers)

| Circuit | `failureThreshold` | `resetTimeoutMs` |
| ------- | ------------------ | ---------------- |
| `stripe` | 5 | 30_000 |
| `s3` | 3 | 15_000 |
| `resend` | 5 | 60_000 |

When Redis is unavailable, breakers fall back to in-memory state per process.

---

## Mail worker and Resend

- BullMQ mail jobs: **8 attempts** with **custom backoff** ([`mail.queue.ts`](../../../src/infrastructure/mail/queues/mail.queue.ts), [`mail-backoff.util.ts`](../../../src/infrastructure/mail/queues/mail-backoff.util.ts)): exponential from 5s for transport errors; **`CircuitBreakerOpenError.retryAfterMs`** (~remaining Resend circuit reset, up to 60s) when the cluster-wide Resend circuit is OPEN.
- `sendEmail` wraps the Resend HTTP call in `resendCircuit.execute()` plus bounded transient retries ([`retry-with-backoff.util.ts`](../../../src/infrastructure/resilience/retry-with-backoff.util.ts)); throws `CircuitBreakerOpenError` when the circuit is OPEN.
- On send failure before the final attempt, the outbox row is released to `pending` ([`releaseMailOutboxClaim`](../../../src/infrastructure/mail/mail-outbox.repository.ts)). The final attempt marks `failed` only for **non** circuit-open errors; circuit-open on the last attempt still releases the claim (job may retry via BullMQ backoff without marking the outbox failed).
- After exhausted retries, jobs may land on the `mail-dlq` queue (see [dlq-runbook.md](../../process/dlq-runbook.md)).

## Stripe webhook worker

- Queue uses custom backoff ([`stripe-webhook-backoff.util.ts`](../../../src/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook-backoff.util.ts)): exponential from 10s for API errors; `CircuitBreakerOpenError.retryAfterMs` when the Stripe circuit is OPEN (30s reset).

---

## Stripe webhook ingress

HTTP signature verification runs in [`stripe-webhook-ingress.plugin.ts`](../../../src/domains/billing/sub-domains/stripe-webhook/stripe-webhook-ingress.plugin.ts) before the controller — not in the service layer. The async worker re-fetches events via the Stripe API (`STRIPE_SECRET_KEY`), not webhook HMAC.

---

## Related

- [billing-database-schema.md](../data/billing-database-schema.md) — billing PK / FK / RLS
- [redis-topology.md](../../deployment/runbooks/redis-topology.md)
- [resource-limits.md](../../deployment/runbooks/resource-limits.md)
- [`src/infrastructure/resilience/resilience.overview.md`](../../../src/infrastructure/resilience/resilience.overview.md) — circuit breaker module overview, design decisions, tuning parameters
- [`src/infrastructure/payment/payment.overview.md`](../../../src/infrastructure/payment/payment.overview.md) — Stripe client wrapper invariants
- [`src/POLICIES.md`](../../../src/POLICIES.md) — circuit breaker thresholds and reset timeouts
