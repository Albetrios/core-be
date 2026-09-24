---
name: be-route-catalog
description: Generates a docs/routes.txt file listing every API route grouped by domain with HTTP method, full path, and access control (public, authenticated, global role, organization permission). Use after adding, removing, or updating any route in src/domains/.
indexNote: regenerate docs/routes.txt after any route change
---

# Route catalog generator (core-be)

Produces **`docs/routes.txt`** — a single-file overview of **every** HTTP route (method, path, access). Auto-generated; do not edit by hand. Tests parse this file via `@/tests/helpers/route-catalog-registry.js`.

## When to run

Run this skill **every time** you:

- Add a new route to any `*.routes.ts`
- Remove a route
- Change a route's path, method, or access control (preHandler)
- Add or remove a domain/sub-domain that registers routes

## How it works

### Step 1 — Read route sources

1. Read `src/routes.ts` to get the **prefix map** (domain → prefix, e.g. `auth → /api/v1/auth`).
2. Read every `*.routes.ts` file under `src/domains/` (use Glob `src/domains/**/*.routes.ts`).
3. For aggregator route files (e.g. `tenancy.routes.ts`) that register sub-domain route plugins without their own `app.register` prefix, note that sub-domain routes inherit the parent prefix.

### Step 2 — Parse each route

For every `app.<method>(path, ...)` call, extract:

| Field             | How to detect                                               |
| ----------------- | ----------------------------------------------------------- |
| **Method**        | `app.get`, `app.post`, `app.patch`, `app.put`, `app.delete` |
| **Relative path** | First string argument (e.g. `'/organizations/:id'`)         |
| **S** (status)    | Declared happy-path status from `route-success-statuses.json` (success 200 for every method except DELETE 204; no exemptions) |
| **I** (idempotency) | `req` if the route is one of the 8 `idempotencyRequired` writes (`X-Idempotency-Key` mandatory), else `-` |
| **O** (organization scope) | `both` if the route works for personal **and** team organizations; `team` if it is team-only (rejects a personal organization with 422). Backed by `tooling/openapi/route-catalog/route-organization-scope.json` |
| **Access**        | Inspect the `preHandler` array in the options object        |

The three annotation columns (`S`, `I`, `O`) print **after the path** and before the ACCESS label — see the format block in Step 4. The `O` column is the only one carried by a hand-maintained side-table (`route-organization-scope.json`); `pnpm validate:route-organization-scope` fails CI if that map drifts from `docs/routes.txt`.

#### Access-level rules

| Pattern in `preHandler`                                          | Access label                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| No options / no `preHandler`                                     | `PUBLIC`                                               |
| `[app.authenticate]` only                                        | `AUTH`                                                 |
| `[app.authenticate, requireRole(GLOBAL_ROLES.X, ...)]`           | `ROLE: super_admin` (list the roles)            |
| `[app.authenticate, requireOrganizationPermission(PERM.X, ...)]` | `PERM: <permission_code>` (e.g. `organization:update`) |

To resolve permission codes, look at the constant imported (e.g. `TENANCY_PERMISSIONS.ORGANIZATION_UPDATE`). Map these to their string values. Common mappings:

- `TENANCY_PERMISSIONS.*` → defined in `src/domains/tenancy/tenancy.permissions.ts`
- `BILLING_PERMISSIONS.*` → defined in `src/domains/billing/billing.permissions.ts`
- `NOTIFY_PERMISSIONS.*` → defined in `src/domains/notify/notify.permissions.ts`
- `AUDIT_PERMISSIONS.*` → defined in `src/domains/audit/audit.permissions.ts`

Read the relevant `*.permissions.ts` file to resolve the actual string code.

### Step 3 — Build full path

Concatenate the **domain prefix** (from `src/routes.ts`) + **sub-domain prefix** (if any `app.register` in the aggregator adds one) + **relative path**.

Example: prefix `/api/v1/tenancy` + relative path `/organizations/:id/settings` = `/api/v1/tenancy/organizations/:id/settings`.

### Step 4 — Write `docs/routes.txt`

Use this exact format:

