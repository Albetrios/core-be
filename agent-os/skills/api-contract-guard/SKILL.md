---
name: api-contract-guard
description: Enforces the core-be public API contract conventions — snake_case route params, prefixed public ids, the uniform method→status policy, and the header naming matrix — across routes, validators, tests, OpenAPI/Postman docs, and the route-status gates. Use when adding or changing any route, param, header, public id, or response status.
trigger: src/shared/utils/http/list-query.util.ts
triggerNote: List endpoints (search/sort/pagination); also route params / public ids / statuses / headers. Status policy: docs/reference/api/response-codes.md
indexNote: route params / public-ids / method→status policy / header matrix — any route, param, or header change
---

# API contract guard

> **Compact wire literals are intentional (do not "fix" them):** the `org_` public-id
> prefix is a 3-letter id prefix by design, and the JWT claim keys `org` / `sv` follow
> the JWT compact-claim convention (`iss`/`sub`/`aud`) — they ride on every request, so
> brevity is a deliberate wire-size choice. The full-names-only rule applies to
> identifiers and prose, never to these wire keys. (Decided during PR #1123.)

## Route params — snake_case, semantic, entity-typed

- Every path param is snake_case and semantic: `{plan_id}`, `{subscription_id}`, `{session_id}`, `{upload_id}`, `{auth_method_id}`, … — never `{id}` or camelCase. The active organization is NOT a path param — it is carried by the signed `org` JWT claim; the active-organization resource is the singular `/tenancy/organization` (sub-resources like settings/memberships/roles/api-keys nest under it).
- Entity-id param names must exist in `PARAM_NAME_TO_ENTITY` (src/shared/utils/identity/public-id.util.ts) so validators, test materializers, and OpenAPI docs derive the entity automatically. The only non-entity params are `{provider}` (OAuth provider name) and `{slug}` (organization slug) — unregistered by design.
- Zod params-DTO object keys must equal the route param name exactly.

## Public ids — Paddle-style prefixed

- Format: `<prefix>_<21 chars of [a-z0-9]>` (e.g. `org_a1b2c3d4e5f6g7h8i9j0k`); prefixes live in `PUBLIC_ID_PREFIXES`.
- `generatePublicId(entity)` requires the entity; never hand-roll ids. Externally the field is always `id` — the words "public id/publicId" never appear in documentation.
- New tables: widen `public_id` to varchar(28), add the prefix to the map, the migration backfill, and the OpenAPI parameter docs come free via the map.

## Body field casing — snake_case request & response keys

- Every **request body** property (`*.dto.ts` `z.object` keys) and **response body** property (`*.serializer.ts` output keys) is `snake_case`: `file_name`, `content_type`, `created_at`, `avatar_key` — never `fileName`/`createdAt`. The one external identifier stays `id`.
- Validation-error `errors[].field` (and field-keyed `details`) values name the body property, so they are snake_case too (e.g. `field: 'content_type'`, not `'contentType'`).
- Internal TypeScript identifiers (local variables, private helper params, the storage-port/AWS-SDK layer) may stay camelCase — only the keys that cross the HTTP boundary are constrained.
- Exceptions, passed through verbatim: third-party / browser-native inbound payloads — Stripe webhooks, OAuth provider responses, WebAuthn W3C `navigator.credentials` JSON (`rawId`, `clientDataJSON`, …) — and JWT claims.
- Enforced by `src/tests/unit/api/snake-case-body-keys.policy.unit.test.ts` (scans every `*.dto.ts` / `*.serializer.ts`; allowlist for the documented exceptions). Renaming a body/response key is an API change → run the breaking-change gate (see sync checklist).

## Method → success status (enforced by middleware)

| GET | POST | PUT/PATCH | DELETE |
| --- | ---- | --------- | ------ |
| 200 | 200  | 200       | 204    |

Exceptions (protocol-owned, stay 200): `POST /billing/webhook`, `POST /api/v1/mcp`.
The policy is enforced centrally in `method-status-policy.middleware.ts`; declared statuses live in `tooling/openapi/route-catalog/route-success-statuses.json` and are runtime-verified by `pnpm validate:route-success-coverage` (drift fails CI).

## Error status — when to set which (full guide: docs/reference/api/response-codes.md)

- **400** request shape invalid (body/param/query fails Zod, malformed JSON, webhook signature) — per-field `details`; documented on every POST/PATCH/PUT; only a param-less, query-less GET/DELETE documents **no 400** at all.
- **401** missing/expired/revoked access token — message must tell the developer how to recover (login → `Authorization: Bearer <ACCESS_TOKEN>`).
- **403** authenticated but lacking permission/role. **404** id or route doesn't exist (incl. other-organization ids — no existence leak).
- **406** MCP only (Accept negotiation).
- **409** mutating only — state conflict: duplicate resource, bad state transition, in-flight duplicate X-Idempotency-Key.
- **413 / 415** POST/PATCH/PUT only — body too large / wrong Content-Type.
- **422** mutating only — business-rule rejection (incl. a capability unavailable for an **immutable resource type**, e.g. a personal organization that cannot gain members/roles/ownership-transfer/deletion/billing — enforced by the shared `assertTeamOrganization(...)` guard, **not** 409), or X-Idempotency-Key reused with a different payload.
- **429** every route — with `Retry-After` + `X-RateLimit-*` headers.
- **500** never intentional — the never-5xx fuzz gate fails CI on any 5xx from malformed input.
- Rules of thumb: 400 = malformed shape, 422 = valid shape wrong meaning; 409 = conflicts with current state, 422 = payload logic always wrong (incl. a capability blocked by an immutable resource type — personal vs team organization). Never invent a status outside this list.

## Machine-readable `error.reason` (stable branch signal, not human copy)

`code` is the status-class slug (`conflict`, `validation_error`, …). When a **4xx** error
is a **distinct cause the frontend may branch on**, also attach a stable snake_case
`reason` sub-code via **`.withReason('<slug>')`** at the throw site
(`throw new ConflictError('errors:x').withReason('membership_already_exists')`). It is
additive, surfaced on 4xx only (masked on 5xx), and is the ONLY dependable branch key —
`detail` is localized human copy that changes with wording/locale (see **i18n-message-guard**).

- Register every new slug in the list in [`docs/reference/api/response-codes.md`](../../../docs/reference/api/response-codes.md).
- Tests for that cause assert `body.error.reason === '<slug>'` — never a `detail`/message substring or a raw `errors:*` key.

## Personal vs team organizations (one route surface, discoverable capabilities)

- The route surface is identical for personal and team organizations — there are **no** personal-only or team-only paths.
- Team-only capabilities (invite/manage members, manage roles, transfer ownership, delete the organization, manage billing) reject a **personal** organization with **422** via `assertTeamOrganization(organization, capability)` (`src/domains/tenancy/sub-domains/organization/organization-capability.ts`).
- Every serialized organization carries a `capabilities` object (`can_invite_members`, `can_manage_members`, `can_manage_roles`, `can_transfer_ownership`, `can_delete`, `can_manage_billing`) describing the **organization type's** capability (not the caller's permission), so clients discover this without probing for a 422.
- The route catalog encodes this as the `O` column (`both` | `team`), kept in sync with `tooling/openapi/route-catalog/route-organization-scope.json` by `pnpm validate:route-organization-scope`.

