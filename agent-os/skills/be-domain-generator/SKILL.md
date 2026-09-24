---
name: be-domain-generator
description: Scaffolds and extends domains in core-be using the domain → sub-domain (and nested sub-domain) layout under src/domains/<domain>/. Use when creating a new domain, adding a sub-domain (resource), or wiring routes and DI.
trigger: src/routes.ts
triggerNote: Check DI wiring / route registration (new domain scaffolds via the new-domain chain)
indexNote: scaffold/extend domains + sub-domains and wire routes/DI
---

# Domain generator (core-be)

## How would you like to set up domains

Before scaffolding, confirm:

1. **Which domain?** (folder = DB schema)
   - **auth** — sub-domains: `auth-method/`, `auth-session/`, `auth-mfa/`, `auth-mfa-session/`, `auth-webauthn/`
   - **user** — sub-domains: `user-settings/`, `user-notification-preferences/`, `user-data-export/`
   - **tenancy** — sub-domains: `organization/` (nested: `organization-settings/`, `organization-notification-policy/`, `organization-api-key/`), `membership/` (nested: `member-invitation/`), `member-roles/` (nested: `member-role-permission/`), `permission/`
   - **billing** — sub-domains: `plan/`, `subscription/`, `stripe-webhook/`
   - **notify** — sub-domains: `notification/`, `webhook/` (nested: `webhook-event/` (event types) and `webhook-delivery/` (delivery attempts, queues, workers, DLQ))
   - **audit**, **upload** — flat domains (no `sub-domains/`)

2. **Top-level or nested sub-domain?**
   - **Top-level:** `src/domains/<domain>/sub-domains/<resource>/`
   - **Nested (aggregate child):** `src/domains/<domain>/sub-domains/<parent>/<child>/` — only when lifecycle is tied to parent (organization-api-key, member-invitation, webhook-event, member-role-permission).

3. **What routes/API?**
   - List, get by id, create, update, delete; or sub-resource routes under parent.

## Canonical layout (domain → sub-domains → optional nested)

```text
src/domains/<domain>/
  <domain>.routes.ts
  <domain>.container.ts
  events/                     # Optional: register<Domain>EventHandlers() aggregator
    index.ts
  __tests__/
    <domain>.test.ts          # Bundled domain e2e (when used)
    factories/                # Optional: helpers shared across sub-domains (tenancy permission)
    unit/                     # Domain-level validators/serializers + policy scans

  seed/                       # Present when this level owns tables (see be-seed-maintainer)
    index.ts                  # Domain root: exports a DomainSeedModule (name + dependsOn)
    <domain>.reference.seed.ts
    <domain>.bulk.seed.ts
    <domain>.faker.ts

  sub-domains/                # Required for multi-resource domains (omit for audit, upload)
    <sub-domain>/             # Top-level resource
      <sub-domain>.routes.ts  # When sub-domain registers its own plugin (billing, tenancy, notify)
      <sub-domain>.controller.ts
      <sub-domain>.service.ts
      <sub-domain>.repository.ts
      <sub-domain>.dto.ts
      <sub-domain>.validator.ts
      <sub-domain>.serializer.ts
      <sub-domain>.types.ts
      <sub-domain>.schema.ts
      seed/                   # When this resource owns tables: exports a SeedContribution
        index.ts
        <sub-domain>.reference.seed.ts
        <sub-domain>.bulk.seed.ts
        <sub-domain>.faker.ts
      __tests__/
        unit/                 # *.validator.unit.test.ts, *.serializer.unit.test.ts
        <sub-domain>.test.ts  # Optional dedicated e2e (tenancy organization children)
      events/                 # Optional
        __tests__/            # event-handler / emit unit tests
        *.events.ts
        *.event-handlers.ts
      queues/                 # Optional
      workers/                # Optional

      <nested-sub-domain>/    # Optional aggregate child
        <nested-sub-domain>.controller.ts
        ... same layers ...
        seed/                 # When this child owns tables: exports a SeedContribution
        __tests__/unit/
```

**Import paths:**

- Top-level: `@/domains/<domain>/sub-domains/<sub-domain>/...`
- Nested: `@/domains/<domain>/sub-domains/<parent>/<nested>/...`
- **Never** parent-relative (`../`) — same-folder `./` only for co-located layers (e.g. service → `./repository.js`).
- Domain handlers under `handlers/` import sub-domains via `@/domains/<domain>/sub-domains/...`.

Example (auth handler):

```typescript
import { createAuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
```

Flat domains (`audit`, `upload`) keep all layers at domain root with no `sub-domains/`.

## Naming rules

