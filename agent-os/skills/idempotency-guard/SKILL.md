---
name: idempotency-guard
description: Keeps core-be request idempotency correct — the 13 idempotencyRequired writes (X-Idempotency-Key → 422 when missing/reused, 409 in-flight), the post-commit Redis replay write (never in onSend), secret-bearing response bodies excluded from caching, and the client X-Idempotency-Key forwarded as Stripe's idempotencyKey on customer/subscription mutations. Use when adding or changing a mutating money/state route, the idempotency middleware or utils, the Stripe client, or the subscription controller/service.
trigger: src/shared/middlewares/core/idempotency.middleware.ts, src/infrastructure/payment/stripe.client.ts
triggerNote: Idempotency engine + idempotencyRequired writes + Stripe mutations
indexNote: X-Idempotency-Key writes, post-commit Redis replay, Stripe idempotencyKey
---

# Idempotency guard

Exactly **13 writes** in core-be are idempotency-required; getting the replay, fingerprint, and Stripe-forwarding right is what makes a retried subscription-create safe end-to-end (no duplicate charge). This guard codifies the rules; contract tests (`src/tests/contract/stripe.contract.test.ts`) and unit tests (`src/tests/unit/utils/idempotency/**`) catch regressions.

## Mechanism

- Engine: `src/shared/middlewares/core/idempotency.middleware.ts` + `src/shared/utils/idempotency/**`. Applies to `POST/PUT/PATCH/DELETE`.
- **Required-key gate** (`onRequest`): routes with `config.idempotencyRequired === true` throw `UnprocessableEntityError('errors:idempotencyKeyRequired')` → **422** when the `X-Idempotency-Key` header is missing, `errors:idempotencyKeyInvalid` → **422** when malformed. Key format: 16–255 chars, `/^[A-Za-z0-9._:~+/=-]+$/`.
- **Claim/replay** (route `preHandler`, after auth so anonymous callers never occupy keys): scope = active `org` JWT claim + actor (`userId` or `apiKeyPublicId`); **unauthenticated callers get no caching**. Redis key: `idempotency:<organization|none>:<actor>:<key>`. Request fingerprint = SHA-256(method + normalized route + canonical body). On a hit: fingerprint mismatch → **422** (`idempotency_key_reuse`); `completed` → replay stored response with header `x-idempotency-replay: true`; `in_flight` → **409**. Over the per-actor cap → **429** + `Retry-After`. Redis error on claim → **fail closed 503** + `Retry-After`.
- **Completed entry is written only after the DB transaction commits** — dispatched from `src/shared/middlewares/core/request-lifecycle.middleware.ts` (post-commit), never directly in `onSend`. Rollback/settle-failure → `DEL` the placeholder so the client can safely retry. TTL: placeholder = session TTL; completed = 24 h.
- **Never cache secrets:** `onSend` skips bodies > 100 KB or containing secret fields (`responseBodyContainsSecretFields`); token/secret-issuance routes are in `IDEMPOTENCY_EXCLUDED_ROUTE_PATTERNS` (`idempotency-fingerprint.util.ts`).

## The 13 idempotencyRequired routes

Source of truth = the `config: { idempotencyRequired: true }` flag on each route registration (typed in `src/fastify.d.ts`); there is **no central array** — the live list is the `I` (`req`) column in `docs/routes.txt`. The set:

| # | Route | File |
| - | ----- | ---- |
| 1 | `POST /tenancy/organizations` | `tenancy/sub-domains/organization/organization.routes.ts` |
| 2 | `POST /tenancy/organization/memberships` | `tenancy/sub-domains/membership/membership.routes.ts` |
| 3 | `POST /tenancy/organization/transfer-ownership` | `…/membership/membership.routes.ts` |
| 4 | `POST /billing/subscriptions` | `billing/sub-domains/subscription/subscription.routes.ts` |
| 5 | `POST /billing/subscriptions/:subscription_id/change-plan` | `…/subscription/subscription.routes.ts` |
| 6 | `POST /billing/subscriptions/:subscription_id/cancel` | `…/subscription/subscription.routes.ts` |
| 7 | `POST /billing/subscriptions/:subscription_id/resume` | `…/subscription/subscription.routes.ts` |
| 8 | `POST /billing/payment-methods/setup` | `…/subscription/subscription.routes.ts` |
| 9 | `POST /notify/webhooks` | `notify/sub-domains/webhook/webhook.routes.ts` |
| 10 | `POST /tenancy/organization/api-keys` | `tenancy/sub-domains/organization/organization.routes.ts` |
| 11 | `POST /tenancy/organization/notification-policies` | `tenancy/sub-domains/organization/organization.routes.ts` |
| 12 | `POST /tenancy/organization/roles` | `tenancy/sub-domains/member-roles/member-role.routes.ts` |
| 13 | `POST /uploads` | `upload/upload.routes.ts` |