## List endpoints — common search / sort / pagination method

Every organization-scoped list endpoint uses the **shared** helpers in `src/shared/utils/http/list-query.util.ts` — do **not** hand-roll keyset / cursor / filter-binding per repository:

- **DTO**: build the query schema with `listSearchSortSchema([...sortFields] as const)` (adds `q`, `sort`, `order` to `cursorPaginationSchema`, `.strict()`). For a search-only list (no sortable columns), extend `cursorPaginationSchema` with just `q`. Register the DTO in `tooling/openapi/query-schema-map.ts` so OpenAPI documents `after`/`limit`/`q`/`sort`/`order`.
- **Repository**: `resolveKeysetSort({ columns, idColumn, defaultSort, sort, order, q, after })` → `orderBy` / `cursorCondition` / `sortValueFor` / `filterFingerprint`; `buildSearchCondition(columns, q)` for the `ILIKE`; `finishKeysetPage(rows, { limit, sortValueFor, filterFingerprint })` (fetch `limit + 1`). Escape user `ILIKE` terms with `buildContainsLikePattern(q)` — never interpolate a raw term.
- **Controller**: return `paginatedResponse(items, id, { per_page: limit, next: next_cursor, has_more, ...(total !== null ? { estimated_total: total } : {}) })`.
- **sec-U12**: the minted cursor carries a SHA-256 fingerprint of `{q, sort, order}`; a cursor whose fingerprint no longer matches the current query is ignored (resets to page 1) so a cursor can't interleave pages across filters. This is automatic via `resolveKeysetSort` — don't bypass it.

