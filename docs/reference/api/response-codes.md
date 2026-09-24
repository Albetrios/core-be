# Response-code policy (core-be)

When to set which HTTP status — the single contract every route, test, and doc follows. The policy is **enforced in code**, not by convention: the success side by `src/shared/middlewares/core/method-status-policy.middleware.ts` plus the route-status gates, the documented error side by `tooling/openapi/emitters/responses-builder.ts`.

---

## Success statuses — by method, never per-handler

| Method      | Status  | Meaning                                                                                                                                              |
| ----------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET         | **200** | Resource(s) returned.                                                                                                                                |
| POST        | **200** | Success — including creates, idempotent replays, and upserts (where a fixed 201 would lie on the replay). The central `onSend` hook rewrites any 201/202/204 a POST handler produced to 200 — controllers never hand-pick. |
| PUT / PATCH | **200** | Updated resource returned.                                                                                                                           |
| DELETE      | **204** | Deleted/revoked; no body.                                                                                                                            |

**Exceptions (protocol-owned, stay 200):** `POST /api/v1/billing/webhook` (Stripe expects a 200 acknowledgement) and `POST /api/v1/mcp` (the MCP streamable-HTTP transport owns its codes). The exemption list is `METHOD_STATUS_POLICY_EXEMPT_PREFIXES` in the middleware.

**PUT vs PATCH, and action verbs:** PUT replaces a resource in full; PATCH merges a partial update (both → 200). A collection-level action that has no target id is a `POST /collection/verb` (e.g. `POST /tenancy/organization/transfer-ownership`); a single-resource state change is a `PATCH /resource/:id/state` (or a dedicated action sub-path). Don't model a named action as a bare PUT/PATCH on the parent resource when it has its own verb.

**Where the truth lives and how it is enforced:**

1. Declared: `tooling/openapi/route-catalog/route-success-statuses.json` — one entry per route; `pnpm validate:route-success-statuses` keeps it in sync with `docs/routes.txt`.
2. Enforced at runtime: the method-status middleware (above).
3. Observed: `pnpm validate:route-success-coverage` after a full `pnpm test` fails CI on declared-vs-observed drift.
4. Documented: the OpenAPI responses builder reads the registry — the spec can never disagree with the declared status.

