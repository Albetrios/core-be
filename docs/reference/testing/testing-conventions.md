# Testing conventions (core-be)

Vitest, `fastify.inject()`, domain co-located tests, and naming tiers. For manual smoke after seed, see [api-testing.md](../../getting-started/api-testing.md).

---

## HTTP test stack

- **Vitest** — runner, assertions, coverage (`pnpm test`, `pnpm test:unit`, `pnpm test:e2e`, …)
- **`fastify.inject()`** — in-process HTTP via `injectRoute` / `injectAuthenticated` in `src/tests/helpers/test-http-inject.helper.ts` and `createTestApp()` in `src/tests/helpers/test-app.ts`
- **Smoke** — native `fetch()` against `SMOKE_BASE_URL` under `src/tests/smoke/*.smoke.test.ts`

Use `injectWithCookies` when session cookies matter.

**Mutation testing:** Stryker on auth/billing/tenancy services and security middleware — see [mutation-testing.md](mutation-testing.md). Run `pnpm test:mutation` locally before changing `stryker.config.json` thresholds.

**Property-based tests:** `*.property.unit.test.ts` under `src/tests/unit/validators/` and `src/tests/unit/property-based/` using [fast-check](https://fast-check.dev/). Run `pnpm test:property` (CI uses `FAST_CHECK_NUM_RUNS=50` and shared shrink budget via `propertyAssertOptions()` in `src/tests/helpers/fast-check-property.util.ts`).

---

## Tests vs routes

**With routes vs without routes decides HTTP registration only — not test placement.**

| Sub-domain kind    | Routes                      | Tests live at                              |
| ------------------ | --------------------------- | ------------------------------------------ |
| **With routes**    | Own `<resource>.routes.ts`  | `sub-domains/<resource>/__tests__/`        |
| **Without routes** | Parent/domain `*.routes.ts` | `sub-domains/<resource>/__tests__/` (same) |

Bundled suites (`billing/__tests__/integration/`) and parent **e2e** (`tenancy/__tests__/e2e/`) are additive — they do not replace sub-domain `__tests__/`.

---

## Test layout

Vitest tests live under `src/` in **two places only**.

### 1. `src/tests/` — cross-cutting

```text
src/tests/
  helpers/          # test-app, test-auth, test-database, test-organization
  factories/        # shared factories
  unit/             # shared utils, errors, event-bus only
  integration/      # cross-domain HTTP contracts
  security/         # auth, CORS, JWT, RLS, rate limits
  performance/      # N+1, concurrency
  global/           # route catalog, domain consistency
  chaos/            # Toxiproxy (see chaos-testing.md)
  contract/         # outbound HTTP contracts
  smoke/            # deployed URL fetch tests
```

Do not put full domain route suites here.

### 2. `src/domains/<domain>/` — domain-owned

Never place `*.test.ts` directly under `__tests__/` — use `integration/`, `unit/`, or `e2e/`.

```text
src/domains/<domain>/__tests__/
  integration/<domain>.integration.test.ts
  e2e/<flow>.e2e.test.ts
  unit/
  factories/

src/domains/<domain>/sub-domains/<resource>/__tests__/
  integration/<resource>.integration.test.ts
  unit/<resource>.<layer>.unit.test.ts
  unit/events/                    # handlers, emit, worker mocks
```

### k6 load

`src/tests/load/k6/` (`.js` only). See [load-testing.md](../testing/load-testing.md).

---

## Testing pyramid

| Layer                  | Command                 | Use for                                   |
| ---------------------- | ----------------------- | ----------------------------------------- |
| **Unit**               | `pnpm test:unit`        | Pure logic, no DB/Redis                   |
| **Integration**        | `pnpm test:integration` | Cross-domain in-process contracts         |
| **Domain integration** | `pnpm test:e2e`         | `src/domains/**/__tests__/integration/**` |
| **Security**           | `pnpm test:security`    | Auth, CORS, JWT, RLS                      |
| **RLS application role** | `pnpm test:rls-role`  | The e2e + integration lanes, on an RLS-subject connection |
| **Performance**        | `pnpm test:performance` | N+1, concurrency                          |
| **Load**               | `pnpm load:*`           | k6 against running API                    |
| **Smoke**              | `pnpm test:api-smoke`   | Live API after seed                       |
| **Global**             | `pnpm test:global`      | Route catalog, consistency                |
| **Coverage**           | `pnpm test:coverage`    | Full suite + Stage 5 thresholds           |

### Why `pnpm test:rls-role` exists

Every other lane connects with a role that **bypasses** row-level security: Compose creates
`POSTGRES_USER: core` as a superuser, and the local operator role carries `rolbypassrls`. So a
path that reaches a FORCE RLS table **without a database context** matches no policy arm, reads
zero rows, and reports success — and looks green everywhere it is tested. That is not
hypothetical: organization and account deletion tombstoned no uploads for months that way.

The `RLS security (non-superuser)` job covers the other half. It asserts what the *policies*
permit, using helpers that opt into `core_be_app` per statement. What it cannot see is whether
the *application* obeys them, because the connection underneath is still the superuser.

`pnpm test:rls-role` opens the pool under test as `core_be_app` for the whole connection, so the
role applies to every statement — including ones inside the application's own transactions.

**Fixtures use the operator connection.** `src/tests/helpers/operator-database.ts` exists
because the harness does things the application never does: `TRUNCATE`ing every table between
suites, and seeding deliberately cross-tenant rows. Without the split the suites die on
`permission denied for table users` inside `cleanupDatabase` before asserting anything. The two
root factories (`user.factory.ts`, `organization.factory.ts`) deliberately do **not** use it —
they insert through the same context the application uses, because "can this row be created the
way production creates it" is worth asserting for the two tables every other fixture hangs off.

A test that passes normally and fails under this runner is depending on an RLS bypass — either
the code is missing a context, or the fixture is writing somewhere it should not. Both are worth
knowing. When it is the fixture, the symptom is a silent zero-row write, which reads as an
application bug: a soft-delete that updated nothing made a switch-organization test look like an
authorization hole until the fixture was moved onto the operator connection.

`e2e` and `integration` are covered. `security` is deliberately not: its RLS suites switch roles
themselves — per statement into `core_be_app`, or into `core_be_owner` to run a migration the way
the migrator does — and a connection that already *is* `core_be_app` cannot `SET ROLE` to
anything else. That half belongs to the `RLS security (non-superuser)` job.

```bash
pnpm test:rls-role
```

---

## Filename suffixes (CI: `pnpm validate:test-naming`)

| Suffix                  | Example                               |
| ----------------------- | ------------------------------------- |
| `*.unit.test.ts`        | `subscription.validator.unit.test.ts` |
| `*.integration.test.ts` | `auth.integration.test.ts`            |
| `*.e2e.test.ts`         | `email-login-flow.e2e.test.ts`        |
| `*.smoke.test.ts`       | `health.smoke.test.ts`                |

---

## API version in tests (CI: `pnpm validate:test-api-prefix`)

Vitest `inject()` URLs must not hardcode `/api/v1/` (or any `/api/vN/`). Use `testApiPath()` from `src/tests/helpers/test-api-prefix.helper.ts`, which builds paths from `buildPublicApiPrefix()` / `PUBLIC_API_VERSION_SEGMENT_V1` (same as production routing).

| Location                                                    | Literal `/api/v1/...`                    |
| ----------------------------------------------------------- | ---------------------------------------- |
| `inject({ url: ... })` and inject helpers                   | **No** — use `testApiPath('/users/me')`  |
| `describe` / `it` titles                                    | **Yes** — labels only                    |
| Route registration in unit tests (`app.get('/api/v1/...')`) | **Yes** — mirrors real plugin paths      |
| Smoke `fetch()` / manual curl in docs                       | **Yes** — external callers use full URLs |

```typescript
import { testApiPath } from "@/tests/helpers/test-api-prefix.helper.js";

await injectAuthenticated(app, {
  method: "GET",
  url: testApiPath(
    `/tenancy/organizations/${organizationPublicId}/memberships`,
  ),
  token,
  organizationPublicId,
});
```

See also [api-versioning.md](../api/api-versioning.md).

---

## What to unit-test vs not

### Always unit-test when adding/changing

| Artifact           | Location                               |
| ------------------ | -------------------------------------- |
| `*.validator.ts`   | Domain or sub-domain `__tests__/unit/` |
| `*.serializer.ts`  | Same                                   |
| `shared/utils/**`  | `src/tests/unit/utils/`                |
| `shared/errors/**` | `src/tests/unit/errors/`               |

### Prefer integration (not unit) for

| Artifact     | Why                    |
| ------------ | ---------------------- |
| Services     | DB, RLS, cross-domain  |
| Repositories | Drizzle + Postgres     |
| Controllers  | Covered by route tests |

### Workers

- **Unit**: extracted pure logic only (`__tests__/unit/events/worker/*.worker.unit.test.ts`)
- **Integration**: optional with test DB for critical jobs (`__tests__/integration/worker/`)
- **Concurrency / exactly-once**: cross-cutting race suite at `src/tests/integration/worker-race/*.integration.test.ts` (processor races, atomic claim races, stale-state reclaim; stripe-webhook, webhook-delivery, mail) — real Postgres; run with `pnpm test:integration` (serial workers — do not colocate DB race tests under `*.unit.test.ts`)
- Do not unit-test BullMQ wiring alone
- **Coverage**: worker processors are included in `pnpm test:coverage` when they live under `src/domains/**/workers/`; prioritize branch coverage on organization scoping and retry/DLQ paths over line coverage on queue registration boilerplate

---

## Domain integration test steps

1. Read the routes file — endpoints, middleware, access control.
2. `beforeAll`: `createTestApp()`; `afterAll`: `await app.close()`.
3. `beforeEach`: `cleanupDatabase()`; seed permissions if needed.
4. Per route: 401, 403 (if gated), 200 (204 for DELETE), 400 validation.
5. Run targeted `pnpm test:*`; stop `pnpm dev` on shared DB before `pnpm test:e2e`.

---

## Vitest projects

All tiers share one root **`vitest.config.ts`**. Named projects live in **`tooling/vitest/projects.ts`**. Scripts filter with **`--project <name>`** (for example `default`, `unit`, `e2e`, `contract`, `chaos`). Default **`pnpm test`** runs the **`default`** project only (excludes contract, chaos, and smoke).

### Run one database suite at a time

`fileParallelism: false` on the database-backed projects (`unit-db`, `e2e`, `integration`,
`security`, `performance`, `smoke`) serialises files **within** a run — it says nothing about two
runs. Start a second one against the same Postgres and each will `TRUNCATE ... RESTART IDENTITY`
between the other's fixture inserts.

The result does not look like what it is. You get a foreign-key violation (SQLSTATE 23503) inside
some unrelated suite, which reads as a regression in the code under test, plus a wall clock several
times the usual one. It has cost more than one debugging round.

`src/tests/global-setup.ts` now claims a lock keyed on `DATABASE_URL`, so the second run **fails
immediately** with the holder's pid and command instead of producing a confusing result. A crashed
run's lock is taken over automatically (dead pid), and two runs against two different databases do
not block each other. If a suite refuses to start and the named process is genuinely gone, delete
the lock file the message points at.

### What global setup prepares

Before any database-backed suite, `src/tests/global-setup.ts` mirrors the deploy sequence
(`pnpm db:migrate` → `pnpm db:seed`, see `reusable-railway-deploy.yml`): it takes the lock above,
runs `pnpm db:migrate`, and then seeds the **permission catalog** (`tenancy.permissions`) with the
reference seeder. The catalog is reference data, not a migration, so without that step it existed
only after some suite happened to call `seedAllPermissions()` — and every login that provisions a
personal organization depended on test order. `cleanupDatabase()` truncates everything **except**
`permissions` and `schema_migrations`, so the catalog seeded once stays in place for the whole run.
A suite that empties the catalog on purpose must restore it (`seedAllPermissions()` in `afterEach`).

---

## Coverage reports

| Rule       | Detail                                       |
| ---------- | -------------------------------------------- |
| Output     | Repo root `coverage/` (gitignored)           |
| Created by | `pnpm test:coverage` only                    |
| Browse     | open `coverage/lcov-report/index.html`       |
| Thresholds | Stage 5 in `vitest.config.ts`; see AGENTS.md |

---

## Templates

### Domain route integration (`fastify.inject`)

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestApp } from "@/tests/helpers/test-app.js";
import { injectAuthenticated } from "@/tests/helpers/test-http-inject.helper.js";
import { cleanupDatabase } from "@/tests/helpers/test-database.js";
import type { FastifyInstance } from "fastify";