**`.optional()`, never `.default`, for `sort` / `order` (and `limit` on a route that did not previously have it).** Zod `.default(...)` serializes the OpenAPI query param as `required` — a breaking change on an existing route. Keep these params `.optional()` and apply the default in `resolveKeysetSort` / the service (`order ?? 'asc'`, `limit ?? PAGINATION.DEFAULT_LIMIT`). Adding a **new optional** param is non-breaking; adding a new **required** one is not.

**External-provider lists (Stripe, etc.) are a cursor passthrough, not a DB keyset** — they do NOT use the helpers above. Expose the provider's own cursor: pass `limit` + `starting_after` (a provider id), return `{ data, has_more }` from the client, and shape the same `paginatedResponse` envelope with `next` = the last row's provider id when `has_more`. See `GET /billing/invoices` (`listStripeInvoices`).

**Searching a column that lives on a FORCE-RLS joined table** (e.g. member email/name in `auth.users`) can't use a plain join under organization-only context — it needs a SECURITY DEFINER resolver. See `rls-tenant-isolation-guard` (member-search example, `tenancy.search_organization_membership_ids`).

## Header matrix (client-sent)

- `Authorization: Bearer <ACCESS_TOKEN>` — every authed route (OpenAPI security scheme; Postman collection-level bearer `{{ACCESS_TOKEN}}`).
- `Content-Type: application/json` — any body.
- `X-Organization-Id` — legacy header read directly by a few consumers (e.g. the upload domain); organization-scoped routes resolve the active organization from the signed `org` JWT claim, NOT this header. Switch the active organization via `/auth/switch-to-personal` / `/auth/switch-to-organization` (which re-mint the access token).
- `X-Idempotency-Key` — all mutating routes (optional, auto-generate in clients); REQUIRED on the 13 writes registered with `config.idempotencyRequired: true` (organization create, memberships, transfer-ownership, subscription create/change-plan/cancel/resume, payment-method setup, webhooks, api-keys, notification-policies, roles, uploads). Live list = the `I` (`req`) column in `docs/routes.txt`.
- `X-Captcha-Token` — public auth forms only (login, email verification-code send + login, password forgot/reset, mfa/login, webauthn authenticate options, oauth authorize).
- `X-CSRF-Token` — POST /auth/refresh only (double-submit of the csrf_token cookie). Keeps the X- form (frontend-framework default).
- `Stripe-Signature` — sent BY Stripe to the webhook routes; the app never sends it.

## Headers kept in X- form (ecosystem standards)

`X-Request-Id`, `X-Client-Request-Id`, `X-Api-Key`, `X-CSRF-Token`, `X-RateLimit-*` (server-emitted with `Retry-After` on 429), Helmet's security headers, `X-Forwarded-For`, `X-Requested-With` (CORS-allowlisted in `cors.middleware.ts` so browser/XHR-library preflights pass — the app reads no meaning from it). Custom headers use the X- form for visual consistency with the infrastructure headers: `X-Organization-Id`, `X-Idempotency-Key`, `X-Idempotency-Replay` (response marker), `X-Captcha-Token`. Standards keep their fixed names: `Authorization`, `Stripe-Signature`, `Retry-After`.

## Sync checklist when touching any of the above

1. `pnpm routes:catalog` → registry key updates in `route-success-statuses.json`.
2. Response-map / examples fixture keys follow the same `METHOD /path` keys.
3. `ROUTE_EXAMPLE_CAPTURE=1 pnpm test && pnpm routes:examples` to refresh captured samples.
4. `pnpm docs:generate:multilang && pnpm docs:postman` then `pnpm docs:check`.
5. Gates: `validate:route-success-statuses`, `validate:route-success-coverage`, unit suites for the response map and examples fixture.
6. Frontend client contract: when an auth **entry-flow** route or its response body changes (login, email verification-code send/login, oauth, webauthn, mfa/login, refresh, switch-to-organization/personal, or `GET /auth/me/context`), or a **client-sent header** requirement (the header matrix above) changes, update `docs/reference/api/frontend-auth-guide.md` — its entry-flow → calls-to-dashboard matrix and the typed `landOnDashboard()` client mirror those shapes. Server-internal sequences for the same journeys live in `src/FLOWS.md`.

---

**Related skills:** [route-schema-doc-guard](../route-schema-doc-guard/SKILL.md) · [route-catalog](../route-catalog/SKILL.md) · [seed-maintainer](../seed-maintainer/SKILL.md) · [idempotency-guard](../idempotency-guard/SKILL.md)
