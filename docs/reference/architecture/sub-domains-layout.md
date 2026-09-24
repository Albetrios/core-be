# Sub-domains layout (canonical)

Multi-resource domains use `src/domains/<domain>/sub-domains/`. **Aggregate children** that belong to a parent resource live in a **nested** folder:

```text
sub-domains/<parent>/<nested-child>/
```

Examples: `organization/organization-api-key/`, `membership/member-invitation/`, `webhook/webhook-event/`, `member-roles/member-role-permission/`.

## Import paths

- Top-level sub-domain: `@/domains/<domain>/sub-domains/<resource>/...`
- Nested sub-domain: `@/domains/<domain>/sub-domains/<parent>/<nested>/...`

## Event handler tests

Co-locate under `__tests__/unit/events/` on the resource that owns the handlers (never `events/__tests__/` — see `be-testing-conventions.mdc`).

## DTO rule

Every route file uses Zod DTOs from co-located `*.dto.ts`. Controllers stay thin.

## Route schema rule

Every Fastify route registration must include a `schema: { summary, description, tags }` block — this is the single source of truth for OpenAPI generation. Owned by **[be-route-schema-doc-guard](../../../.cursor/skills/be-route-schema-doc-guard/SKILL.md)**.

## In-source docs (mandatory per sub-domain)

Every sub-domain (top-level or nested) must have:

| Layer | Source of truth | Owner skill |
| --- | --- | --- |
| `<sub-domain>/<sub-domain>.overview.md` | Hand-written narrative — Purpose, Key invariants, Lifecycle, Events, Failure modes, Policy constants | be-overview-doc-maintainer |
| TSDoc summaries on every public export; `@remarks` on `*.service.ts` / `*.worker.ts` / `*.processor.ts` / `*.policy.ts` | TSDoc on the export itself | be-tsdoc-export-guard |
| Inline Fastify `schema.summary` / `schema.description` for every route (drives OpenAPI) | Zod schema in `*.routes.ts` | be-route-schema-doc-guard |

The first line of `<folder>.overview.md` must be the bare backticked relative path (e.g. ``` `src/domains/tenancy/sub-domains/organization/` ```). See [documentation-system.md](./documentation-system.md) for the full system.

## Upload content types

Validators use `getAllowedContentTypesForPurpose()` so `UPLOAD_ALLOW_SVG` controls whether SVG is allowed on image purposes. Organization logos reject SVG at attach time for security.

For the full domain map, see [CLAUDE.md](../../../CLAUDE.md) and [domains-and-public-api-design.md](./domains-and-public-api-design.md). For cross-cutting patterns (RLS context, idempotency, transactional outbox), see [`src/PATTERNS.md`](../../../src/PATTERNS.md).
