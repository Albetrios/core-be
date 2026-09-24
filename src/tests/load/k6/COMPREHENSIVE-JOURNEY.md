# Comprehensive journey load test — setup, prerequisites & capacity findings

Reference for [`scenarios/comprehensive-journey.js`](scenarios/comprehensive-journey.js): a full,
natural multi-tenant user journey (reads + complete CRUD across every domain) used to measure API
capacity. This file documents **everything needed to reproduce a clean run**, the **prerequisites**
(checked by [`check-prereqs.mjs`](check-prereqs.mjs)), and the **measured capacity ceiling**.

> **Run the whole thing (setup + run) in one command:** `pnpm load:journey`
> (100 VU / 10 workers / 60s; override with `VUS=200 WORKERS=10 DURATION=90s pnpm load:journey`).
> It front-loads every prerequisite, runs the journey, and leaves the rig up for fast re-runs.
> Tear down with `pnpm load:journey:down`.
>
> **Setup only** — applies every prerequisite below and verifies it:
> `bash src/tests/load/k6/setup-loadtest.sh [VUS] [WORKERS]` (defaults `100 10`). It first **warns
> about box headroom** — orphaned dev servers (parent pid 1) and more than 4 GB of swap, either of
> which skews the numbers toward the machine rather than the API — then backs up
> `.env.local`, applies the load-test env, **sizes the DB pool to the connection budget**, rebuilds and
> **copies runtime assets to `dist/`**, **heals a half-open Redis port-forward**, ensures Postgres
> `max_connections=500`, seeds the credential pool, cleans leaked data, starts the cluster, and ends by
> running the prereq check. Revert with `bash src/tests/load/k6/setup-loadtest.sh --teardown`.
>
> **Verify-only (run before every k6 run):** `node src/tests/load/k6/check-prereqs.mjs` — checks the
> stack, env, data, and caps below and prints PASS/FAIL with remediation.

All env values here are **load-test-only** — several (captcha off, rate limits disabled, Sentry off)
are intentionally unsafe for production. Never apply them to a hosted environment. Which of these are
auto-rejected at boot in production vs. which the operator must set correctly is documented in
[environment-variables.md §11 — Production safety](../../../../docs/deployment/runbooks/environment-variables.md#11-production-safety-unsafe-dev-and-load-test-values).

---

## TL;DR — what we measured

| Load | Result | Notes |
| ---- | ------ | ----- |
| **1 VU** | p99 ~50–75 ms, 0 fail | per-op idle baseline |
| **100 VU** | **p99 66 ms, 0.00% fail, 752 req/s** ✅ | full comprehensive journey, 10-worker cluster — **verified capacity ceiling on a 12-core dev box** |
| **200 VU** | p99 ~700 ms, ~1.4% fail | **infrastructure-bound**, NOT a server defect (see §7) |

**200 VU is CPU-bound on a single dev box**: k6 (driving 200 VUs) + OrbStack/Docker port-forwarding
for Postgres+Redis (~5.4 cores, proven by a native-Redis swap that dropped OrbStack 544%→6%) + the
worker cluster exceed 12 cores. The cluster has spare capacity; it just can't get cores. To test
200 VU properly: run **k6 off-box** and/or run **Postgres+Redis natively** (no Docker port-forward).

---

## Prerequisites (what `check-prereqs.mjs` verifies)

1. **k6** installed (`k6 version`).
2. **Docker stack up & healthy** — Postgres + Redis (`pnpm compose:up`).
3. **Redis reachable *from the host*** — `redis://localhost:6379` → PONG. OrbStack/Docker can leave the
   port-forward **half-open** (TCP accepted, then dropped) while the container stays healthy, so the
   server fails to boot with ioredis `Connection is closed`. `docker exec … redis-cli ping` still PONGs
   and **won't** catch it — only a host connect does. Fix: `docker restart core-be-redis` (the setup
   script auto-heals this).
4. **Postgres `max_connections` ≥ 500**.
5. **Postgres connection budget fits** — `(API replicas + worker replicas) × DATABASE_POOL_MAX ≤
   max_connections − reserved(10)`. The server **refuses to boot** if exceeded (see §4).
6. **Credential pool** with enough **usable** users — `data/credential-pool.json`; ~20% are MFA-blocked,
   so seed `≈ VUS / 0.8` (`pnpm db:seed:loadtest`).