- **Domain folder** = DB schema name: `auth`, `user`, `tenancy`, `billing`, `notify`, `audit`, `upload`.
- **Sub-domain folder** = domain-prefixed resource name, kebab-case: `user-settings`, `auth-method`, `organization-settings`, `member-role-permission`, `webhook-event`.
- **Files**: named after the resource — `<resource>.service.ts`, `<resource>.repository.ts`, `<resource>.controller.ts`.
- **Full names only**: `repository` not `repo`, `organization` not `org`, `database` not `db`, `request` not `req` (except Fastify conventions).
- **Controllers** export: `create<Resource>Controller(service)` or `create<Resource>Controller(container)` when multiple sub-domain services are wired.

## Key patterns

### Controllers

Import shared helpers — never define local ones:

```typescript
import { getRequestIdentifier, requireAuth } from '@/shared/utils/http/request.util.js';
```

### Validators (function-based + safeParse)

```typescript
export function validateCreate<Resource>(data: unknown): Create<Resource>Input {
  const result = create<Resource>Dto.safeParse(data);
  if (!result.success) {
    throw new ValidationError('Invalid input', result.error.flatten().fieldErrors);
  }
  return result.data;
}
```

### Serializers (function-based)

```typescript
export function serialize<Resource>(row: DbRow): <Resource>Output {
  return { id: row.public_id, name: row.name, created_at: row.created_at.toISOString() };
}
```

### Containers

```typescript
export function create<Domain>Container(deps?: CrossDomainDeps) {
  const repository = new <Resource>Repository();
  const service = new <Resource>Service(repository, deps?.organizationRepository);
  return { service };
}
```

### Routes (FastifyPluginAsync)

```typescript
export function <domain>Routes(deps: <Domain>RoutesDeps): FastifyPluginAsync {
  const controller = create<Resource>Controller(deps.service);
  return async (app) => {
    app.get('/<resources>', controller.list);
  };
}
```

## Workflow

1. **Choose domain and sub-domain** (top-level or nested under parent).
2. **Create or extend the domain skeleton** at `src/domains/<domain>/`.
3. **Create sub-domain** at `sub-domains/<resource>/` or `sub-domains/<parent>/<nested>/`.
4. **Create DB schema** (if new table) — co-located `*.schema.ts`; run **be-sql-design-guard** + **be-db-migration-maintainer**.
5. **Scaffold `seed/`** (when this level owns tables) — add `<name>.reference.seed.ts` / `<name>.bulk.seed.ts` / `<name>.faker.ts` and an `index.ts` exporting a `SeedContribution` (or, for a new top-level domain, a `DomainSeedModule` with `name` + `dependsOn`, registered in `SEED_MODULES` in `src/scripts/seed/modules.ts`). Parent `seed/index.ts` composes the new contribution via `composeContributions(...)`. Seed only this level's tables; read parents from `context.registry`. Run **be-seed-maintainer**.
6. **Add tests** (see **be-test-generator**):
   - Bundled routes: extend `<domain>/__tests__/<domain>.test.ts` OR add nested `__tests__/<resource>.test.ts`.
   - Validators/serializers: `__tests__/unit/` on the resource that owns the file.
   - Event handlers: `__tests__/unit/events/` — call leaf `register*EventHandlers()` only (never `events/__tests__/`).
7. **Wire DI** via `<domain>.container.ts`.
8. **Wire routes** in `<domain>.routes.ts` or sub-domain `*.routes.ts`; mount in `src/routes.ts`.
9. **Author in-source docs** (required, gated by `pnpm tsdoc:check`):
   - **TSDoc** on every public export — invoke **be-tsdoc-export-guard**.
   - **`schema: { summary, description, tags }`** on every Fastify route — invoke **be-route-schema-doc-guard**.
   - **`<folder>.overview.md`** at the new domain folder (Template A.1) and at the new sub-domain folder (Template A.2) — invoke **be-overview-doc-maintainer**.
   - For a **new domain**, also update `src/OVERVIEW.md` Domains table — invoke **be-system-narrative-maintainer**.
10. **Verify coverage** — run `pnpm tsdoc:check` and confirm the budget did not regress.

## Dependency boundaries

- **controllers/** may import: own service(s) or container deps, `@/shared/utils/http/request.util.js`, `@/shared/utils/http/response.util.js`, shared errors.
- **services/** may import: **same-domain** repository, own validator, shared errors, `src/core/events/event-bus.ts`, `src/shared/utils/infrastructure/logger.util.js`. For cross-domain reads/writes, import the other domain's **service** only — never its repository or schema.
- **repositories/** may import: DB connection, schema, own domain types; may extend `base-repository.ts`.
- **containers/** may import: own domain repositories, services. Accept cross-domain deps as parameters. Export services for route registration.
- **validators/** call DTO `.safeParse()` methods and throw `ValidationError`.
- **DTOs** contain Zod schemas only.
- **Serializers** shape response data using function-based transforms.

## Output expectation

When adding a domain or sub-domain, generate the skeleton (domain-level files + sub-domain or nested sub-domain folders) and DI wiring first; then fill in business logic, validation, and tests incrementally.
