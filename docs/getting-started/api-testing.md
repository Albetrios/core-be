# API testing (local, after full seed)

Manual and scripted checks against a running API (`pnpm dev` + `pnpm dev:worker`) with data from `pnpm db:seed:full`.

## Prerequisites

```bash
docker compose up -d
pnpm db:migrate
TEST_PASSWORD=DemoPassword123! pnpm db:seed:full   # fixed demo password
pnpm db:seed:sync-demo   # sync admin permissions (after permission changes)
pnpm dev              # terminal 1 — http://localhost:3000
pnpm dev:worker       # terminal 2
```

Set in `.env` for a repeatable password on every seed:

```bash
TEST_PASSWORD=DemoPassword123!
```

## Seeded credentials

| Field                  | Value                                               |
| ---------------------- | --------------------------------------------------- |
| Email                  | `demo@example.com`                                  |
| Password               | `DemoPassword123!` (or `TEST_PASSWORD` from `.env`) |
| Demo organization slug | `demo-org`                                          |
| Demo organization name | Demo Organization                                   |

After seed, note the resource ids from logs or fetch them via the flows below. Every id is prefixed by entity (`org_…`, `usr_…`, `pln_…`):

- Organization id: use `GET /api/v1/tenancy/organizations` (first item) — needed only to **switch** the active organization (see below), not as a path/header on every call
- User id: use `GET /api/v1/users/me`

Permissions, plans, demo organization, admin role, membership, an extra organization/user, and one pending invitation are created. See `src/scripts/seed/full.ts`.

## Headers (authenticated routes)

| Header            | Value                                |
| ----------------- | ------------------------------------ |
| `Authorization`   | `Bearer <access_token>` from login   |
| `Content-Type`    | `application/json`                   |
| `Accept-Language` | `en` or `es` (optional)              |

### Active organization (token `org` claim)

Org-scoped routes are **flat** — there is no per-organization path segment and no
`X-Organization-Id` header on organization-scoped calls. The active organization rides the signed `organizationPublicId`
claim inside the access token, so the active-organization resource is singular: `/api/v1/tenancy/organization`
(sub-resources nest under it). The claim is **scope, not authority** — membership and RLS are
re-checked per request.

| Scenario                                | Effect                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Org-scoped route, valid `org` claim** | Resolved to the `org_<21 chars>` id; Postgres RLS session variable is set for the request. No header or path id needed.        |
| **Caller is not a member of the claim** | Membership recheck fails → `403` (the claim cannot grant access to an organization the caller does not belong to).                      |
| **Switching the active organization**            | Call a switch endpoint (below) to re-mint the access token with a new `org` claim; the old token fails immediately after.      |

Switch the active organization (each re-mints the access token):

```bash
# Switch to your personal organization (no body)
curl -s -X POST http://localhost:3000/api/v1/auth/switch-to-personal \
  -H "Authorization: Bearer $TOKEN" | jq .

# Switch to a specific team organization
curl -s -X POST http://localhost:3000/api/v1/auth/switch-to-organization \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"organization_id\":\"$ORG_ID\"}" | jq -r '.data.access_token'
```

> `X-Organization-Id` is **legacy** and used only by the upload domain; organization-scoped tenancy,
> billing, and notify routes read the active organization from the token claim. Status policy reference:
> [response-codes.md](../reference/api/response-codes.md).

## Manual test checklist

### 1. Health (no auth)

| #   | Method | Path       | Expected                                                                                               |
| --- | ------ | ---------- | ------------------------------------------------------------------------------------------------------ |
| 1.1 | GET    | `/livez`   | 200, `{"status":"ok"}` (liveness — no dependency probes)                                               |
| 1.2 | GET    | `/readyz`  | 200, deps connected; optional `migration_version`, `mail_outbox_pending`, `dlq_depth`, `worker_queues` |

Worker replicas expose the same `/livez` and `/readyz` probes on `WORKER_HEALTH_PORT` (default `9090`).

Full semantics and probe matrix: [health-checks.md](../reference/reliability/health-checks.md).

```bash
curl -sS -w '\nHTTP %{http_code}\n' http://localhost:3000/livez
curl -sS -w '\nHTTP %{http_code}\n' http://localhost:3000/readyz
```

### 2. Auth — login and token

| #   | Method | Path                                  | Expected                 |
| --- | ------ | ------------------------------------- | ------------------------ |
| 2.1 | POST   | `/api/v1/auth/login`                  | 200, `data.access_token` |
| 2.2 | POST   | `/api/v1/auth/login` (wrong password) | 401                      |
| 2.3 | GET    | `/api/v1/users/me` (no token)         | 401                      |

```bash
# Login — save token
LOGIN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"DemoPassword123!"}')
echo "$LOGIN" | jq .
export TOKEN=$(echo "$LOGIN" | jq -r '.data.access_token')
```

### 3. User profile

