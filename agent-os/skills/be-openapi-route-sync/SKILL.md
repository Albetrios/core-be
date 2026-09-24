---
name: be-openapi-route-sync
description: Keeps OpenAPI tag locale workflows in sync when routes change. Legacy — for route schema authoring use be-route-schema-doc-guard instead. Do not add new references from sync rules or intake docs.
indexNote: legacy — tag locale only; use be-route-schema-doc-guard for schema
---

# OpenAPI route sync (core-be)

> **Note**: this skill is preserved for OpenAPI tag-locale workflows. For authoring the `schema: { summary, description, tags }` block on a Fastify route registration, **use [be-route-schema-doc-guard](../be-route-schema-doc-guard/SKILL.md)** — it covers the same ground with the in-source docs cross-pings (be-route-catalog, be-openapi-multilingual, be-tsdoc-export-guard).

## Purpose

**be-route-catalog** updates `docs/routes.txt`. This skill keeps **OpenAPI documentation** aligned: per-operation summary/description/tags on the route schema, plus locale copy for tag names.

## When to use

Run **after be-route-catalog** whenever `*.routes.ts` changes:

- New route registered
- Path, method, or access changed
- Route removed

Also invoke **be-openapi-multilingual** when adding new tags or response keys in locale files.

## Where operation metadata lives

| Layer                          | Location                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-route summary/description/tags** | `schema: { summary, description, tags }` on the Fastify route registration in `*.routes.ts` (Zod type provider). Read by `tooling/openapi/extractors/route-schema-metadata.ts`. |
| **Tag display names**          | `src/shared/locales/{en,es}/openapi.json` → `tags` object (e.g. `"Auth": "Authentication — login, logout, password management"`).                                                    |
| **Supplemental routes**        | `/livez`, `/readyz`, `/api/v1/mcp` carry their schema literal directly on the registration in `src/shared/middlewares/core/health.middleware.ts` and `src/infrastructure/mcp/mcp-server.ts`. |

## Steps

1. **Add `schema` block on the route registration**:

   ```ts
   zodApplication.post(
     '/path',
     {
       onRequest: [app.authenticate],
       preHandler: [requireOrganizationPermission(...)],
       schema: {
         summary: 'Short verb-first phrase',
         description: 'One-sentence description of what the endpoint does and any key constraints.',
         tags: ['Domain', 'Resource'],
         body: SomeDto,
       },
     },
     controller.handler,
   );
   ```

2. **New tag?** Add the tag name + description to **all** `src/shared/locales/*/openapi.json` `tags` objects.
3. **Generate specs**:

   ```bash
   pnpm docs:generate:multilang
   ```

4. Optional: `pnpm docs:postman` if Postman collection must be refreshed for the team.

## Relation to other skills

| Skill                         | Role                                              |
| ----------------------------- | ------------------------------------------------- |
| **be-route-catalog**             | `docs/routes.txt`                                 |
| **be-openapi-route-sync** (this) | Schema-level summary/description + locale tags   |
| **be-openapi-multilingual**      | Full locale parity, new locales, response keys   |

## Checklist

- [ ] Every new public/authenticated route has `schema: { summary, description, tags }` on its Fastify registration
- [ ] Removed routes leave no orphaned schema literals
- [ ] New tags present in `en` and `es` `openapi.json`
- [ ] `pnpm docs:generate:multilang` run (or noted for CI)

## Anti-patterns

- Adding metadata in any side-table (the legacy `tooling/openapi/route-metadata/*.ts` was deleted — don't reintroduce a parallel source of truth)
- Relying on generic fallback summaries for user-facing API docs (`POST /api/v1/...` is a smell)
- Updating only `docs/openapi/*.json` by hand (generated artifacts)
