# Load testing

Load tests use [k6](https://k6.io/) and Autocannon. Keep this doc in sync with [src/tests/load/k6/README.md](../../../src/tests/load/k6/README.md).

**Test layout:** Vitest suites (unit, integration, e2e, security, performance) and k6 load assets live under `src/tests/`; domain route tests live under `src/domains/*/__tests__/`. k6 scenarios are in `src/tests/load/k6/` (not Vitest — run via `pnpm load:*`).

---

## Flow overview

```mermaid
flowchart TB
  subgraph prereq [Prerequisites]
    Server[Server + Postgres + Redis]
    k6_install[k6 installed]
  end

  subgraph quick [Quick commands]
    Health[pnpm load:health]
    Bench[pnpm test:bench]
  end

  subgraph full [Full confidence]
    Stress[pnpm load:stress]
    StressAPI[pnpm load:stress:api]
  end

  prereq --> quick
  prereq --> full
  full --> Scenarios[Scenarios: health, auth, daily-ops, billing, webhooks, admin]
```

Prerequisites → Quick (health, bench) vs Full confidence (stress, stress:api) → Scenarios.

---

## Nightly CI gate (GitHub Actions)

Workflow: [.github/workflows/scheduled-k6-load-slo.yml](../../../.github/workflows/scheduled-k6-load-slo.yml) (`Scheduled k6 API load & SLO`)

Runs **daily at 02:00 UTC** (`cron`) and **on demand** (`workflow_dispatch`). The job starts Postgres and Redis service containers, migrates, runs `pnpm db:seed:full` with `TEST_PASSWORD=DemoPassword123!` (matches the demo user), boots the API with `RATE_LIMIT_MAX=10000`, then runs k6.

| Role                 | Scenarios                                                                     | Job outcome                                                          |
| -------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Gate (must pass)** | `health-stress.js`, `api-stress.js`                                           | Workflow **fails** if any k6 threshold fails                         |
| **Informational**    | `auth-onboarding.js`, `daily-ops.js`, `billing.js`, `webhooks.js`, `admin.js` | `continue-on-error`; failures do not fail the workflow by themselves |

**SLO-style thresholds (k6):** Scenarios define `http_req_duration` percentiles on tagged requests and `http_req_failed` (see each file under `src/tests/load/k6/scenarios/`). The gate enforces:

- **Health stress**: `health/live` p(95)&lt;200ms, p(99)&lt;500ms; `health/ready` p(95)&lt;500ms, p(99)&lt;1000ms; global failure rate &lt;1%.
- **API stress**: Per-route p(95)&lt;500ms for users/me, organizations, notifications, unread-count, and the active-org memberships (`/tenancy/organization/memberships`); global p(95)&lt;500ms and failure rate &lt;1%.

Artifacts (`k6-*.json` summaries and `server.log`) are uploaded for 14 days. Optional email: configure `RESEND_API_KEY` and `LOAD_TEST_RESULT_EMAIL_TO` or `TEST_REPORT_EMAIL_TO`; the workflow invokes `pnpm tool:send-load-test-results-email` with `K6_USE_SUMMARIES=1` (reads gate `k6-*.json` files — no second k6 run).

**Reproduce locally:** `pnpm compose:up`, `pnpm db:migrate`, `TEST_PASSWORD=DemoPassword123! pnpm db:seed:full`, `pnpm dev:loadtest`, then `pnpm tool:load-test-credentials`, export `TEST_TOKEN` / `TEST_ORG_ID`, and run `pnpm load:stress` and `pnpm load:stress:api` (same thresholds as CI).

---

## Full confidence (recommended)

To gain confidence in the **whole system** (not just health endpoints), run both infrastructure stress and API stress:

1. **Health + infra stress** (no auth): `pnpm load:stress`
   - Hits `GET /livez` and `GET /readyz` with up to 100 VUs.

2. **API stress** (authenticated): set credentials, then run `pnpm load:stress:api`
   - Get credentials: `pnpm tool:load-test-credentials` (server up, `pnpm db:seed:full` done).
   - Export and run:

     ```bash
     export TEST_TOKEN="<paste from script>"
     export TEST_ORG_ID="<paste from script>"
     pnpm load:stress:api
     ```

   - Hits: `GET /api/v1/users/me`, `GET /api/v1/tenancy/organizations`, `GET /api/v1/notify/notifications`, `GET /api/v1/notify/notifications/unread-count`, `GET /api/v1/tenancy/organization/memberships` with up to 100 VUs. The active org rides the token's `org` claim, so `TEST_ORG_ID` scopes the token (via `switchToOrganization`) rather than appearing in the path.

3. **Optional — auth flow**: `pnpm load:auth`
   - Stresses login + profile + list orgs (ramping load profile; see thresholds in `src/tests/load/k6/scenarios/auth-onboarding.js`).

If **load:stress** and **load:stress:api** both pass, the system is under load-tested for both infra and main API paths.

### Failure rate and how to handle it

- **Health stress:** Failure rate is typically **0%** (no auth, no rate limit on health).
- **API stress:** You may see a **high failure rate (~95%+)** if the global **rate limit** is hit. The app uses `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS` (default **100 per 60 seconds per IP**). k6 runs from one IP with 100 VUs, so you can send thousands of requests per minute; after the first 100 in a window, the server returns **429 Too Many Requests**, which k6 counts as failed.

**How to handle:**

1. **For load-test runs only:** Start the server with a higher limit so API stress can complete without 429s:

   ```bash
   pnpm dev:loadtest
   ```

   (Or `RATE_LIMIT_MAX=10000 pnpm dev`.) Then run `pnpm load:stress:api` (with `TEST_TOKEN` and `TEST_ORG_ID`). Do not use a sky-high limit in production.

2. **In production:** Keep `RATE_LIMIT_MAX` at a level that protects the API (e.g. 100–500 per minute per IP, or use Redis-backed per-user limits). The 429 response is correct behavior when the limit is exceeded; clients should back off or use exponential backoff.

   **Per-route limits:** High-risk routes use tighter caps than the global limit (e.g. login, invitations, data export, webhook test delivery). Values live in [`src/shared/middlewares/rate-limit/rate-limit-presets.constants.ts`](../../../src/shared/middlewares/rate-limit/rate-limit-presets.constants.ts). k6 or scripts that hammer those paths may see 429 sooner than the global budget implies.

3. **Optional — longer-lived token for long runs:** JWT from login expires in 15 minutes. For runs under 15 minutes you don't need to change anything. For longer API stress runs, use a token with longer expiry (e.g. from `pnpm tool:admin-token` if your scenario allows admin role, or a dedicated load-test token with extended expiry).

## Interpreting results: co-located load generation

When k6 runs on the **same host** as the API (the common local setup), the load generator and the server compete for the same CPU cores. This caps measured throughput and inflates latency in a way that is **not** an application bottleneck:

- **Symptom:** authenticated-route throughput plateaus (e.g. a few hundred req/s) and server-side compute time (`Server-Timing: app;dur`, mirrored by k6's `http_req_duration`) climbs under high VUs — **even though** Postgres, Redis, the DB connection pool, the libuv threadpool, and the Node event loop all still show headroom.
- **Why:** with the cores saturated by k6 + the server + kernel networking (localhost / Docker-bridge softirq), the OS de-schedules the server mid-request, so its own wall-clock per request grows without any internal resource being saturated. Cached endpoints (`/livez`, `/readyz`) barely notice because their handlers are trivial; authenticated routes do more per-connection work and so reveal a lower co-located ceiling first.
- **Confirm it's the environment, not the app:** raise `DATABASE_POOL_MAX` and `UV_THREADPOOL_SIZE` — if throughput does not move, the pool and crypto/threadpool are not the limit. Compare `app;dur` at low vs high concurrency: if it is small at low load and balloons only under high VUs while infra stays idle, the cap is CPU contention from co-location.

**For true capacity numbers**, run k6 from a **separate host** (so the generator never steals the server's CPU), size the API box to **cores ≥ replicas (+~2 for OS/IO)**, scale processes with `cluster-run.mjs` / `DEPLOYMENT_API_REPLICA_COUNT`, and keep Postgres/Redis on low-latency links (not a localhost port-forward). Treat single-box numbers as **lower bounds and regression signals**, not absolute capacity.

## Load viewer (local)

`pnpm load:viewer` starts a recording reverse proxy on **:4985** that forwards to the API on
:3000 and serves a live dashboard of everything passing through it. Point a load run at :4985
instead of :3000 and each call appears as it happens, grouped per route.

```bash
pnpm load:viewer                 # proxy + dashboard on http://localhost:4985
BASE_URL=http://localhost:4985 VUS=50 k6 run src/tests/load/k6/scenarios/fe-user-journey.js
```

**Port 4985 is fixed and not configurable.** It sits beside the DB viewer's 4984 so the loopback
dev tools occupy one obvious band, and it is deliberately not read from the environment: a bare
`PORT` is the API server's own variable (env schema, default 3000), so a shell exporting it for
the API would silently move this proxy too. `LOAD_VIEWER_UPSTREAM` (default
`http://localhost:3000`) still points it at a different API when you need to.

Node built-ins only — no dependencies. Loopback development tool: it records full request and
response bodies in memory, so never point it at anything but a local API.

| Endpoint | Purpose |
| -------- | ------- |
| `/` | Dashboard — per-route calls, ok/error/429 counts, avg, p95, max, total time |
| `/__viewer/stream` | Server-sent events feed of calls as they land |
| `/__viewer/stats` | Per-route aggregates as JSON |
| `/__viewer/calls` | Recorded calls (`?limit=`) with headers and bodies |
| `/__viewer/clear` | `POST` — reset counters between runs |

Because it sits in the request path it adds a small amount of latency and a second event loop to the
same box; treat its timings as directionally accurate and compare monitor-to-monitor, not
monitor-to-direct.

## Trusting a result

A load-test number is only worth reporting once you know it reproduces. On a co-located single-box
setup this repo has measured a **2.07x spread between two runs of an identical configuration**
(2,697 ms vs 5,590 ms per journey). Any single-run comparison smaller than that is indistinguishable
from noise.

**Before reporting a before/after, satisfy all four:**

1. **Replicate each side at least twice.** A one-shot A/B has produced a confident 3.7x "improvement"
   here that disappeared entirely when the faster side was re-run — the first number was an outlier,
   not a result.
2. **Control for ordering.** Journeys that create rows (organizations, memberships, audit entries)
   leave the database bigger than they found it, so a later run is working against more data than an
   earlier one. Run the pair in both orders; if the effect survives the reversal it is real, and if it
   only appears in one order it was the data growth.
3. **Check the journey against what the client actually calls.** A step the real client never issues
   inflates the route it targets and adds load that does not exist in production. `POST
   /auth/switch-to-organization` returns the active-org context inline and core-fe writes it straight
   into its cache, so a `GET /auth/me/context` after a switch measures a request the app never makes.
4. **Hold the auth method constant, and know what it costs.** `POST /auth/login` verifies with
   argon2id — roughly 100 ms of deliberate CPU per call. Node runs one thread, so 50 concurrent
   password logins queue several seconds of CPU that inflates *every other route in the run* and can
   trip `overloadGuardMiddleware` into shedding 503s. A journey using password auth and one using
   email-code auth are not comparable, and the difference between them is not an application change.

**Diagnosing a failing journey**

| Symptom | Usual cause |
| ------- | ----------- |
| Login returns `401` for every pool user | Seed data is missing, not a broken feature — the anti-enumeration path returns an **identical** 401 for an unknown email as for a wrong code. Check `auth.users` before debugging the auth code. |
| Login returns `200` but the VU stops right after | The body is an `mfa_required` envelope with `mfa_session_token`, not an `access_token`. See the MFA note under [Obtaining credentials](#obtaining-credentials). |
| Every route inflates by a similar factor | Queueing on the single Node event loop, not a slow endpoint. Uniform inflation is the signature. |
| Only `/auth/refresh` fails, with 429 | `REFRESH_RATE_LIMIT` is a hardcoded 30/min **per IP** and does not honour `RATE_LIMIT_RELAXED_CAPS`, so every VU on one host shares one budget. The limiter working, not the endpoint failing. |

**Report the whole picture.** A journey-level "success rate" counts only VUs that completed *every*
step, so one rate-limited step at the end can read as a 6% success rate while all business routes were
100% healthy. Quote per-route results alongside it.

## Post-run settle check (drain + assert clean)

After a load (or e2e) batch, `pnpm load:settle-check` proves the async fabric finished every job the run started — nothing stuck in a queue, the event-bus / outbox side effects flushed, and nothing dead-lettered. Run it against the **same** API + worker the load test hit (workers must be running so the backlog can drain):

```bash
pnpm load:settle-check
```

It polls the throughput queues (`mail`, `webhook-delivery`, `notification`, `stripe-webhook`) until `waiting + active + delayed = 0` and the mail outbox has no pending rows, then asserts — once — that **no** queue and **no** `<queue>-dlq` is holding a failed job. Exit code `0` = clean, `1` = did not settle within the timeout or a failure remains (CI-gateable). Scheduled retention/tombstone queues are intentionally excluded: their next repeatable run always sits in `delayed`, so they never reach zero — their health is covered instead by the cluster-wide dead-letter assertion.

| Env | Default | Purpose |
| --- | ------- | ------- |
| `SETTLE_CHECK_TIMEOUT_MS` | `120000` | Max wait for the backlog to drain before reporting a timeout |
| `SETTLE_CHECK_POLL_INTERVAL_MS` | `2000` | Poll cadence while waiting |
| `SETTLE_CHECK_QUEUES` | throughput queues | Comma-separated queue-name override |

The same signals are observable live via `GET /readyz` (verbose), `GET /metrics` (`bullmq_queue_*`, `mail_outbox_pending`, `dlq_depth`), and Bull Board — see the [observability runbook](../../deployment/runbooks/observability.md). The settle check turns those gauges into a single pass/fail gate.

## Prerequisites

- **Server**: Run the API with `pnpm dev` (and optionally `pnpm dev:worker` for background jobs).
- **Postgres + Redis**: Required for auth and org-dependent scenarios. Start with `docker compose up -d` or your own instances.
- **Database**: Migrations applied (`pnpm db:migrate`). For auth and org scenarios, run full seed: `pnpm db:seed:full` (creates demo user `demo@example.com` / `DemoPassword123!` and a demo organization).
- **k6**: Install [k6](https://k6.io/docs/get-started/installation/) for scenario runs.

## Quick commands (no auth)

- **Autocannon** (single endpoint): `pnpm test:bench` — hits `http://localhost:3000/readyz`.
- **k6 health**: `pnpm load:health` — runs `src/tests/load/k6/scenarios/health.js` (`/livez` and `/readyz`). No env vars needed.

## Scenarios (all eight)

### 1. Health

- **File**: `src/tests/load/k6/scenarios/health.js`
- **Auth**: None
- **Env**: Optional `BASE_URL` (default `http://localhost:3000`)
- **Run**: `pnpm load:health` or `k6 run src/tests/load/k6/scenarios/health.js`

### 2. API stress (full confidence)

- **File**: `src/tests/load/k6/scenarios/api-stress.js`
- **Auth**: Bearer token (TEST_TOKEN) + TEST_ORG_ID for memberships
- **Env**: `TEST_TOKEN` (required), `TEST_ORG_ID` (required for memberships). Get via `pnpm tool:load-test-credentials`.
- **Run**: `pnpm load:stress:api` after exporting TEST_TOKEN and TEST_ORG_ID.
- **Routes**: users/me, tenancy/organizations, notify/notifications, notify/notifications/unread-count, tenancy/organization/memberships (active org from the token claim; `TEST_ORG_ID` scopes the token, not the path). Stress profile: 20→50→100 VUs.

### 3. Auth onboarding

- **File**: `src/tests/load/k6/scenarios/auth-onboarding.js`
- **Auth**: Login with email/password, then profile and list organizations
- **Env**: `TEST_EMAIL`, `TEST_PASSWORD` (defaults in script: `test@test.com` / `test-password`). After full seed use: `TEST_EMAIL=demo@example.com` and `TEST_PASSWORD=DemoPassword123!`
- **Run**: `pnpm load:auth` (uses demo credentials by default) or `k6 run src/tests/load/k6/scenarios/auth-onboarding.js`

### 4. Daily ops

- **File**: `src/tests/load/k6/scenarios/daily-ops.js`
- **Auth**: Bearer token scoped to the active org (the `org` claim; scope via `TEST_ORG_ID`)
- **Env**: `TEST_TOKEN` (required), `TEST_ORG_ID` (default `test-org-id`). Use the helper script to get token and org id: `pnpm tool:load-test-credentials` (see below).
- **Run**: `pnpm load:daily-ops` with `TEST_TOKEN` and `TEST_ORG_ID`, or `TEST_TOKEN=<token> TEST_ORG_ID=<org_public_id> k6 run src/tests/load/k6/scenarios/daily-ops.js`

### 5. Billing

- **File**: `src/tests/load/k6/scenarios/billing.js`
- **Auth**: First request (list plans) is public; rest require `TEST_TOKEN` and `TEST_ORG_ID`
- **Env**: `TEST_TOKEN`, `TEST_ORG_ID` (optional; if missing, only list-plans is exercised)
- **Run**: `pnpm load:billing` with `TEST_TOKEN` and `TEST_ORG_ID`, or `TEST_TOKEN=<token> TEST_ORG_ID=<org_public_id> k6 run src/tests/load/k6/scenarios/billing.js`

### 6. Webhooks

- **File**: `src/tests/load/k6/scenarios/webhooks.js`
- **Auth**: Bearer token scoped to the active org (the `org` claim; scope via `TEST_ORG_ID`)
- **Env**: `TEST_TOKEN` (required), `TEST_ORG_ID` (default `test-org-id`)
- **Run**: `pnpm load:webhooks` with `TEST_TOKEN` and `TEST_ORG_ID`, or `TEST_TOKEN=<token> TEST_ORG_ID=<org_public_id> k6 run src/tests/load/k6/scenarios/webhooks.js`

### 7. Admin

- **File**: `src/tests/load/k6/scenarios/admin.js`
- **Auth**: Token with global admin role (e.g. `super_admin`). Normal login issues role `user`; use the admin-token script for load tests.
- **Env**: `ADMIN_TOKEN` (required)
- **Run**: `pnpm load:admin` with `ADMIN_TOKEN`, or `ADMIN_TOKEN=<token> k6 run src/tests/load/k6/scenarios/admin.js`. Obtain token via: `pnpm tool:admin-token` (see below).

### 8. core-fe full journey

Walks the complete front-end user journey once per virtual user, so **VUs are users** — 50 VUs means
50 people each performing the journey a single time, not 50 people looping.

- **File**: `src/tests/load/k6/scenarios/fe-user-journey.js`
- **Auth**: `AUTH=code` (default) logs in with `AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED`; `AUTH=password` uses
  `POST /auth/login`; `AUTH=otp` does the real `send-code` → read `debug_verification_code` → login
  round trip (needs `TEST_MODE=true`).
- **Credentials**: the pool at `src/tests/load/k6/data/credential-pool.json` — build it with
  `pnpm db:seed:loadtest`.
- **Routes** (16): guest refresh → send-code → login → me/context → profile patch → create org →
  onboarding complete → switch org → me/context again → workspace and dashboard reads →
  authed refresh → logout.

| Env | Default | Purpose |
| --- | ------- | ------- |
| `VUS` | `50` | Virtual users; each performs the journey once |
| `POOL` | — | `DATABASE_POOL_MAX` the API was started with; printed in the header for the record |
| `AUTH` | `code` | `code` \| `password` \| `otp` |
| `STATIC_CODE` | `TEST24` | Must match the API's `AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED` |
| `STAGGER` | `5` | Milliseconds between VU starts, to avoid a synthetic thundering herd |
| `RESULT_TAG` | — | Label recorded with the run |

**`send-code` is measured but not depended on.** The journey issues it because the real client always
does and its cost belongs in the numbers, but login presents `AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED` rather
than the code `send-code` issued, so the two calls stay independent and a non-200 on `send-code` does
not abort the journey.

**The second `me/context` after the org switch is a benchmark, not a fidelity claim.** core-fe does
**not** make that call — `switch-to-organization` already returns the active-org context inline and
the client writes it into its cache with `setQueryData` (verified against live responses: the switch
payload's `active_organization` and `my_permissions` are byte-identical to what the re-read returns,
and `organizations[]` differs only by the `is_active` flag). The step exists because that route is
the largest single consumer of API time in the run — 100 calls / ~16% of total — which makes it the
benchmark any caching work has to beat. Of its four reads only `my_permissions` is Redis-cached
today. When reading the report, treat step 09 as a **caching target**, not as production traffic, and
subtract it before quoting a per-user total as what a real session costs — see point 3 under
[Trusting a result](#trusting-a-result).

Requires the API started with `TEST_MODE=true` and `AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED` turned on:

```bash
TEST_MODE=true AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED=true DATABASE_POOL_MAX=50 pnpm dev
# then
BASE_URL=http://localhost:3000 VUS=50 POOL=50 k6 run src/tests/load/k6/scenarios/fe-user-journey.js
```

### Org-scoped / RLS-heavy (informational, CI nightly)

Org-scoped scenarios resolve the tenant from the token's `org` claim — no org path segment and no
`X-Organization-Id` header. `TEST_ORG_ID` is used to **scope the token** to that org (the helpers
call `switchToOrganization` / `loginScopedToOrganization`), not to build the path.

| File | Env | Routes |
| ---- | --- | ------ |
| `audit-list.js` | `ADMIN_TOKEN` | `GET /api/v1/audit/logs` |
| `org-membership-list.js` | `TEST_TOKEN`, `TEST_ORG_ID` | `GET /api/v1/tenancy/organization/memberships` |
| `member-role-permission-list.js` | `TEST_TOKEN`, `TEST_ORG_ID`, `TEST_ROLE_ID` | `GET /api/v1/tenancy/organization/roles/:role_id/permissions` |
| `notification-policy-crud.js` | `TEST_TOKEN`, `TEST_ORG_ID` | `GET /api/v1/tenancy/organization/notification-policies` |
| `billing-subscriptions-rls.js` | `TEST_TOKEN`, `TEST_ORG_ID`, optional `TEST_SUBSCRIPTION_ID` | `GET /api/v1/billing/subscriptions` |
| `upload-list.js` | `TEST_TOKEN`, optional `TEST_UPLOAD_PUBLIC_ID` | `GET /api/v1/uploads/:id` |
| `user-data-export.js` | `TEST_TOKEN` | `POST /api/v1/users/me/data-export` |

CI runs a subset in the **org-scoped routes** job step (see `scheduled-k6-load-slo.yml`).

### RLS concurrency beyond pool size

- **File**: `src/tests/load/k6/scenarios/rls-concurrency-beyond-pool.js`
- **Auth**: Bearer token scoped to the active org (the `org` claim; scope via `TEST_ORG_ID`)
- **Env**: `TEST_TOKEN`, `TEST_ORG_ID` (required); optional `DATABASE_POOL_MAX` (default `10`), `BEYOND_POOL_FACTOR` (default `4`), `BEYOND_POOL_VUS` (explicit VU override)
- **Run**: `RATE_LIMIT_MAX=10000 pnpm dev` (or `pnpm dev:loadtest`), then `pnpm load:rls-concurrency` with `TEST_TOKEN` and `TEST_ORG_ID`
- **Rate limit**: This scenario drives `DATABASE_POOL_MAX × BEYOND_POOL_FACTOR` VUs (default 40) with a short `sleep`, so it sends far more than the default global limit of `RATE_LIMIT_MAX` (100) requests per `RATE_LIMIT_WINDOW_MS` (60s) per IP. Without raising `RATE_LIMIT_MAX`, k6 will count `429 Too Many Requests` as failures and breach the `http_req_failed < 1%` threshold even when the pool is healthy. Match the server's `DATABASE_POOL_MAX` when overriding it on the k6 side.
- **Purpose**: Validates production-readiness audit item #5 (per-request RLS transaction pinning). It ramps concurrent VUs to `DATABASE_POOL_MAX × BEYOND_POOL_FACTOR` against an org-scoped (RLS) endpoint (`GET .../memberships`) and asserts `http_req_failed` stays below 1%. With `DATABASE_RLS_SCOPED_CONTEXTS=true` the connection checkout is held only for the unit-of-work, so the pool absorbs several multiples of concurrent requests; under the legacy request-pinned model the API would saturate near `DATABASE_POOL_MAX` and later requests would block or fail.
- **CI**: Runs nightly as part of the **org-scoped routes** informational step in `scheduled-k6-load-slo.yml` (seeded full demo data guarantees `TEST_ORG_ID`; the workflow already boots the API with `RATE_LIMIT_MAX=10000`). Pair a manual run with the `database_rls_active_checkouts` / `database_rls_checkout_hold_seconds` metrics from the [resource-limits runbook](../../deployment/runbooks/resource-limits.md) to confirm checkout hold time stays short.

## Obtaining credentials

- **TEST_TOKEN and TEST_ORG_ID**: Run `pnpm tool:load-test-credentials` (with server up and full seed). It logs in as the demo user, lists organizations, and prints `TEST_TOKEN` and `TEST_ORG_ID` for copy-paste.
- **Credential pool**: Run `pnpm db:seed:loadtest` (bulk seed + pool export). The generator **excludes MFA accounts** — both `users.is_mfa_enabled` and membership of an organization whose `security_policy.mfa_required` is true, mirroring the login gate in `completeFirstFactorAuth`. Such an account returns HTTP 200 with an `mfa_required` envelope instead of an `access_token`, so a VU drawing one would read no token and quietly abandon its journey. The bulk seeder sets `mfa_required` on a share of its organizations, so without the filter roughly a third of the pool is unusable.
- **ADMIN_TOKEN**: Run `pnpm tool:admin-token`. It prints a JWT signed with role `super_admin` for load-test use only (no real admin user required in DB).

## Optional env (all scenarios)

- `BASE_URL`: API base URL (default `http://localhost:3000`). k6 reads this as `__ENV.BASE_URL`.
