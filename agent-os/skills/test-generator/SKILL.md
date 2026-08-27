---
name: test-generator
description: Decides which test layer to add and writes tests following core-be conventions — unit for pure layers (validators, serializers, shared/utils, errors) and domain e2e via fastify.inject. Use when adding or changing routes, controllers, services, workers, validators, or serializers, after creating a domain/sub-domain, or when tests are missing.
trigger: src/domains/**/*.validator.ts, src/domains/**/*.serializer.ts
triggerNote: Pure-layer units + domain e2e per the testing pyramid
indexNote: pick the test layer + write unit / domain-e2e per the testing pyramid
---

# Test generator (core-be)

## Purpose

Decide **which test layer** to add or update when a feature is created or changed, then implement tests following core-be conventions.

Covers:

- **Unit** — validators, serializers, `shared/utils`, errors (pure logic, no DB)
- **Domain (e2e)** — Fastify inject route tests (401, 403, 200/204, 400)
- **Integration / security / perf / load / smoke** — when appropriate

## When to Use

Use this skill whenever a **new feature** is added or an **existing feature** is updated:

- New or changed routes, controllers, services, workers, validators, serializers, or `shared/utils`
- New sub-domain or cross-cutting HTTP behavior
- Permission, auth, or validation rule changes
- After creating a new domain or sub-domain
- When tests are missing for existing routes or pure layers

Triggered by `testing-conventions.mdc` when test-related or pure-layer files change.

## HTTP test stack (Vitest + fastify.inject)

- **Vitest** — runner, assertions, coverage (`pnpm test`, `pnpm test:unit`, `pnpm test:e2e`, …)
- **fastify.inject()** — in-process HTTP via helpers in `src/tests/helpers/test-http-inject.helper.ts` (`createTestApp()` in `src/tests/helpers/test-app.ts`)

Use `injectAuthenticated`, `injectUnauthenticated`, `injectAuthenticatedOrganizationMutation`, or `injectWithCookies` (for session cookies) from `src/tests/helpers/test-http-inject.helper.ts`.

## Test layout (non-negotiable)

Vitest tests live under `src/` in **two places only**. Do not mix responsibilities.

### 1. `src/tests/` — common / cross-cutting tests

Use for infrastructure and behavior that is **not owned by a single domain**:

```text
src/tests/
  helpers/          # test-app, test-auth, test-database, test-organization
  factories/        # shared factories (user, organization, plan, …)
  unit/             # shared utils, errors, event-bus, permission-cache only
    utils/
    errors/
    services/
  integration/      # cross-domain HTTP contracts (health, api-contract, …)
  security/         # auth, CORS, JWT, RLS, rate limits, helmet, idempotency
  performance/      # N+1, concurrency
  global/           # route catalog, domain consistency, system validation
```

**Do not** add domain route suites (full auth/tenancy/billing API coverage) under `src/tests/`.

### 2. `src/domains/<domain>/` — domain-specific tests

Each domain has a root `__tests__/` folder. **Sub-domains** (under `sub-domains/<resource>/`) hold co-located unit, event-handler, and nested e2e tests.

```text
src/domains/<domain>/__tests__/
  <domain>.test.ts              # bundled domain inject suite (auth, billing, notify, user, tenancy)
  factories/                    # domain-wide test helpers (e.g. tenancy permission.factory.ts)
  unit/                         # domain-level validators/serializers + cross-sub-domain policy scans

src/domains/<domain>/sub-domains/<resource>/     # top-level sub-domain
  __tests__/
    unit/
    <resource>.test.ts          # optional dedicated e2e
  events/
    __tests__/

src/domains/<domain>/sub-domains/<parent>/<nested>/   # nested sub-domain (aggregate child)
  __tests__/
    unit/                       # e.g. organization-api-key.validator.unit.test.ts
    <nested>.test.ts            # optional e2e (organization-api-key.test.ts)
  events/
    __tests__/                  # when nested resource emits/handles events
```

Examples: `auth/__tests__/auth.test.ts` (bundled e2e), `billing/sub-domains/subscription/__tests__/unit/subscription.validator.unit.test.ts`, `notify/sub-domains/webhook/webhook-event/` (nested), `tenancy/sub-domains/organization/organization-api-key/__tests__/organization-api-key.test.ts`, `auth/sub-domains/auth-method/__tests__/unit/events/auth-method.event-handlers.unit.test.ts`, `tenancy/__tests__/factories/permission.factory.ts`.

**Bundled domain e2e (intentional):** `auth.test.ts`, `billing.test.ts`, `notify.test.ts`, `user.test.ts` cover many sub-domain routes in one file. Billing sub-domains without dedicated e2e (plan, stripe-webhook) are covered there; add sub-domain unit tests for validators/serializers instead of splitting e2e unless routes are extracted.

**Notification routes:** covered by `notify/__tests__/notify.test.ts`; add `notify/sub-domains/notification/__tests__/unit/` for serializers only unless notification routes are split to a dedicated e2e file.

### Where to put new tests