7. **Loadtest server reachable** on `:3001` (`/livez` → 200).
8. **Captcha fail-open + login** — a password login returns a token (proves `NODE_ENV=development + RATE_LIMIT_RELAXED_CAPS=true`, §1) and an
   organization-scoped read returns 200.
9. **Rate limits lifted** — a token works and isn't 429'd.
10. **Role-cap headroom** — `max(roles/organization)` well under `MEMBER_ROLE_MAX_PER_ORG` (data hygiene, §3).

---

## 1. Server config — load-test env overrides (`.env.local`)

Run a **dedicated** loadtest server (leave any normal `:3000` dev server alone). Set these in
`.env.local`; the loader makes `.env.local` authoritative, so these values win.

| Env var | Load-test value | Default | Why |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | `local` | non-production runtime, so captcha **fails open** (login works without a Turnstile token). The enum rejects `test`. The full server still runs real auth/DB/RLS. |
| `RATE_LIMIT_RELAXED_CAPS` | `true` | `false` | per-route rate caps bump to 5000 (what the old `test` runtime implied). |
| `CAPTCHA_PROVIDER` | `disabled` | `disabled` | belt-and-suspenders with the fail-open. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `100000` / `1000` | `100` / `60000` | all k6 traffic is one IP; the global limiter must never reject (it still runs — its cost is measured). The schema caps the max at `100000`, so the 1 s window makes it 100k req/s. |
| `WEBHOOK_URL_ALLOWLIST` | `example.com` | `hooks.example.com,*.partner.example.com` | `POST /notify/webhooks` validates host vs allowlist **and** resolves it (SSRF/DNS-pin); `example.com` resolves to a public IP and passes both. |
| `MEMBER_ROLE_MAX_PER_ORG` | `500` (max) | `50` | the journey create/deletes roles under concurrency; the default 50 is hit when many VUs share an organization. |
| `POSTGRES_MAX_CONNECTIONS` | `500` | `100` | the connection-budget check reads this from **env**, not the live DB — must match the actual Postgres `max_connections` (§4). |
| `DATABASE_POOL_MAX` | `44` (10-worker cluster) / `100` (single) | `10` | per-process pool. Budget: `(N_workers + 1) × pool ≤ Postgres max − 10` (§4) — `setup-loadtest.sh` computes it. |
| `DEPLOYMENT_API_REPLICA_COUNT` | `= N_workers` | `2` | makes the budget check account for the cluster. |
| `DEPLOYMENT_WORKER_REPLICA_COUNT` | `1` | `1` | min allowed is 1. |
| `PORT` | `3001` | `3000` | run beside any `:3000` dev server; k6 `BASE_URL` must match. |
| `SENTRY_DSN` | `<empty>` | placeholder | optional — disables Sentry. **Measured impact on latency: ~0 ms** (4.70 vs 4.72 ms), so not required. |
| `OVERLOAD_MAX_EVENT_LOOP_DELAY_MS` | `250` (default) | `250` | leave as-is; above this the overload guard sheds 503s (a saturation signal). |

Boot: single process `node dist/src/server.js` (after `pnpm build`); cluster via §4.

## 2. Per-route caps & quotas (which `NODE_ENV=development + RATE_LIMIT_RELAXED_CAPS=true` lifts vs not)

`rate-limit-presets.constants.ts` caps bump to **5000/min** under `NODE_ENV=development + RATE_LIMIT_RELAXED_CAPS=true`. Prod values:
`STRICT_AUTHED` 10 (`/auth/me/*`), `MODERATE_AUTHED` 30, `ORGANIZATION_SCOPED` 100, `WEBHOOK` 60,
`EXPENSIVE_AUTHED` 5/5min (`data-export`). **Always-on quotas (not rate limits):**

- **Pending-upload quota** (per user): the journey **deletes** the pending upload it creates so it
  never fills. Leak reset: `DELETE FROM upload.uploads WHERE status = 'PENDING';`
- **`MEMBER_ROLE_MAX_PER_ORG`** (per organization, env, max 500): raise it **and** clean leaked roles (§3).
- **`MAX_TEAM_ORGANIZATIONS_PER_OWNER`** (20): why `create-org` is excluded from the journey (it
  accumulates organizations with no cleanup — organization-delete is destructive).
