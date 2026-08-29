# HTTP idempotency

core-be deduplicates mutating HTTP requests when clients send an **`X-Idempotency-Key`** header.

---

## Behavior

| Aspect | Detail |
| ------ | ------ |
| **Methods** | `POST`, `PUT`, `PATCH`, `DELETE` |
| **Header** | `X-Idempotency-Key` — 16–255 chars, `[A-Za-z0-9._:~+/=-]` (see `parseIdempotencyKeyHeader`) |
| **Scope** | Redis key includes organization and user when present: `idempotency:{organization}:{user}:{key}` |
| **TTL** | 24 hours for completed responses; 60s placeholder while in flight |
| **Redis down** | **503** `service_unavailable` (fail closed) |
| **Duplicate while in flight** | **409** `conflict_in_flight` (translation key `errors:idempotencyKeyInFlight`) |
| **Lost SETNX race after miss** | **409** `conflict` (translation key `errors:idempotencyKeyConflict`); replay if the winner has already completed |
| **Duplicate after completion** | Cached response replayed with `x-idempotency-replay: true` |
| **Commit safety** | Completed cache is written in the `onResponse` Fastify hook **only** when `statusCode < 400`, so a rolled-back request never leaves a successful replay entry behind |

Implementation: [`src/shared/middlewares/core/idempotency.middleware.ts`](../../../src/shared/middlewares/core/idempotency.middleware.ts).

### Redis entry shape (state machine)

Two discriminated states are stored under each cache key:

```json
{ "state": "in_flight", "claimedAt": 1700000000000, "requestId": "abcd" }
```

```json
{ "state": "completed", "statusCode": 200, "body": "...", "headers": { "content-type": "application/json" } }
```

Legacy placeholders written before this state machine (no `state` field, or `state` other than `completed`) are treated as `in_flight` during rolling deploys. Clients seeing the `409 conflict_in_flight` response should wait and retry once the original request has completed.

---

## Required vs optional

The header is **required on 13 writes** — a missing or malformed key fails closed with **422**
(`idempotencyKeyRequired` / `idempotencyKeyInvalid`). It is **optional but strongly recommended** on
every other write, where duplicate side effects are costly.

The required set's source of truth is the `config: { idempotencyRequired: true }` flag on each route;
the generated route catalog (`docs/routes.txt`) lists it under **IDEMPOTENCY-REQUIRED WRITES (13)**, and
each route's OpenAPI parameter advertises the header as required. For example, on
`POST /api/v1/billing/subscriptions` the key is forwarded to Stripe `subscriptions.create` when Stripe is
configured.

---

## Operations

- Monitor Redis cardinality via the repeatable `idempotency-cardinality` worker ([observability runbook](../../deployment/runbooks/observability.md)).
- Ensure production Redis uses `maxmemory-policy noeviction` so idempotency keys are not evicted early ([production-go-live](../../deployment/runbooks/production-go-live.md)).

## Related

- [`src/PATTERNS.md`](../../../src/PATTERNS.md) § Idempotency — cross-cutting pattern overview (HTTP layer + Stripe webhook layer)
- [`src/POLICIES.md`](../../../src/POLICIES.md) — `IDEMPOTENCY_*` constants (TTL, in-flight grace window, max key length)
- [`src/shared/middlewares/core/idempotency.middleware.ts`](../../../src/shared/middlewares/core/idempotency.middleware.ts) — middleware implementation
- [`src/shared/utils/idempotency/`](../../../src/shared/utils/idempotency/) — key parser and policy helpers