| What you changed                                      | Put tests in                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Domain routes (bundled multi-resource domain)         | `src/domains/<domain>/__tests__/<domain>.test.ts`                             |
| Sub-domain routes (dedicated e2e, often nested)       | `src/domains/<domain>/sub-domains/<parent>/<child>/__tests__/<child>.test.ts` |
| `shared/utils`, `shared/errors`, middleware, security | `src/tests/unit/`, `src/tests/security/`, etc.                                |
| Validator/serializer (top-level sub-domain)           | `src/domains/<domain>/sub-domains/<resource>/__tests__/unit/`                 |
| Validator/serializer (nested sub-domain)              | `src/domains/<domain>/sub-domains/<parent>/<nested>/__tests__/unit/`          |
| Domain-level validator (auth.login, user profile)     | `src/domains/<domain>/__tests__/unit/`                                        |
| Event handlers / emit helpers                         | `src/domains/<domain>/sub-domains/<resource>/__tests__/unit/events/`          |
| Cross-sub-domain policy scan (ledger immutability)    | `src/domains/<domain>/__tests__/unit/` with file comment                      |
| Shared tenancy permission test data                   | `@/domains/tenancy/__tests__/factories/permission.factory.js`                 |
| Cross-domain flow (health, multi-domain contract)     | `src/tests/integration/`                                                      |

### k6 load (`src/tests/load/`)

k6 scenarios and helpers live in `src/tests/load/k6/` (`.js` files, not Vitest). Run via `pnpm load:*`.

## Testing pyramid (core-be)

| Layer                 | Command                                            | Use for                                                                                   |
| --------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Unit**              | `pnpm test:unit`                                   | Pure logic, no DB/Redis                                                                   |
| **Integration**       | `pnpm test:integration`                            | In-process app, focused HTTP contracts                                                    |
| **Domain (e2e)**      | `pnpm test:e2e`                                    | Domain route tests + DB only (excludes `__tests__/unit/`)                                 |
| **Security**          | `pnpm test:security`                               | Auth, CORS, JWT, RLS, rate limits                                                         |
| **Performance**       | `pnpm test:performance`                            | N+1, concurrency                                                                          |
| **Load**              | `pnpm load:health` (etc.)                          | k6 against **running** API + seed                                                         |
| **Smoke**             | `pnpm test:api-smoke` · `pnpm verify:base`         | Live API after seeds; `verify:base` runs migrate → minimal + full seed → smoke → validate |
| **Global regression** | `pnpm test:global` (alias: `pnpm test:regression`) | Route catalog, domain consistency                                                         |
| **Unit (DB-bound)**   | `pnpm test:unit-db`                                | DB-bound unit tests (`*.db.unit.test.ts`) — repositories and DB-touching unit specs       |
| **Property**          | `pnpm test:property`                               | Fast-check property tests (`*.property.unit.test.ts`)                                     |
| **Full CI gate**      | `pnpm test`                                        | Runs fast projects (unit, property, global) and DB-bound projects (unit-db, e2e, integration, security, performance) in two parallel groups via `run-parallel.ts`. **Excludes** contract, chaos, smoke, load, and bench tests. |

## What to unit-test vs not (by design)

### Always unit-test when you add or change

| Artifact           | Location for tests                                                               | Cases to include                                                    |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `*.validator.ts`   | Domain `__tests__/unit/` or `sub-domains/.../__tests__/unit/` (including nested) | Happy path, `ValidationError`, `.strict()` unknown keys, boundaries |
| `*.serializer.ts`  | Same as validators                                                               | Field mapping, ISO dates, nullables                                 |
| `shared/utils/**`  | `src/tests/unit/utils/`                                                          | Edge cases; mock DNS/Redis/auth deps when needed                    |
| `shared/errors/**` | `src/tests/unit/errors/`                                                         | Status codes, `messageKey`, `errors[]` / `details`                  |

### Prefer domain / integration tests (not unit)

| Artifact         | Why                          | Where                             |
| ---------------- | ---------------------------- | --------------------------------- |
| **Services**     | DB, RLS, cross-domain        | `src/domains/<domain>/__tests__/` |
| **Repositories** | Drizzle + Postgres           | Same                              |
| **Controllers**  | Thin; covered by route tests | Same                              |

### Workers (e.g. audit retention)

- **Unit**: only extracted pure logic (cutoff date, batch size, idempotency)
- **Integration**: optional one test with test DB for critical jobs
- Do **not** unit-test BullMQ wiring alone

### Out of unit scope unless justified

| Area                          | Default                                          | Add tests only when                                                  |
| ----------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| **JWT RS256**                 | HS256 in unit tests (`JWT_SECRET` in test setup) | Prod/CI needs RS256 → one sign/verify smoke with test key pair in CI |
| **Logger** (`logger.util.ts`) | Skip                                             | Custom redaction, PII rules, or non-default serializers              |
| **Pass-through serializers**  | Smoke only                                       | API contract or shape regression risk                                |

## Checklist: new or updated feature

### 1. Pure layers (unit)