- **Idempotency** (`X-Idempotency-Key` on `POST /organizations|/memberships|/roles|/api-keys|/notification-policies|/webhooks|/uploads`): reused key
  - different body → 422. Keys are run-unique (`idem-<RUN>-<vu>-<iter>-<n>`).

## 3. Test data

```bash
pnpm db:seed:loadtest   # 12 organizations x 10 users (override BULK_ORGS/BULK_USERS_PER_ORG for more)
# for 200 VU you need >200 usable users; seed ~20x12: 
ALLOW_BULK_SEED=1 BULK_PROFILE=demo BULK_ORGS=20 BULK_USERS_PER_ORG=12 pnpm db:seed:bulk && pnpm tool:load-test-credential-pool
```

- **~20% of bulk users are unusable** — their organization has an MFA-required policy, so password login
  returns `mfa_required` (no token). `setup()` filters these out (e.g. 174 of 216 usable).
- **Data hygiene before a run** (leaks from prior runs slow every query → 403/p99 inflation):

  ```sql
  DELETE FROM tenancy.memberships WHERE role_id IN (SELECT id FROM tenancy.roles WHERE name LIKE ANY (ARRAY['Role %','Member Role %','X-%','LC-%','k6%']));
  DELETE FROM tenancy.roles WHERE name LIKE ANY (ARRAY['Role %','Member Role %','X-%','LC-%','k6%']);
  DELETE FROM upload.uploads WHERE status = 'PENDING';
  -- optional: DELETE FROM auth.sessions;  (regenerated by setup())
  ```

  Redis: clear stale counters before a run — `redis-cli --scan --pattern '*rate*limit*' | xargs redis-cli del`.

## 4. Running

### Single process (≤ ~100 VU, simplest)

```bash
pnpm build
# tsc emits only .js — copy runtime assets (locales .json, mail templates .html) the server reads from dist:
rsync -a --include='*/' --include='*.json' --include='*.html' --include='*.sql' --exclude='*' src/ dist/src/
node dist/src/server.js                     # reads .env.local (PORT 3001)
RUN=$(date +%s) VUS=100 DURATION=60s k6 run src/tests/load/k6/scenarios/comprehensive-journey.js
```

### Cluster (lower p99 at higher VU) — [`cluster-run.mjs`](../../../../cluster-run.mjs) (repo root)

Node `cluster` round-robins connections across N workers (one event loop each).
**Connection-budget math** (the server asserts this at boot and **refuses to start** if exceeded):
`(DEPLOYMENT_API_REPLICA_COUNT + DEPLOYMENT_WORKER_REPLICA_COUNT) × DATABASE_POOL_MAX ≤
POSTGRES_MAX_CONNECTIONS − POSTGRES_RESERVED_CONNECTIONS` (reserved default 10) — **the 1 worker
process counts**. For 10 API workers: `DATABASE_POOL_MAX=44` → `(10+1)×44 = 484 ≤ 490`, with
`DEPLOYMENT_API_REPLICA_COUNT=10`, `DEPLOYMENT_WORKER_REPLICA_COUNT=1`. `setup-loadtest.sh` computes the
pool automatically; `check-prereqs.mjs` fails pre-flight if the budget is over.

```bash
pnpm build
rsync -a --include='*/' --include='*.json' --include='*.html' --include='*.sql' --exclude='*' src/ dist/src/
DATABASE_POOL_MAX=44 CLUSTER_WORKERS=10 node cluster-run.mjs   # forks 10 workers sharing :3001
RUN=$(date +%s) VUS=100 DURATION=60s k6 run src/tests/load/k6/scenarios/comprehensive-journey.js
```

### Knobs (env)

`VUS`, `DURATION`, `RUN` (unique per invocation — keeps names + idempotency keys unique),
`THINK` (think-time s/phase, default 0.4), `WRITE_EVERY` (write phases every Nth iteration; >1 =
read-dominant), `RARE` (`true` to include the cross-organization member-invite flow — OFF by default because
it churns other users' permission caches under load), `DIAG` (`true` logs each failure's status/body),
`BASE_URL`.

## 5. Journey design (why each guard exists)

- **`setup()` mints all tokens once** (login → `switch-to-organization`) and **filters** to
  token-bearing, organization-scoped admins; VUs index in. No per-request login → **can't storm** the per-IP
  login limit. It also issues one **cache-warming** read per user.
