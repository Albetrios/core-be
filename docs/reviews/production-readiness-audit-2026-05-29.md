# Production-readiness audit — 2026-05-29 (consolidated)

> **Consolidated audit** merging two principal-staff production-readiness reviews conducted on 2026-05-29. Source A: in-repo audit (middleware, RLS checkout, migration lock, session cache, idempotency counter, request-id). Source B: extended audit (DB role / RLS bypass, Redis fail-closed rate limit, trust proxy spoofing, index migration locks, anonymous idempotency, CAPTCHA, shutdown drain, health split, unhandled rejection, DLQ durability). Overlapping findings are merged in place; nothing from either source was dropped.
>
> Add later audits as new dated files under `docs/reviews/`; do not rewrite this historical review.

## Scope reviewed

**Reviewed:**

- Entrypoints: `src/server.ts`, `src/worker.ts`, `src/app.ts`
- Middleware chain: `src/shared/middlewares/*` (auth, tenant, RLS transaction, rate limit, idempotency, error handler, Helmet, CORS, health, metrics, shutdown)
- Security primitives: JWT utility, API-key auth, session service, webhook delivery SSRF guard, CSP, CAPTCHA env gates
- Multi-tenant RLS: `migrations/00000000000000_init.sql`, `migrations/20260520000001_system_tables_rls_deny_all.sql`, `src/infrastructure/database/force-rls-tables.constants.ts`, organization discovery policies
- Infrastructure: database connection, connection-budget guard, migration runner, BullMQ DLQ, worker options, queue dashboard, outbound call wrapper
- Config and packaging: `package.json`, `.gitignore`, `Dockerfile`, env schema / `.env.example`, logger redaction, `TRUST_PROXY` / Railway deploy workflow
- Test and type-safety posture: Vitest config, skipped-test density, `any` / `@ts-ignore` density

**Not exhaustively reviewed:**

- Every domain service and repository
- Every migration beyond initialization, system-table RLS, and keyset-index migrations cited in findings
- Full test assertion depth (audits did not execute the full suite)
- CI workflows beyond deployment / migration ordering context
- All Stripe webhook, billing, and OAuth provider integration paths

---

## Findings

Findings are ordered by severity (Critical/High first), then effort. Numbering is stable for roadmap references.

### 1. Tenant isolation silently collapses if the runtime DB role is superuser or has BYPASSRLS

- **Severity:** High (Critical if the production role is misconfigured)
- **Category:** Security / Data (tenant isolation)
- **Sources:** B

**Evidence:**

- RLS is correctly `FORCE`d and fail-closed: `migrations/00000000000000_init.sql` (~1032+, `FORCE ROW LEVEL SECURITY`); policies use `current_setting('app.current_organization_id', true)` (e.g. ~748 `organizations_tenant_isolation`).
- The intended least-privilege role exists but cannot log in: `init.sql` ~22 `CREATE ROLE core_be_app NOLOGIN;` with grants at ~1012–1030. There is no `GRANT core_be_app TO <login_role>` and no `ALTER ROLE … LOGIN` anywhere in `migrations/`. The app therefore connects as some other role (often the provider default).
- Several read routes rely on RLS as their only tenant boundary — they have `app.authenticate` but no `requireOrganizationPermission`:
  - `organization.routes.ts` ~85–110 (`GET /organizations/:id`, `GET /organizations/by-slug/:slug`), and `GET /organizations` (~71).
  - Service backs these with `withUserDatabaseContext(...)` (`organization.service.ts` ~228–247) + the membership-bound `organizations_user_discovery` policy (`migrations/20260520000004_*`).
- `assertPostgresConnectionBudget` (`src/infrastructure/database/assert-connection-budget.ts`) checks pool vs `max_connections` but never checks `rolsuper` / `rolbypassrls` / `relforcerowsecurity`. No startup guard exists.