- [ ] Suite touches services that enter database contexts → mock the context module with
      `mockDatabaseContexts(actual)` from `@/tests/helpers/database-context-mock.helper.js`
      (stubs ALL three wrappers — a partial `...actual` spread leaves siblings REAL and
      opens Postgres, which CI's unit lane does not have)
- [ ] Controller suite builds fake requests → wrap the factory return in
      `attachPrincipalScopeGetters(...)` from
      `@/tests/helpers/principal-scope-getters.helper.js` so `request.principalScope`
      exercises the REAL request minters
- [ ] New/changed **validator** → unit tests under `src/domains/<domain>/__tests__/unit/` (or sub-domain `__tests__/unit/`)
- [ ] New/changed **serializer** → same layout as validators
- [ ] New/changed **shared util** → unit tests under `src/tests/unit/utils/`
- [ ] New/changed **error class** → unit tests under `src/tests/unit/errors/`

### 2. HTTP / domain (e2e)

- [ ] New/changed **route** → domain test file (see steps below)
- [ ] **401** without token, **403** without permission (if gated), **200** success (**204** for DELETE), **400** invalid body
- [ ] New **permission** → align seeds (`seed-maintainer`) and test with/without permission
- [ ] Run e2e with dev server **stopped** on shared DB (avoid deadlocks with `pnpm dev`)

### 3. Cross-cutting

- [ ] Auth/security-sensitive → consider `src/tests/security/`
- [ ] High-traffic public route → `pnpm verify:base` or `pnpm test:api-smoke` after full seed

### 4. Commands before considering tests done

```bash
pnpm test:unit          # --project unit (common unit + all domain __tests__/unit)
pnpm test:integration   # src/tests/integration touched
pnpm test:e2e           # domain __tests__ touched (stop pnpm dev first)
pnpm test:security      # auth, middleware, RLS touched
```

## Domain integration test steps

1. **Read the domain routes file** — enumerate endpoints (method, path, middleware).
2. **Identify access control**:
   - Public (no `preHandler`)
   - Authenticated (`app.authenticate`)
   - Role-gated (`requireRole`)
   - Permission-gated (`requireOrganizationPermission`)
3. **Create or extend `__tests__/<domain>.test.ts`**:
   - `beforeAll`: `createTestApp()`
   - `afterAll`: `await app.close()`
   - `beforeEach`: `cleanupDatabase()`; seed permissions if needed
   - Per route: 401, 403 (if applicable), 200 (204 for DELETE), 400 validation
4. **Create domain factories** in `__tests__/factories/` if needed.
5. Run targeted commands from checklist above; run `pnpm typecheck`.

## Prerequisites (domain tests)

- Domain routes file exists (`<domain>.routes.ts`)
- Helpers: `src/tests/helpers/test-app.ts`, `test-auth.ts`, `test-database.ts`
- Factories: `src/tests/factories/` or domain `__tests__/factories/`

## Test file template (domain e2e)

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import type { FastifyInstance } from 'fastify';

describe('<Domain> Domain — Integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('should return 401 without authentication', async () => {
    const response = await injectUnauthenticated(app, { url: '/api/v1/<path>' });
    expect(response.statusCode).toBe(401);
  });

  // ... route tests with injectAuthenticated / injectAuthenticatedOrganizationMutation ...
});
```

## Unit test template (validator)

```typescript
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import { validateExample } from '@/domains/<domain>/example.validator.js';

describe('example.validator', () => {
  it('accepts valid input', () => {
    expect(validateExample({ /* valid */ })).toMatchObject({ /* expected */ });
  });

  it('throws ValidationError for invalid input', () => {
    expect(() => validateExample({})).toThrow(ValidationError);
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => validateExample({ /* valid */, extra: true })).toThrow(ValidationError);
  });
});
```

## Naming convention

- Domain e2e: `src/domains/<domain>/__tests__/<domain>.test.ts`
- Domain unit: `src/domains/<domain>/__tests__/unit/<resource>.validator.unit.test.ts` (or sub-domain path)
- Common unit util: `src/tests/unit/utils/<name>.util.test.ts`
- Domain factory: `src/domains/<domain>/__tests__/factories/<entity>.factory.ts`
- Shared factory: `src/tests/factories/<entity>.factory.ts`

## Anti-patterns

- Putting **domain route tests** in `src/tests/` (belongs in `src/domains/<domain>/__tests__/`)
- Putting **domain validator/serializer unit tests** in `src/tests/unit/` (belongs in domain `__tests__/unit/`)
- Mixing **two domains** in one `__tests__/` folder
- Duplicating the same behavior in unit **and** full e2e without reason
- Unit-testing services with real `database` or Redis
- Running `pnpm test:e2e` while `pnpm dev` uses the same DB
- Expecting `test:e2e` to run validator unit tests (use `pnpm test:unit`; e2e script excludes `__tests__/unit/`)
- Adding Vitest files under `src/tests/load/` (k6-only)
- Testing Pino/logger startup with no custom behavior
- Skipping unit tests when only validators/serializers changed (route-only mindset)

---

**Related skills:** [chaos-test-maintainer](../chaos-test-maintainer/SKILL.md) · [contract-test-maintainer](../contract-test-maintainer/SKILL.md)