- **No re-auth by default** (`REAUTH=false`): re-login on 401 from one IP self-amplifies into a login
  storm under load. (Tokens last 900 s; runs are shorter.)
- **Run-unique names + idempotency keys** (`RUN`) — no cross-run slug/key collisions.
- **Self-cleaning writes** — created roles/keys/policies/webhooks/uploads/memberships are deleted
  in-iteration so data + per-organization caps don't grow.
- **Per-op metrics**: total / `Server-Timing` server-compute / TTFB(waiting) / queue+network, plus
  per-op 4xx/429/503 counters. `handleSummary` prints a table sorted by server-compute and writes
  `/tmp/journey-<vus>vu.json`.

## 6. Interpreting

- **`srvP99`** = pure server compute (`Server-Timing: app;dur`). **`q+net`** = `waitP99 − srvP99` ≈
  queue+network; small at low VU, balloons under saturation.
- **1 VU**: latency is all server-compute (q+net ~1 ms). **At sustained load, requests stay warm**
  (~5 ms reads); the ~22 ms "idle penalty" only hits the first request after a quiet gap (V8 JIT/
  connection warm-up), and vanishes under traffic.
- Failures by type: **429** = a cap not lifted; **503** = overload guard shedding (event-loop > 250 ms);
  **403 `insufficientOrganizationPermissions`** = permission-cache recompute contention (cold/churned
  cache + a slow/loaded DB); **404** = read-after-delete race; **422** = idempotency key reuse.

## 7. Capacity findings (this 12-core dev box, OrbStack/Docker for PG+Redis)

- **100 VU is the clean ceiling**: p99 66 ms, 0 failures, 752 req/s with the 10-worker cluster.
- **200 VU is infrastructure-bound, not server-bound.** At 200 VU the machine hits **99.5% CPU**. The
  dominant consumer is **OrbStack at ~544% (≈5.4 cores)** — pure Docker port-forward overhead for the
  thousands of localhost↔container DB/Redis ops/sec (the containers themselves are <0.3% CPU).
  - **Proof:** moving Redis to a **native** process dropped OrbStack to **6.2%** — confirming the
    port-forward was the cost. (Throughput then fell because Postgres was still Dockerized, moving the
    bottleneck to its port-forward.)
  - **Both Docker modes fail (proven 4 ways):** connecting to the container **VM IPs** (bypassing the
    port-forward proxy, Redis `protected-mode no`) dropped OrbStack 544%→**131%** and left the machine
    **54% idle** — yet throughput **collapsed to 273 req/s** (p99 2.7 s) because direct-IP routing has
    higher per-op latency. So: **port-forward = CPU wall; direct-IP = latency wall.** Either way Docker
    is the binding constraint; the only escape is **native (non-Docker) Postgres+Redis** or **off-box k6**.
  - The worker cluster has spare capacity throughout; it's starved by Docker (CPU) or its latency.
  - **To hit 200 VU idle-p99:** run **k6 on a separate host** and/or run **Postgres + Redis native**
    (no Docker). Both relieve the perm-cache 403s too (faster recompute when not CPU-starved).

## 8. Teardown / revert

The load-test overrides are local-only. To restore normal dev after `setup-loadtest.sh`, run
`pnpm load:journey:down` (`setup-loadtest.sh --teardown`): it stops the cluster and restores
`.env.local` from the owner-only backup setup took in `/tmp`, then **deletes that backup** — setup
snapshots only when no backup exists, so one left behind would be restored by a later teardown and
clobber everything added to `.env.local` in between. Postgres stays at `max_connections=500`.

For a rig assembled by hand (no setup script), revert manually:

```bash
cp /tmp/docker-compose.yml.bak docker-compose.yml   # if you scaled Postgres bigger
# revert .env.local: NODE_ENV=development, PORT=3000, RATE_LIMIT_MAX=100, DATABASE_POOL_MAX=10,
#   remove POSTGRES_MAX_CONNECTIONS/DEPLOYMENT_*_REPLICA_COUNT/MEMBER_ROLE_MAX_PER_ORG overrides,
#   restore WEBHOOK_URL_ALLOWLIST + SENTRY_DSN
pkill -f cluster-run.mjs            # stop the cluster
```

`comprehensive-journey.js`, `cluster-run.mjs`, and this doc are reusable — re-apply §1 + §3 and run
`check-prereqs.mjs` before the next run.