Routes 9–13 are the resource-creation writes added in the audit remediation (EX-06). Step-up-gated
`/auth/me/*` routes are intentionally **not** in this set — the global `onRequest` required-key gate
runs before route auth, so mandatory idempotency there would return 422 before the 401/403 those
routes assert, and their handlers dedupe server-side. The count of 13 is mirrored in
`docs/reference/api/frontend-auth-guide.md`.

## When this guard triggers

`src/shared/middlewares/core/idempotency.middleware.ts` · `request-lifecycle.middleware.ts` · `src/shared/utils/idempotency/**` · `src/fastify.d.ts` · `src/domains/**/*.routes.ts` (declaring `idempotencyRequired`) · `src/infrastructure/payment/stripe.client.ts` · `billing/sub-domains/subscription/{subscription.controller,subscription.service}.ts` · `src/infrastructure/observability/idempotency-cardinality/**`.

## Enforcement checklist

- [ ] A **new externally-mutating write** (creates/charges/transfers state) gets `config: { idempotencyRequired: true }` — **merge it into the existing `config` object**, don't spread a rate-limit preset at top level or it drops the flag (see the inline warnings in `membership.routes.ts` / `organization.routes.ts`).
- [ ] Bump the "13 routes" count in `docs/reference/api/frontend-auth-guide.md` (and any idempotency doc) when the set changes.
- [ ] Document the `X-Idempotency-Key` header in the route schema (keeps OpenAPI accurate); 409/422 are already in `docs/reference/api/response-codes.md`.
- [ ] **Stripe:** new mutation helpers in `stripe.client.ts` accept and forward `options.idempotencyKey` as Stripe's native `RequestOptions.idempotencyKey`; the controller reads the request header via `readIdempotencyKey` and threads it controller → service → client. Add a contract test asserting `matchHeader('idempotency-key', …)`.
- [ ] **New secret response fields** → add to `IDEMPOTENCY_SECRET_RESPONSE_FIELD_NAMES` / `RESPONSE_BODY_SECRET_FRAGMENTS`; new token-issuance routes → `IDEMPOTENCY_EXCLUDED_ROUTE_PATTERNS`.
- [ ] Keep cache keys scoped per actor + active organization (no anonymous caching); keep the per-actor rate key aligned with the cache-key actor segment.
- [ ] New key prefixes stay under `idempotency:*` so the cardinality sampler (`scheduler.ts` → `createIdempotencyCardinalityWorker`) counts them.

## Top failure modes

1. **Rolled-back txn replaying as 2xx** — prevented by the post-commit write in `request-lifecycle.middleware.ts`; never write the completed entry from `onSend`.
2. **Same key, different payload** → fingerprint mismatch 422 (canonical body serialization closes JSON key-order / undefined-drop collisions).
3. **Secret leakage via cached body** — `responseBodyContainsSecretFields` + excluded routes; name new single-use fields (`recovery_codes`, `download_url`, …).
4. **Spreading a rate-limit preset over the route `config`** silently drops `idempotencyRequired`.
5. **Redis outage** — required writes fail **closed** (503 + Retry-After); the cap/EVAL paths fail **open** so a soft limit never becomes a 5xx spike.

## Verify

```bash
pnpm test:contract                          # Stripe idempotency-key forwarding
pnpm test:unit                              # src/tests/unit/utils/idempotency/**
pnpm routes:catalog && pnpm docs:check      # route + OpenAPI sync
```

Related: [[api-contract-guard]] (headers + status policy), [[workers-events]] (Stripe webhook flow).