**Why it is dangerous:** PostgreSQL never applies RLS (even `FORCE`d) to a superuser or a role with `BYPASSRLS`. Railway's default Postgres user is often a superuser; a one-line `.env` mistake pointing `DATABASE_URL` at it disables tenant isolation with **zero error**. `GET /organizations/:id`, `/by-slug/:slug`, list, notifications inbox, and other RLS-only read paths can return any tenant's rows to any authenticated user — a cross-tenant data leak. Blast radius is narrowed (not eliminated) because financial/member mutations are double-protected by `requireOrganizationPermission`, but organization-discovery reads are not.

**Fix:**

1. Add a boot assertion (in `assert-connection-budget` or a sibling) and fail closed in non-local environments:

   ```sql
   SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
   ```

   Refuse to start if either is true.

2. Add a regression test that connects as the real production role and asserts a cross-organization `SELECT` returns 0 rows.

3. Confirm deployed `DATABASE_URL` uses a dedicated non-superuser login role that `core_be_app` is granted to (or make `core_be_app` `LOGIN` and use it directly).

- **Effort:** S
- **When:** Now

---

### 2. Redis blip takes the entire API down — global rate limiter fails closed

- **Severity:** High
- **Category:** Reliability / Scalability
- **Sources:** B

**Evidence:**

- `rate-limit.middleware.ts` registers a global limiter (`global: true`) in the `onRequest` phase and does not set `skipOnError`.
- `@fastify/rate-limit` (`node_modules/@fastify/rate-limit/index.js`): ~108 `skipOnError` defaults to `false`; ~259 on store error it throws. Redis client uses `enableOfflineQueue: false` (per `server.ts` comment), so commands reject immediately when disconnected.
- Compounding: idempotency also fail-closes to 503 on Redis errors (`idempotency.middleware.ts` ~194–214) — by design — so writes 503 and all requests can 500 simultaneously during the same outage.

**Why it is dangerous:** Every managed Redis has failovers and maintenance. During even a few seconds of unreachability, the rate-limit `onRequest` hook throws on every request → blanket 5xx → full API outage, not graceful degradation. **Most likely cause of the first production incident** (see Executive summary).

**Fix:** Make the limiter fail-open: `skipOnError: true` (accept the request if the store is unreachable). If protection during outages is required, wrap the store with a local in-memory fallback or an Opossum circuit breaker (already a dependency). Decide consciously rather than inheriting the fail-closed default.

```ts
const options: RateLimitPluginOptions = { /* … */ skipOnError: true };
```

- **Effort:** S
- **When:** Now (first line of defense)

---

### 3. Global rate limiter trusts unauthenticated `X-Organization-Id`

- **Severity:** High
- **Category:** Security / Reliability
- **Sources:** A

**Evidence:** `src/shared/middlewares/rate-limit/rate-limit.middleware.ts`, `src/shared/middlewares/tenant/tenant.middleware.ts`

```ts
keyGenerator: (request) => {
  if (request.organizationId) {
    return `org:${request.organizationId}`;
  }
  return request.ip;
},
```

`request.organizationId` is set from the request-asserted header or path **before** authentication. The organization-keyed max/key is therefore attacker-controlled on routes that rely on the global limiter.

**Why it is dangerous:** An unauthenticated client can attach a fresh, well-formed `X-Organization-Id` to each request, producing a new `org:<id>` bucket each time and bypassing the global per-IP cap. Conversely, an attacker can use a victim organization's public id and burn that organization's shared bucket, causing cross-tenant throttling. This can amplify JWT/session lookup load on authenticated routes that do not have stricter per-route presets. Compounds with Finding **#5** (spoofable `request.ip`) and Finding **#12** (CAPTCHA off by default).