```text
================================================================================
  ROUTE CATALOG — core-be
  Total routes: <count>
================================================================================

Legend:
  PUBLIC  = No authentication required
  AUTH    = JWT authentication required
  ROLE    = Global role required (super_admin, user)
  PERM    = Organization-scoped permission required
  TOKEN   = Non-JWT bearer token required
  Columns after the path: S = success status · I = idempotency (req | -) · O = organization scope (both | team-only, 422 on personal)

================================================================================
  DOMAIN: AUTH (/api/v1/auth)
  Routes: <count>
================================================================================

  POST   /api/v1/auth/login                                       200  -    both  PUBLIC
  POST   /api/v1/auth/logout                                      200  -    both  PUBLIC
  ...
  GET    /api/v1/auth/me/mfa                                      200  -    both  AUTH
  POST   /api/v1/auth/me/mfa/enroll                               200  -    both  AUTH
  POST   /api/v1/auth/me/webauthn/register/options               200  -    both  AUTH
  POST   /api/v1/auth/mfa/login                                   200  -    both  PUBLIC
  POST   /api/v1/auth/password/change                             200  -    both  AUTH
  ...

================================================================================
  DOMAIN: TENANCY (/api/v1/tenancy)
  Routes: <count>
================================================================================

  — Organization —
  GET    /api/v1/tenancy/organization                             200  -    both  PERM: organization:read
  PATCH  /api/v1/tenancy/organization                             200  -    both  PERM: organization:update
  DELETE /api/v1/tenancy/organization                             204  -    team  PERM: organization:delete
  ...

  — Membership —
  DELETE /api/v1/tenancy/organization/invitations/:invitation_id  204  -    both  PERM: invitation:manage
  POST   /api/v1/tenancy/organization/memberships                200  req  team  PERM: membership:manage
  ...

================================================================================
  DOMAIN: BILLING (/api/v1/billing)
  Routes: <count>
================================================================================

  — Plans —
  GET    /api/v1/billing/plans                                    200  -    both  PUBLIC
  ...

  — Subscriptions —
  POST   /api/v1/billing/subscriptions                            200  req  both  PERM: subscription:manage
  ...

================================================================================
  SUMMARY
================================================================================

  Total routes    : <count>
  Public          : <count>
  Authenticated   : <count>
  Role-guarded    : <count>
  Perm-guarded    : <count>
  Token-guarded   : <count>
  Team-only (O)   : <count>

================================================================================
  IDEMPOTENCY-REQUIRED WRITES (13) — X-Idempotency-Key required
================================================================================

  <the 13 routes whose I column is `req` — listed automatically>

================================================================================
  DEPRECATED ROUTES (<count>) — Sunset / Deprecation headers
================================================================================

  <routes carrying Sunset/Deprecation headers — today the Stripe webhook alias>

================================================================================
  PERMISSION CODES REFERENCE
================================================================================

  <every permission string, grouped by domain — auto-derived from the
   *.permissions.ts constants, so adding e.g. `upload:manage` shows up here>
```

### Formatting rules

- **Method** column: left-aligned, padded to 6 chars wide (e.g. `GET` padded to `GET___`, `DELETE` already 6 chars; underscores show where spaces go)
- **Path** column: left-aligned, padded so the annotation columns line up
- **S / I / O** columns: printed after the path, before ACCESS — success status, idempotency (`req` | `-`), organization scope (`both` | `team`)
- **Access** column: label (`PUBLIC`, `AUTH`, `ROLE: …`, `PERM: …`, `TOKEN`)
- Group routes within a domain by sub-domain using `— Sub-domain Name —` dividers
- Within each group, order routes by path alphabetically, then by method (GET, POST, PATCH, PUT, DELETE)
- Include the summary section, then the three **auto-generated footer sections** below

### Auto-generated footer sections

These three sections are derived programmatically — never hand-maintained:

1. **IDEMPOTENCY-REQUIRED WRITES** — the 8 routes whose `I` column is `req` (the `idempotencyRequired` set); a missing or reused `X-Idempotency-Key` is rejected with 422.
2. **DEPRECATED ROUTES** — routes that emit `Sunset` / `Deprecation` headers (none currently registered).
3. **PERMISSION CODES REFERENCE** — every permission string grouped by domain, **auto-derived from the `*.permissions.ts` constants**. Because it reads the constants (not a hand-curated list), newly added codes such as `upload:manage` appear automatically.

## Output

`pnpm routes:catalog` writes the output artifact (implemented in `src/scripts/codegen/generate-route-catalog.ts`):

- `docs/routes.txt` — human-readable catalog (checked into version control)

`pnpm routes:catalog:check` fails if `docs/routes.txt` is out of sync with route sources.

Related gates that keep the annotation columns honest:

- `pnpm validate:route-success-statuses` — the declared `S` column (`route-success-statuses.json`) matches `docs/routes.txt`.
- `pnpm validate:route-organization-scope` — the `O` column side-table (`route-organization-scope.json`) matches `docs/routes.txt`.
- `pnpm validate:route-schema-docs` — every route declares a `schema` `summary` / `description` / `tags` block.

## Follow-up (same PR)

After updating `docs/routes.txt`:

1. **be-route-schema-doc-guard** — add/update `schema: { summary, description, tags }` on the Fastify route registration. (The legacy **be-openapi-route-sync** skill is preserved for compatibility but the canonical authoring is be-route-schema-doc-guard.)
2. **be-openapi-multilingual** — add tag translations to all locales when a new tag is introduced; run `pnpm docs:generate:multilang`.
3. **be-seed-maintainer** — align seeds when routes were added or removed.
4. **be-test-generator** — domain e2e tests for new/changed routes.
5. **`pnpm tsdoc:check`** — confirm coverage budget not regressed by any new exports added with the routes.

---

**Related skills:** [be-route-schema-doc-guard](../be-route-schema-doc-guard/SKILL.md) · [be-api-contract-guard](../be-api-contract-guard/SKILL.md) · [be-seed-maintainer](../be-seed-maintainer/SKILL.md)
