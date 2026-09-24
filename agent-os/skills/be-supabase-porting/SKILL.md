---
name: be-supabase-porting
description: Ports Supabase Edge Functions (Deno) into core-be (Node/Fastify/Drizzle/BullMQ). Manual invoke only. Not for SQL migrations in migrations/ — use be-db-migration-maintainer.
indexNote: port Supabase Edge Functions (Deno) → Node/Fastify (manual invoke only)
---

# Supabase porting (Edge Functions → core-be)

> **Not** SQL migrations. For `migrations/*.sql` and Drizzle schema changes, use **be-db-migration-maintainer**.

## Scope

Port logic from `supabase/functions/` (or similar) into this repo while preserving domain-first architecture.

## Canonical structure (must follow)

- **Domain layout:** `src/domains/<domain>/<domain>.{routes,controller,validator,dto,serializer,service,repository,container,types}.ts` at domain root; sub-domains in `src/domains/<domain>/<sub-domain>/`.
- **Sub-domain directories** always domain-prefixed: `user-settings`, `auth-method`, `organization-settings`, `member-role-permission`, `webhook-event`.
- Domains: auth, user, tenancy, billing, notify, audit, upload. See `CLAUDE.md` or **be-domain-generator**.
- Optional per sub-domain: `events/`, `queues/`, `workers/`.
- Drizzle schemas: **co-located** at `src/domains/<domain>/<sub-domain>/<sub-domain>.schema.ts` (not under `infrastructure/database/schemas/`).
- Queue infrastructure (`connection.ts`, `bootstrap.ts`) in `src/infrastructure/queue/` — central start only; processors live in domains.

## Workflow (recommended order)

1. **Audit existing config** — `package.json` scripts, `tsconfig.json`, `drizzle.config.ts`, `migrations/`.
2. **Scaffold `src/`** — folders from **be-domain-generator**; stubs first, then port logic.
3. **Port shared primitives** — errors, env, response helpers, logger, utils under `src/shared/`.
4. **Database** — `connection.ts`, co-located `*.schema.ts`, **be-db-migration-maintainer** for SQL in `migrations/`, `pnpm db:migrate`.
5. **Fastify middleware** — auth, tenant, error-handler, health, shutdown (see `src/shared/middlewares/`).
6. **Port one reference domain** — service/repository behavior parity; mount under `/api/v1/<domain>`.
7. **Events → queue → worker** — **be-workers-events** patterns.
8. **Verification** — health routes, CRUD + auth, `pnpm lint`, `pnpm typecheck`, **be-test-generator** checklist.
9. **Wire DI** — `src/routes.ts` containers and route registration.

## Follow-up skills

| After porting | Skill                                                                |
| ------------- | -------------------------------------------------------------------- |
| New routes    | **be-route-catalog**, **be-route-schema-doc-guard**, **be-seed-maintainer** |
| Tests         | **be-test-generator**                                                   |
| Docs/rules    | **be-structure-maintainer**                                             |

## Non-negotiables

- **Full names only**: `repository` not `repo`, `organization` not `org`.
- DB invariants in Postgres (schema + migrations).
- Sub-domain directories always use domain prefix.