**Adding a route:** pick the status from the method table (don't invent), run `pnpm routes:catalog`, add the registry entry, write the happy-path test asserting that status.

## Error statuses — when each one applies

| Status  | Use when                                                                                                                                                                                                                                                                                                                                                                                              | Emitted by                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **400** | Request shape is invalid — body field, path param, or query param fails Zod validation (response carries per-field `details: [{ field, message }]`), malformed JSON hits the parser, or a webhook signature fails. Documented on every POST/PATCH/PUT and on any route with path or query params; **omitted entirely** only on param-less, query-less GET/DELETE (nothing to validate).               | Validators / Zod type provider / Fastify parser  |
| **401** | `Authorization` header missing, malformed, or carries an expired/revoked access token. Message tells the developer how to recover (login → `Authorization: Bearer <ACCESS_TOKEN>`).                                                                                                                                                                                                                   | Auth middleware                                  |
| **403** | Authenticated but not allowed: missing organization permission, role too low, suspended membership.                                                                                                                                                                                                                                                                                                   | Permission guards                                |
| **404** | Resource id (or route) does not exist — including ids of the right shape but no row, and ids that belong to another organization (no existence leak).                                                                                                                                                                                                                                                 | Services / repositories                          |
| **406** | MCP route only — `Accept` header missing or names an unsupported media type.                                                                                                                                                                                                                                                                                                                          | MCP transport                                    |
| **409** | Mutating routes — state conflict: duplicate resource (slug/email already taken), invalid state transition, or an in-flight duplicate request with the same `X-Idempotency-Key`.                                                                                                                                                                                                                       | Services + idempotency middleware                |
| **413** | POST/PATCH/PUT — request body exceeds the size limit.                                                                                                                                                                                                                                                                                                                                                 | Fastify body limit                               |
| **415** | POST/PATCH/PUT — `Content-Type` is not `application/json` (where a JSON body is expected).                                                                                                                                                                                                                                                                                                            | Fastify content-type parser                      |
| **422** | Mutating routes — request is well-formed but violates a business rule (including a capability unavailable for an **immutable resource type** — e.g. a personal organization cannot gain members, roles, ownership transfer, or deletion), or an `X-Idempotency-Key` is reused with a **different payload** (fingerprint mismatch).                                                                    | Services + idempotency middleware                |
| **429** | Any route — global or per-route rate limit exhausted. Response carries `Retry-After` and `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`.                                                                                                                                                                                                                                         | Rate-limit middleware                            |
| **503** | A required dependency is unavailable and the request **fails closed** rather than risk an unsafe write: the Redis idempotency store is down on a required-idempotency write (`code: service_unavailable`), or the payment provider (Stripe) is unreachable on a subscription/payment mutation (`code: service_unavailable`, `errors:paymentProviderUnavailable`). Retry once the dependency recovers. | Idempotency middleware · Stripe payment provider |
| **500** | Unexpected failure. Never intentional: the never-5xx fuzz gate (`src/tests/security/`) fails CI if any route 5xxes on malformed input. External message is generic; details go to Sentry.                                                                                                                                                                                                             | Error handler                                    |

**Decision guide for a new failure path:** is the request unreadable → 400/413/415; unauthenticated → 401; authenticated but not allowed → 403; thing doesn't exist → 404; valid request colliding with current state → 409; valid request breaking a business rule → 422; too fast → 429. If none fit, you are probably about to invent a status — don't; map it to the closest above.

**400 vs 422:** 400 = the request itself is malformed (shape). 422 = the request parses fine but the system rejects its meaning (semantics). **409 vs 422:** 409 = conflict with existing state (try again may succeed after state changes). 422 = the payload's logic is wrong, or the target resource **type** makes the capability permanently unavailable — retrying an identical payload always fails (e.g. a personal organization can never have members/roles/ownership-transfer/deletion because the organization `type` is immutable; the centralized guard is `assertTeamOrganization(...)`).

## Error body shape

All error statuses share one envelope (`src/shared/middlewares/core/error-handler.middleware.ts`):

```json
{
  "error": {
    "type": "validation_error",
    "code": "validation_error",
    "detail": "Invalid request body",
    "errors": [{ "field": "email", "message": "Invalid email format" }]
  },
  "meta": { "request_id": "018f2c7a-3b4d-4e5f-9a6b-7c8d9e0f1a2b" }
}
```

Fields: `type` is `request_error` or `validation_error` (always present); `code` is the status-class slug (e.g. `validation_error`, `conflict`, `not_found`); `detail` is the human, i18n-resolved message (per `Accept-Language`); `errors` (the per-field array) appears on validation (400) only; `documentation_url` is added when `API_DOCS_BASE_URL` is configured. `request_id` (under `meta`) is the server-minted UUID (also echoed as `X-Request-Id`) — quote it in support tickets. Every error path — including the idempotency-middleware 409/422/429/503 responses — emits this same `{ error, meta }` envelope.

**`error.reason` (optional, machine-readable):** select 4xx errors carry a stable snake_case `reason` sub-code so the frontend can branch on the specific cause without parsing the human `detail`. It is **additive** (present only where set) and is **omitted on 5xx** (masked alongside the detail). `code` stays the status-class slug (e.g. `conflict`); `reason` is the specific cause. Current slugs: `membership_already_exists`, `seat_limit_reached`, `organization_slug_exists`, `invitation_revoked`, `invitation_already_accepted`, `invitation_expired`, `disposable_email` — extend as new FE-relevant cases arise by calling `AppError.withReason('<slug>')` at the throw site.

## Related

- Header matrix and id conventions: `agent-os/skills/be-api-contract-guard/SKILL.md`
- Versioning: [api-versioning.md](api-versioning.md)
- Spec/Postman generation: [api-documentation.md](api-documentation.md)