| #   | Method | Path                                        | Expected                      |
| --- | ------ | ------------------------------------------- | ----------------------------- |
| 3.1 | GET    | `/api/v1/users/me`                          | 200, email `demo@example.com` |
| 3.2 | GET    | `/api/v1/users/me/settings`                 | 200                           |
| 3.3 | GET    | `/api/v1/users/me/notification-preferences` | 200                           |

```bash
curl -s http://localhost:3000/api/v1/users/me \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### 4. Tenancy — organizations

The active organization comes from the token's `org` claim. Account-level routes stay plural
(`/tenancy/organizations`, list/create); the active-organization resource is singular
(`/tenancy/organization`, with sub-resources nested under it).

| #   | Method | Path                                          | Expected                              |
| --- | ------ | --------------------------------------------- | ------------------------------------- |
| 4.1 | GET    | `/api/v1/tenancy/organizations`               | 200, includes demo organization (account list) |
| 4.2 | GET    | `/api/v1/tenancy/organization`                | 200, the active organization from the claim    |
| 4.3 | GET    | `/api/v1/tenancy/organization/memberships`    | 200                                   |
| 4.4 | GET    | `/api/v1/tenancy/organization/roles`          | 200, includes Admin                   |

```bash
ORGS=$(curl -s http://localhost:3000/api/v1/tenancy/organizations \
  -H "Authorization: Bearer $TOKEN")
echo "$ORGS" | jq .
export ORG_ID=$(echo "$ORGS" | jq -r '.data[0].id')

# The active organization is whatever the token's `org` claim points to — read it directly,
# no path id or header. Switch first (see above) if you need a different active organization.
curl -s http://localhost:3000/api/v1/tenancy/organization \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### 5. Billing (active-organization context)

Billing routes are top-level under the token claim — the active organization comes from `org`, not the path.

| #   | Method | Path                                  | Expected           |
| --- | ------ | ------------------------------------- | ------------------ |
| 5.1 | GET    | `/api/v1/billing/plans`               | 200 (seeded plans) |
| 5.2 | GET    | `/api/v1/billing/subscriptions`       | 200 (may be empty) |
| 5.3 | GET    | `/api/v1/billing/entitlements`        | 200                |

```bash
curl -s http://localhost:3000/api/v1/billing/subscriptions \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### 6. Notify (active-organization context)

| #   | Method | Path                          | Expected                 |
| --- | ------ | ----------------------------- | ------------------------ |
| 6.1 | GET    | `/api/v1/notify/webhooks`     | 200 (list, may be empty) |

### 7. Negative cases

| #   | Method | Path                                                                | Expected |
| --- | ------ | ------------------------------------------------------------------- | -------- |
| 7.1 | GET    | `/api/v1/tenancy/organization/memberships` without a Bearer token   | 401      |
| 7.2 | POST   | `/api/v1/auth/switch-to-organization` with an organization you don't belong to | 403    |
| 7.3 | POST   | `/api/v1/auth/login` with `{}` body                                 | 400      |

## Automated smoke test (all domains)

Runs health, auth, user, tenancy, billing, notify, and audit probes against a live server (39 checks). Does not replace Vitest integration tests.

### One-shot gate

Runs migrations, `pnpm db:seed`, `pnpm db:seed:full`, smoke tests, then `pnpm validate`. If nothing is listening on `BASE_URL` (default `http://localhost:3000`), it starts `pnpm dev` and `pnpm dev:worker` in the background, stops them after smoke, then runs validate. Requires Docker services up (`docker compose up -d`). Verbose API/worker logs: `VERIFY_BASE_VERBOSE=1`.

```bash
pnpm verify:base       # migrate → seeds → smoke → validate (starts dev + worker if not running)
pnpm test:api-smoke    # smoke only (server + seed must already be in place)
```

If organization-scoped routes return **403** after a permission seed change, run `pnpm db:seed:sync-demo` and retry.

Optional env: `BASE_URL`, `TEST_EMAIL`, `TEST_PASSWORD` (defaults match full seed).

**CI:** Every PR runs the same probes against ephemeral Postgres + Redis after migrate + full seed ([CI/CD and deployment](../deployment/ci-cd/cicd-and-deployment.md)).

**macOS:** GNU `timeout` is not installed by default; if you copy the CI readiness wait locally, use an `until curl …` loop with a deadline or `gtimeout` from Homebrew `coreutils`.

## Get token + organization for Postman / k6

```bash
pnpm tool:load-test-credentials
```

Exports `TEST_TOKEN` and `TEST_ORG_ID` for copy-paste.

## Vitest integration tests

Domain integration tests use an isolated DB per test (`cleanupDatabase` in `beforeEach`). They do **not** rely on full seed data.

```bash
pnpm test:e2e          # domain integration tests
pnpm test              # full suite (needs test DB)
```

Generated API reference: `pnpm docs:all` → `docs/openapi/openapi.json`, `docs/postman-collection.json`.

Route list: `docs/routes.txt` (`pnpm routes:catalog`).

## Related docs

- [setup.md](setup.md) — local setup and seed commands
- [../reference/testing/load-testing.md](../reference/testing/load-testing.md) — k6 load tests with seeded user