**Fix:** Key the global limiter on `request.ip` only (after Finding **#5** is fixed). Apply organization/user-scoped quotas in a post-auth `preHandler`, following the existing rate-limit preset pattern. If organization keying remains, combine IP and verified organization membership in the key so a forged/fresh organization id cannot reset the IP budget.

- **Effort:** M
- **When:** Now

---

### 4. `TRUST_PROXY` is boolean-only; spoofable client IP when enabled

- **Severity:** High (Medium if proxy is misconfigured off; High if `true` behind an edge that does not strip `X-Forwarded-For`)
- **Category:** Security (auth abuse, log integrity) / Reliability
- **Sources:** A + B (merged)

**Evidence:**

- `src/shared/config/env-schema.ts`, `src/shared/utils/http/fastify-server.util.ts` (~36–42): `resolveTrustProxy()` returns boolean `true` when `TRUST_PROXY=true`; production template sets `TRUST_PROXY=true`.
- Env schema coerces to boolean only:

  ```ts
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((value) => value === 'true' || value === '1'),
  ```

  A numeric-hop-count branch exists in `resolveTrustProxy()` but is **unreachable** through env parsing.
- Rate limiter keys on `request.ip` (`rate-limit.middleware.ts` ~29). Audit logs record client IP from the same source.

**Why it is dangerous:**

- **`TRUST_PROXY=true`:** Fastify trusts the entire `X-Forwarded-For` chain and takes the left-most (client-supplied) value as `request.ip`. An attacker sends `X-Forwarded-For: <random>` per request to mint a fresh rate-limit bucket — fully bypassing per-IP throttling and poisoning `audit.logs.ip_address` with attacker-chosen values. Combined with Finding **#12**, login/magic-link can be effectively unthrottled.
- **`TRUST_PROXY=false` behind Railway:** Every client appears as the proxy IP, collapsing IP-based rate limits and audit IPs.

**Fix:**

1. Parse `TRUST_PROXY` as a hop count (e.g. `1` behind Railway one-proxy topology) or proxy CIDR list — never bare `true`.
2. Pass that integer (or CIDR config) to Fastify `trustProxy`.
3. Add a hosted-environment startup assertion/log showing the resolved trust-proxy mode.

```ts
// resolveTrustProxy(): return hop count or CIDR list, not bare `true`
trustProxy: 1
```

- **Effort:** S
- **When:** Now

---

### 5. Per-request RLS transaction pins one DB connection for the full request

- **Severity:** High
- **Category:** Scalability / Reliability
- **Sources:** A

**Evidence:** `src/shared/middlewares/tenant/organization-rls-transaction.middleware.ts`

```ts
organizationRlsCheckoutHeld.set(request, true);
incrementOrganizationRlsCheckoutCount();
const outerPromise = database.transaction(async (transaction) => {
  await transaction.execute(
    drizzleSql`SELECT set_config('app.current_organization_id', ${organizationPublicId}, true)`,
  );
  // transaction stays open until response settlement
});
```

Pool max defaults to 10 in `src/infrastructure/database/connection.ts`. `assert-connection-budget.ts` validates total connection budget, not HTTP concurrency under checkout pinning.

**Why it is dangerous:** Every organization-scoped HTTP request holds a pooled checkout for its entire lifetime, including time spent waiting on slow queries or **outbound HTTP calls inside the transaction**. With `DATABASE_POOL_MAX=10`, a single API instance can saturate at roughly 10 concurrent organization requests before later requests block and fail. On Neon, horizontal scaling is constrained by total database connections — this is the dominant concurrency ceiling at scale. **Second most likely sustained production incident** after Redis fail-closed rate limiting (see Executive summary).

**Fix:**

1. Prefer `DATABASE_RLS_SCOPED_CONTEXTS=true` and wrap only the actual unit-of-work in `withOrganizationDatabaseContext`.
2. Do not await external HTTP calls inside an RLS transaction.
3. Add checkout hold-time metrics and load tests that validate concurrency beyond the pool size.

- **Effort:** L
- **When:** Before scale (60-day track)

---

### 6. Index migrations run inside a forced transaction (no `CONCURRENTLY`) before new deploy

- **Severity:** Medium–High
- **Category:** Data / DevOps (zero-downtime)
- **Sources:** B

**Evidence:**

- `migrate.ts` ~142 wraps each migration file in `sql.begin(...)`, so `CREATE INDEX CONCURRENTLY` is impossible (cannot run in a transaction). Acknowledged in index migration headers (`20260520000006_*`, `20260520000007_*`).
- Those migrations use plain `CREATE INDEX` on `audit.logs` (4 indexes) and `notify.notifications` — high-write tables (`20260520000006_keyset_pagination_indexes.sql`).
- Deploy ordering: `.github/workflows/reusable-railway-deploy.yml` ~394–404 runs `pnpm db:migrate` synchronously **before** triggering redeploy, i.e. while the old app still serves traffic.

**Why it is dangerous:** Non-concurrent `CREATE INDEX` takes a `SHARE` lock that blocks all writes for the build duration. On a large `audit.logs`, that can be minutes of blocked `INSERT`s — and audit logging is on the path of most mutating requests, so those requests stall/timeout during deploy. Worsens as tables grow.

**Fix:**

1. Add a separate non-transactional migration lane for index DDL (runner executes `CREATE INDEX CONCURRENTLY` outside `sql.begin`, with idempotent `IF NOT EXISTS` + post-check for `INVALID` indexes).
2. Keep DML/constraint migrations transactional.
3. Adopt expand/contract playbook so schema changes stay backward-compatible with the still-running old version.

- **Effort:** M
- **When:** Before scale (60-day track)

---

### 7. Idempotent responses on unauthenticated routes share an anonymous cache bucket

- **Severity:** Medium
- **Category:** Security / API
- **Sources:** B

**Evidence:**

- `idempotency-key.util.ts` ~38–50: `buildIdempotencyCacheKey` uses `actorSegment = 'anonymous'` and `organizationSegment = 'none'` when the request has no auth context.
- Claim pre-handler is appended after route pre-handlers (`idempotency.middleware.ts` ~419–430), so unauthenticated `POST`s (login, register, magic-link, password reset) are still cached if `Idempotency-Key` is present; cached body is replayed verbatim (`sendCachedIdempotencyResponse`, ~122–132).

**Why it is dangerous:** Two different unauthenticated callers presenting the same `Idempotency-Key` within the 24h TTL collide on one cache entry. If the cached response carries secrets (e.g. access token in a login body), the second caller can receive the first user's response. Exploitability requires reusing the victim's key (often a random UUID), but keys are not secrets, may be logged, and some client libraries derive them deterministically.

**Fix:**

1. Skip idempotency caching entirely for unauthenticated routes (or routes whose responses set auth cookies / return tokens).
2. At minimum, fold a request fingerprint (hashed body + route) into the anonymous key so collisions cannot cross distinct requests.
3. Never cache token-bearing bodies.

- **Effort:** S
- **When:** Before scale (30-day track)

---

### 8. CAPTCHA disabled-by-default in production; auth relies on global per-IP throttling

- **Severity:** Medium
- **Category:** Security (credential stuffing / enumeration / email bombing)
- **Sources:** B

**Evidence:** `env-schema.ts` ~443–458 — production boot is allowed with `CAPTCHA_PROVIDER=disabled` as long as `CAPTCHA_DISABLED_ACK=true`, which switches auth routes to fail-open (skip CAPTCHA). The only other gate is the global per-IP limiter (spoofable per Finding **#4**).

**Why it is dangerous:** The common production path is "Turnstile not set up yet → set `CAPTCHA_DISABLED_ACK=true`." That leaves login, magic-link, and password-reset protected only by a spoofable per-IP limit → credential stuffing, account enumeration, and outbound-email abuse (magic-link/reset = free emails on demand, burning Resend reputation).

**Fix:**

1. Add per-identity throttling (per-email / per-account) on auth endpoints independent of IP.
2. Treat CAPTCHA as required for production launch, or gate email-sending endpoints behind a stricter budget.
3. Verify per-route presets cap per-email, not only per-IP.

- **Effort:** M
- **When:** Before scale (60-day track)

---

### 9. Graceful shutdown marks draining and immediately closes — no LB drain delay

- **Severity:** Medium
- **Category:** Reliability / DevOps
- **Sources:** B

**Evidence:** `shutdown.middleware.ts` ~31–50 — `setApplicationDraining(true)` then `await app.close()` with no pause. `/health` flips to 503 (`health.middleware.ts` ~44) but the load balancer only learns that on its next poll.

**Why it is dangerous:** Railway redeploys send `SIGTERM`. Between marking unhealthy and `app.close()` completing, the LB may not have re-checked health and keeps sending traffic → connection resets → 502s on every deploy. Frequent in an active project.

**Fix:** Sleep for ~1.5–2× the health-probe interval after `setApplicationDraining(true)` before `app.close()`, so the LB observes 503 and drains first. Keep the existing shutdown watchdog.

- **Effort:** S
- **When:** Before scale (30-day track)

---

### 10. One `/health` endpoint serves liveness, readiness, and deploy gating

- **Severity:** Medium (Low in Source A for probe load alone; elevated when conflated with liveness)
- **Category:** Observability / DevOps / Reliability
- **Sources:** A + B (merged)

**Evidence:**

- `health.middleware.ts` — single `GET /health` runs `runDependencyReadinessProbes()` (Postgres + Redis + BullMQ) and returns 503 if any fail.
- Docker `HEALTHCHECK` (`Dockerfile` ~85) and Railway deploy gating both point at it.
- `rate-limit.middleware.ts` allowlists URLs starting with `/health` (matches `/healthxyz` etc.).

**Why it is dangerous:**

- **Liveness vs readiness:** A liveness probe should answer "is the process alive?"; readiness answers "should I get traffic?". Conflating them means a transient Redis/DB blip makes a healthy process report unhealthy — failing deploy health gates and risking restart storms when a dependency is already stressed.
- **Probe load:** Unauthenticated, unthrottled dependency probes on every hit can add load; prefix allowlist is overly broad.

**Fix:**

1. Split `/livez` (process-only, 200 if event loop responsive) and `/readyz` (dependency probes).
2. Point container liveness at `/livez`; LB/deploy readiness at `/readyz`.
3. Cache readiness results for a short interval.
4. Exact-match rate-limit allowlist paths.

- **Effort:** S
- **When:** Before scale (60-day track); partial hardening (exact allowlist, short cache) in backlog

---

### 11. Migration runner lacks an advisory lock

- **Severity:** Medium
- **Category:** Data / DevOps
- **Sources:** A

**Evidence:** `src/infrastructure/database/migration/migrate.ts`

```ts
await sql.begin(async (transaction) => {
  // apply migration statements
  await transaction.unsafe('insert into public.schema_migrations (filename) values ($1)', [
    filename,
  ]);
});
```

Uses `schema_migrations` primary key but does not serialize concurrent runners.

**Why it is dangerous:** If two deploy jobs or instances run migrations concurrently, both can start the same migration. One later loses on `schema_migrations`, but non-idempotent or long-running DDL can still produce failed deploys or partially applied state. Related to but distinct from Finding **#6** (transactional index locks).

**Fix:** Acquire a Postgres advisory lock (e.g. `pg_advisory_lock(<constant>)`) around migration execution. Keep migrations as a single release-phase step, not from every app container.

- **Effort:** S
- **When:** Before scale (30-day track)

---

### 12. Session-validity Redis cache can accept an expired session for up to 60 seconds

- **Severity:** Low–Medium
- **Category:** Security
- **Sources:** A

**Evidence:** `src/domains/auth/sub-domains/auth-session/auth-session.service.ts`

```ts
const tokenHash = hashAccessToken(rawToken);
if (await getCachedSessionTokenValid(tokenHash)) {
  return;
}
const session = await withSessionTokenHashDatabaseContext(tokenHash, (_databaseHandle) =>
  this.sessionRepository.findActiveByTokenHash(tokenHash),
);
```

Explicit revoke and rotate paths invalidate the cache, but natural expiry depends on the cache TTL.

**Why it is dangerous:** A token checked shortly before session expiry can remain accepted until the 60-second cache entry expires. Blast radius is limited, but this weakens exact expiry semantics for sensitive environments.

**Fix:** Cap cache TTL to remaining session lifetime, e.g. `min(60 seconds, expires_at - now)`. Ensure every revocation path publishes cache invalidation.

- **Effort:** S
- **When:** Backlog / 30-day (Source A top-5)

---

### 13. Idempotency claim counter is a single global Redis key

- **Severity:** Low–Medium
- **Category:** Scalability
- **Sources:** A

**Evidence:** `src/shared/middlewares/core/idempotency.middleware.ts`

```ts
await redisConnection.incr(IDEMPOTENCY_CLAIM_COUNTER_LOGICAL_KEY);
```

**Why it is dangerous:** Every successful idempotent write increments one Redis key. At high write throughput or on Redis Cluster, that key becomes a hot slot and throughput bottleneck. Distinct from Finding **#7** (anonymous response replay).

**Fix:** If observability-only, use a Prometheus counter. Otherwise shard the Redis key and sum shards on scrape.

- **Effort:** S
- **When:** Before scale (90-day track)

---

### 14. Any unhandled promise rejection kills the whole process

- **Severity:** Low–Medium
- **Category:** Reliability
- **Sources:** B

**Evidence:** `server.ts` ~25–29 — `process.on('unhandledRejection', … process.exit(1))` (same pattern for `uncaughtException`).

**Why it is dangerous:** `uncaughtException` → exit is correct. Exiting on every `unhandledRejection` is aggressive: one stray un-awaited promise (including in a dependency) drops all in-flight requests; recurring triggers under load can cause a crash loop. Many libraries emit benign rejections.

**Fix:** For `unhandledRejection`, capture to Sentry + log; exit only on a sustained pattern (or not at all). Reserve hard-exit for `uncaughtException`. Document the chosen policy.

- **Effort:** S
- **When:** Backlog (90-day track)

---

### 15. DLQ enqueue on final job failure is best-effort — lost if Redis is down

- **Severity:** Low
- **Category:** Reliability
- **Sources:** B

**Evidence:** `src/infrastructure/queue/dlq/dead-letter.ts` ~203 — `void enqueueDeadLetter(...).catch(...)` only logs on failure. Original job remains in BullMQ's failed set, but the durable DLQ record operators replay from is dropped.

**Why it is dangerous:** Final-failure handling is exactly when a durable record matters most; if Redis is degraded (the same event causing job failures), the DLQ entry silently vanishes and replay ability is lost for those jobs.

**Fix:** Persist final failures to a Postgres dead-letter table (source of truth); treat the Redis DLQ as a convenience mirror. Postgres is already the only durable store of record per architecture rules.

- **Effort:** M
- **When:** Backlog (90-day track)

---

### 16. Client-supplied `x-request-id` is accepted with only length truncation

- **Severity:** Low
- **Category:** Observability / Security
- **Sources:** A

**Evidence:** `src/shared/utils/http/fastify-server.util.ts` — request id resolver accepts any non-empty `x-request-id` and slices to 128 chars.

**Why it is dangerous:** Attackers can choose correlation ids, collide with other traffic, or confuse incident triage. JSON logging limits classic log injection; primarily a forensics and debuggability issue.

**Fix:** Accept inbound IDs only when they match a strict pattern (UUID or short alphanumeric). Otherwise generate a server id. Consider logging both `inbound_request_id` and server-generated `trace_id`.

- **Effort:** S
- **When:** Backlog (90-day track)

---

## Notable strengths

(Combined from both audits — no contradictions removed.)

- **RLS tenant isolation (when role is correct):** `FORCE ROW LEVEL SECURITY` on tenant tables; dedicated `core_be_app` role design; system tables deny-all plus role-scoped policies; membership-bound organization discovery policies.
- **Webhook SSRF protection:** Enforced at delivery time via DNS-pinned, allowlisted fetch logic, not only at registration.
- **Worker reliability:** BullMQ retry/backoff, per-source DLQ, 30-day DLQ retention, Sentry on final failure, ordered worker shutdown.
- **JWT hygiene:** RS256 enforced, issuer/audience/expiry checked, PII excluded from access-token payloads; session revocation paths exist.
- **Authorization on mutations:** Consistent `requireOrganizationPermission` on sensitive writes (narrows blast radius of RLS-only read paths).
- **API keys and passwords:** Timing-safe API key handling, argon2, transaction-aware idempotency design.
- **Observability:** Pino redaction, Sentry, OpenTelemetry, Prometheus metrics, token-gated `/metrics`, request ids, DLQ/idempotency-cardinality monitors, audited queue-dashboard mutations.
- **Connection budgeting:** `assertPostgresConnectionBudget` guards pool vs `max_connections`.
- **Testing and type discipline:** Broad Vitest pyramid (unit/e2e/integration/property/contract/chaos/k6/mutation hooks); low production `any` usage; above-average engineering rigor.

**Caveat on strengths:** Source A noted `core_be_app` as "used for application access"; Source B shows migrations do not grant a login path to that role — production must verify the **actual** connecting role is non-superuser and non-`BYPASSRLS` (Finding **#1**).

---

## Executive summary

**Readiness verdict:** **Moderately Ready.**

This is strong, security-conscious engineering — forced fail-closed RLS (when the DB role is correct), RS256-pinned JWTs with session revocation, consistent permission checks on mutations, timing-safe API keys, argon2, transaction-aware idempotency, DLQ + watchdog shutdown, connection-budget assertions, and broad test/observability tooling. A focused set of mostly small-effort fixes stands between the current state and "serve millions," plus a larger architectural item (per-request RLS checkout pinning).

| Dimension | Score | Rationale |
| --- | ---: | --- |
| **Security** | **76** | Strong model (RLS, JWT, SSRF, redaction); dinged by DB-role assumption (**#1**), unauthenticated organization rate-limit key (**#3**), spoofable proxy IP (**#4**), CAPTCHA-off default (**#8**), anonymous idempotency scope (**#7**). |
| **Reliability** | **72** | DLQ/retries/shutdown are solid; Redis fail-closed SPOF (**#2**), no pre-close drain (**#9**), health conflation (**#10**), crash-on-rejection (**#14**), migration races (**#11**). |
| **Scalability** | **70** | Keyset indexes, permission caching, connection budgeting are strong; per-request DB checkout pinning (**#5**) and Redis SPOF (**#2**) cap concurrency; hot idempotency counter (**#13**). |
| **Observability** | **84** | Sentry + OTel + Prometheus + correlation IDs; minus readiness/liveness conflation (**#10**) and loose `x-request-id` (**#16**). |
| **Testing** | **80** (unverified) | Exceptional breadth; neither audit executed the full suite to vouch for assertion depth. |

### Top must-fix before production (unified priority)

| Priority | Finding | Summary |
| ---: | ---: | --- |
| 1 | **#2** | `skipOnError: true` on global rate limiter — Redis blip must not 500 the entire API. |
| 2 | **#1** | Boot assertion + prod role verification: non-superuser, non-`BYPASSRLS`; RLS regression test. |
| 3 | **#4** | `TRUST_PROXY` hop count / CIDR — not boolean `true`. |
| 4 | **#3** | Stop keying global rate limit on unauthenticated `X-Organization-Id`. |
| 5 | **#7** | Stop caching idempotent responses on unauthenticated/auth-token routes. |
| 6 | **#5** | Plan exit from per-request RLS transaction checkout (before traffic scale). |

Also before meaningful scale: **#6** (concurrent index lane), **#9** (shutdown drain delay), **#11** (migration advisory lock).

### Most likely first production incidents

1. **Immediate (seconds):** Routine Redis failover/maintenance — global rate limiter `skipOnError=false` + `onRequest` → 5xx on every request (**#2**). One-line mitigation; ship first.
2. **Under load (minutes):** Database checkout starvation from per-request RLS transactions with `DATABASE_POOL_MAX=10` — looks like "DB is slow," root cause is connection pinning (**#5**).
3. **Misconfiguration (silent):** `DATABASE_URL` as superuser / `BYPASSRLS` → cross-tenant reads on RLS-only routes with no error (**#1**).

---

## Roadmap

### 30 days — correctness and outage-proofing (mostly S-effort)

| Item | Finding |
| --- | --- |
| Global rate limit `skipOnError: true` | **#2** |
| DB role boot assertion + cross-tenant RLS regression test | **#1** |
| `TRUST_PROXY` hop-count parsing + hosted assertion | **#4** |
| Global rate limit: IP-only or IP+verified organization key | **#3** |
| Skip / fingerprint anonymous idempotency on auth routes | **#7** |
| Pre-close shutdown drain delay (~1.5–2× probe interval) | **#9** |
| Migration runner advisory lock | **#11** |
| Session-validity cache TTL bound to remaining lifetime | **#12** |

### 60 days — deploy and abuse hardening

| Item | Finding |
| --- | --- |
| Non-transactional `CREATE INDEX CONCURRENTLY` lane + expand/contract playbook | **#6** |
| Split `/livez` and `/readyz`; point liveness vs readiness probes correctly | **#10** |
| Per-identity auth throttling; CAPTCHA required or stricter email budgets | **#8** |
| `DATABASE_RLS_SCOPED_CONTEXTS` / scoped unit-of-work; no outbound HTTP inside RLS tx | **#5** |
| Checkout hold-time metrics; load tests beyond `DATABASE_POOL_MAX` | **#5** |

### 90 days — resilience depth

| Item | Finding |
| --- | --- |
| Opossum / in-memory fallback for Redis-dependent middleware beyond rate limit | **#2**, idempotency |
| Chaos-test Redis-down and DB-failover paths; load-test deploy under traffic | **#2**, **#6**, **#9** |
| Durable Postgres DLQ for final job failures | **#15** |
| Revisit `unhandledRejection` → `process.exit` policy | **#14** |
| Shard or replace idempotency Redis counter | **#13** |
| Strict `x-request-id` validation | **#16** |
| Exact-match `/health` rate-limit allowlist; short readiness cache | **#10** |

---

## Finding index (quick reference)

| # | Title | Severity | When |
| ---: | --- | --- | --- |
| 1 | DB superuser / BYPASSRLS bypasses RLS | High (Critical if misconfigured) | Now |
| 2 | Redis blip → global rate limit fail-closed | High | Now |
| 3 | Global rate limit trusts `X-Organization-Id` | High | Now |
| 4 | `TRUST_PROXY` boolean / spoofable IP | High | Now |
| 5 | Per-request RLS pins DB connection | High | Before scale |
| 6 | Index migrations block writes pre-deploy | Medium–High | Before scale |
| 7 | Anonymous idempotency cross-caller replay | Medium | 30 days |
| 8 | CAPTCHA off-by-default in production | Medium | 60 days |
| 9 | Shutdown without LB drain delay | Medium | 30 days |
| 10 | `/health` conflates liveness and readiness | Medium | 60 days |
| 11 | Migration runner no advisory lock | Medium | 30 days |
| 12 | Session cache accepts expired token ≤60s | Low–Medium | 30 days / backlog |
| 13 | Global Redis idempotency counter hot key | Low–Medium | 90 days |
| 14 | `unhandledRejection` kills process | Low–Medium | 90 days |
| 15 | DLQ enqueue best-effort only | Low | 90 days |
| 16 | Client-supplied `x-request-id` | Low | 90 days |

---

*Consolidated 2026-05-29. Sources: in-repo audit + extended audit (Untitled-3).*
