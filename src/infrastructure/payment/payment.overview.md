`src/infrastructure/payment/`

# Payment infrastructure

## Purpose

Stripe SDK client wrapper. Owns the singleton Stripe instance, the convenience helpers for customer / subscription / portal session creation, the inbound webhook signature verification, and the `opossum` circuit breaker that protects this process from a degraded Stripe upstream.

The billing **domain** ([src/domains/billing/](src/domains/billing/)) consumes this module and owns the business logic; this module owns the network primitive.

## Design decisions

- **Stripe SDK 17.x** — the latest stable major. Pinned major to avoid silent breaking changes from minor SDK updates.
- **Circuit breaker via `opossum`**: a Stripe outage shouldn't take this process down. The breaker opens after a threshold of consecutive failures and short-circuits subsequent calls with a known error class, which the controller layer translates to 502.
- **Network I/O outside RLS contexts**: callers must not invoke Stripe inside `withPrincipalDatabaseContext`. Enforced by `pnpm test:global` (`rls-context-network-isolation.global.test.ts`) and called out as an invariant in [src/domains/billing/sub-domains/subscription/subscription.overview.md](src/domains/billing/sub-domains/subscription/subscription.overview.md).
- **Webhook signature verification is byte-precise**: the route handler in [src/domains/billing/sub-domains/stripe-webhook/](src/domains/billing/sub-domains/stripe-webhook/) disables JSON parsing on the body so the SDK can verify against the raw bytes.
- **Idempotency key forwarding**: when the API receives an `X-Idempotency-Key`, this module forwards the same key to Stripe as Stripe's native `Idempotency-Key` header. Stripe's idempotency window is 24 h, which informs the platform's `IDEMPOTENCY_RESPONSE_CACHE_TTL_SECONDS = 86 400`.
- **Sentry instrumentation**: every Stripe call is wrapped to record the operation, latency, and error class. PII redaction strips customer email and metadata before sending to Sentry.

## Operational concerns

- **Stripe API version pinning**: pin via the `apiVersion` SDK option so SDK upgrades don't change response shape.
- **Webhook secret rotation**: dual-secret support (when `STRIPE_WEBHOOK_SECRET_NEXT` is configured) lets us rotate without downtime.
- **Stripe rate limits**: 100 read or 100 write requests per second; exceeding them returns 429 which the breaker treats as a failure.

## External dependencies

- **Stripe** API (`STRIPE_SECRET_KEY`).

## Tuning parameters

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET_NEXT` (rotation), `STRIPE_API_TIMEOUT_MS`.
- Circuit breaker thresholds: `STRIPE_CIRCUIT_BREAKER_*` env (when configured).

## Failure modes

- **Stripe API outage** → circuit opens; controllers receive a 502-equivalent error class. Webhook still processes when Stripe recovers and re-delivers.
- **Stripe rate-limit (429)** → counted as a failure for the breaker; client sees 502 with retry-after.
- **Invalid webhook signature** → 400; Stripe retries.
- **Webhook secret rotation midstream** → both `STRIPE_WEBHOOK_SECRET` and `STRIPE_WEBHOOK_SECRET_NEXT` are tried in sequence.
