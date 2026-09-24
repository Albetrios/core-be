---
name: be-route-schema-doc-guard
description: Ensures every Fastify route registration in src/**/*.routes.ts (plus the special non-routes files src/shared/middlewares/core/health.middleware.ts and src/infrastructure/mcp/mcp-server.ts) carries a schema block with summary, description, and tags. Use when adding, removing, or renaming any route, or when openapi/route-catalog generation reports a missing summary.
indexNote: every route registration carries schema summary / description / tags
---

# Route schema doc guard (core-be)

Owns the **`schema`** block on every Fastify route registration. The block is the single source of truth for the OpenAPI document and the route catalog descriptions.

## When to run

Run this skill **every time** you:

- Add a new route to any `*.routes.ts`.
- Remove or rename a route.
- Add a new public route to one of the **two non-routes files** that also register HTTP routes:
  - `src/shared/middlewares/core/health.middleware.ts` (the `/livez` and `/readyz` endpoints)
  - `src/infrastructure/mcp/mcp-server.ts` (the `/api/v1/mcp` GET + POST endpoints)
- See a route in `docs/routes.txt` or `docs/openapi/openapi.json` with an empty / generic summary or description.

## The contract

Every route registration must include `schema: { summary, description, tags }` directly on the options object passed to Fastify. Example:

```ts
app.post(
  '/invitations/:invitationId/accept',
  {
    ...STRICT_PUBLIC_RATE_LIMIT,
    schema: {
      summary: 'Accept invitation',
      description:
        'Accepts a pending invitation using the invitation token. Creates a membership for the user.',
      tags: ['Membership', 'Invitation'],
    },
  },
  invitationController.acceptMemberInvitation,
);
```

Rules:

- **`summary`** is required, ≤ 60 chars, action-phrased ("Create subscription", "Cancel invitation"), no trailing period.
- **`description`** is required, complete sentences, captures the contract: what the route does, what it requires, what it returns, what it's used for. Mention idempotency, signature verification, raw-body requirements, etc. when relevant.
- **`tags`** is required, in title case, drawn from the platform's tag vocabulary. New tags need a matching translation entry in `src/shared/locales/en/openapi.json` (and other locales).
- The `schema` block lives on the **route registration's options object**, not in a side table. There is no `routeMetadataMap` — that side table was retired.

**Enforced by `pnpm validate:route-schema-docs`** ([`src/scripts/validators/routes/validate-route-schema-docs.ts`](../../../src/scripts/validators/routes/validate-route-schema-docs.ts), wired into `ci:local` + `ci:quality`) — the gate fails closed if any registration (including the two non-routes files) is missing `summary`, `description`, or `tags`. Fix the gap; never suppress it.

## Spread operators

When the route options use a shared rate-limit / config spread, wrap the spread inside an object literal so the `schema` field has somewhere to live:

```ts
app.post(
  '/webhook',
  {
    ...WEBHOOK_RATE_LIMIT,
    schema: {
      summary: 'Stripe webhook receiver',
      description: '...',
      tags: ['Billing', 'Stripe Webhook'],
    },
  },
  controller.handleWebhook,
);
```

The OpenAPI extractor at [`tooling/openapi/extractors/route-schema-metadata.ts`](../../../tooling/openapi/extractors/route-schema-metadata.ts) handles this shape directly.

## Non-routes files

The two non-routes files that register HTTP endpoints are explicitly listed in [`tooling/openapi/extractors/route-schema-metadata.ts`](../../../tooling/openapi/extractors/route-schema-metadata.ts) (search for `SUPPLEMENTAL_ROUTE_FILES`). When adding a route in either of these files:

1. Add the `schema` block on the registration in the same way you would in a `*.routes.ts`.
2. Keep the route registration call patterns matching the broad regex (`application.<method>` or `app.<method>`).

If you find yourself adding HTTP routes outside `*.routes.ts` and outside those two files, **stop** — register the route through a domain's `*.routes.ts` instead. The non-routes files are grandfathered exceptions, not a pattern.

## How to add or update a schema

1. Open the `*.routes.ts` file (or the relevant non-routes file).
2. Locate the route registration. If options are a spread expression alone (e.g. `STRICT_PUBLIC_RATE_LIMIT`), wrap them in an object literal first.
3. Add `schema: { summary, description, tags }` with content from the contract rules above.
4. Run `pnpm docs:generate` (or `pnpm docs:generate:multilang` if the platform supports multiple locales). Confirm the new `summary` / `description` appear in `docs/openapi/openapi.json`.
5. Run `pnpm routes:catalog` to refresh `docs/routes.txt`.
6. Run `pnpm docs:generate` to refresh `docs/openapi/openapi.json` (the single source of truth for downstream consumers).
7. Run `pnpm tsdoc:check` to confirm no TSDoc regression on any new exports added alongside the route.

## Anti-patterns

- ❌ Adding a route without a `schema` block — fails OpenAPI build; downstream consumers (Postman, API hub) lose the route description.
- ❌ Putting the description in a leading comment instead of the schema — the extractor only reads the schema property.
- ❌ Using a tag that's not in the locale's tag list — the multilingual generator will fail to translate it.
- ❌ Re-creating the deprecated `routeMetadataMap` side table — the schema lives on the route, not in a sibling file.

## Cross-skill triggers

- After updating the schema → invoke **be-route-catalog** (refresh `docs/routes.txt`).
- After adding a tag → invoke **be-openapi-multilingual** (add tag translations).
- After authoring → run `pnpm tsdoc:check` and `pnpm docs:check` to confirm no regressions.

## Related references

- OpenAPI extractor: [`tooling/openapi/extractors/route-schema-metadata.ts`](../../../tooling/openapi/extractors/route-schema-metadata.ts)
- Existing skills that touched this contract: **be-openapi-route-sync**, **be-openapi-multilingual**, **be-route-catalog**.

---

**Related skills:** [be-api-contract-guard](../be-api-contract-guard/SKILL.md) · [be-route-catalog](../be-route-catalog/SKILL.md) · [be-openapi-multilingual](../be-openapi-multilingual/SKILL.md)