describe("<Domain> — integration", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it("returns 401 without auth", async () => {
    const response = await injectAuthenticated(app, {
      method: "GET",
      url: "/api/v1/...",
      token: "", // or omit auth per helper API
    });
    expect(response.statusCode).toBe(401);
  });
});
```

### Validator unit

```typescript
import { describe, expect, it } from "vitest";
import { ValidationError } from "@/shared/errors/index.js";
import { validateExample } from "@/domains/<domain>/sub-domains/<resource>/<resource>.validator.js";

describe("example.validator", () => {
  it("accepts valid input", () => {
    expect(validateExample({/* valid */})).toMatchObject({/* expected */});
  });

  it("throws ValidationError for invalid input", () => {
    expect(() => validateExample({})).toThrow(ValidationError);
  });
});
```

---

## Anti-patterns

- Domain route tests in `src/tests/` (belong under `src/domains/.../__tests__/integration/`)
- `*.test.ts` directly under `__tests__/` (use `integration/` or `unit/`)
- Validator unit tests in `src/tests/unit/` for domain validators
- Two domains in one `__tests__/` folder
- Unit-testing services with real database or Redis
- `pnpm test:e2e` while `pnpm dev` uses the same DB
- Vitest files under `src/tests/load/` (k6-only)
- Expecting `coverage/` after `pnpm test` (use `pnpm test:coverage`)

---

## Related

- [SETUP.md](../../../SETUP.md) § 4 Testing → **Running a live server for a frontend / loopback E2E suite** — the `.env.development` env a real `pnpm dev` server needs when an external suite (e.g. core-fe Playwright) hits it over loopback (`RATE_LIMIT_RELAXED_CAPS`, `DATABASE_TLS_ENFORCED`, `DATABASE_RLS_SAFETY_ENFORCED`, organization-mode flags). In-process Vitest tiers and CI self-configure and need none of it.
- [sub-domains-layout.md](../architecture/sub-domains-layout.md) — test placement vs with/without routes
- [api-testing.md](../../getting-started/api-testing.md) — manual smoke checklist
- [documentation-system.md](../architecture/documentation-system.md) — layered docs ownership map
- `src/tests/<suite>/<suite>.overview.md` — per-suite scope (unit, integration, e2e, global, chaos, contract, performance, security, smoke, load, bench)
- `.cursor/skills/test-generator/SKILL.md` — orchestration checklist
