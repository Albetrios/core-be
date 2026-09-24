# Chaos testing (fault injection)

core-be validates graceful degradation paths (permission-cache misses, mail enqueue swallowing,
Stripe circuit breaker local snapshots, readiness probes, BullMQ webhook retries, idempotency
replay) against **live Postgres + Redis**, with failures injected by
[Shopify Toxiproxy](https://github.com/Shopify/toxiproxy).

## When to run locally

1. Start infra and the proxy:
   - `docker compose up -d postgres redis`
   - `pnpm chaos:up` (or `docker compose --profile chaos up -d toxiproxy`)
2. Point the **API process** at proxied ports (**not** the defaults in `.env` unless you override):
   - `DATABASE_URL=postgresql://core:core@127.0.0.1:25432/core`
   - `REDIS_URL=redis://127.0.0.1:26379`
   - `TOXIPROXY_URL=http://127.0.0.1:8474` (administration API for scripts)
3. Register listeners (idempotent):
   - `pnpm chaos:provision`
4. Migrate + run the focused suite:
   - `pnpm db:migrate`
   - `pnpm test:chaos`

On profile `chaos`, `docker-compose.yml` **builds** the Toxiproxy image locally from the official
release binary ([`tooling/chaos/toxiproxy.Dockerfile`](../../../tooling/chaos/toxiproxy.Dockerfile),
version pinned to match CI) and publishes ports `8474` (admin API), `25432` (Postgres proxy),
`26379` (Redis proxy). We build rather than pull `ghcr.io/shopify/toxiproxy` because that image's
blob CDN (`pkg-containers.githubusercontent.com`) is unreachable from some restricted dev networks
(HTTP 403), while `github.com` release assets are reachable. CI uses the `ghcr.io` image directly
via a GitHub Actions service container (see below), so this local build affects `pnpm chaos:up` only.

> **First-run prerequisites.** The Docker daemon must be running (`docker info`) before `pnpm chaos:up`.
> `pnpm test:chaos` is self-contained: its `bootstrap-env.ts` hard-forces `NODE_ENV=development` and points
> `DATABASE_URL` / `REDIS_URL` at the proxied ports itself, so the manual overrides in step 2 are only
> needed when you run the **API process** by hand against the proxies (not for the test suite). The chaos
> bootstrap forces `NODE_ENV=development` and sets the test-affordance flags — captcha bypass via
> `CAPTCHA_BYPASS_ALLOWED`, and `TEST_DATA_WIPE_ALLOWED=true` for `cleanupDatabase`/`cleanupTestRedis` —
> so the suite behaves the same locally and in CI.

## Continuous integration

The weekly [`scheduled-chaos.yml`](../../../.github/workflows/scheduled-chaos.yml) run (Sundays 03:00 UTC, and on demand) calls [`reusable-chaos-toxiproxy.yml`](../../../.github/workflows/reusable-chaos-toxiproxy.yml) against the current `main` — whichever ref dispatches it:

- Executes `pnpm chaos:provision`, `pnpm db:migrate` against proxied `DATABASE_URL`, then `pnpm test:chaos`.
- The CI Postgres is plaintext while the schema default is TLS on, so the shared `test-env` action exports `DATABASE_SSL_ENABLED=false`. Without it every test dies in setup within milliseconds (`Client network socket disconnected before secure TLS connection was established`), which kept this suite red on every run from its first one.
- The harness always connects as `core:core`, the Compose credentials (`src/tests/chaos/bootstrap-env.ts` overrides `DATABASE_URL`), so the job's Postgres service creates that role as well. With the image's usual `postgres:postgres` instead, every test failed in setup on `password authentication failed for user "core"`: the next failure after TLS, which showed up on the first run that got past TLS.
- A red run opens (or comments on) a `ci-failure` issue titled *Weekly chaos suite failing*; the next green run closes it.

Upstream addresses inside the proxy container default to `postgres:5432` and `redis:6379`; override
through `CHAOS_TOXIPROXY_POSTGRES_UPSTREAM` / `CHAOS_TOXIPROXY_REDIS_UPSTREAM` only when your Docker
network differs.

## Adding a new chaos scenario

1. Create `src/tests/chaos/<scenario>.chaos.test.ts` so Vitest only picks chaos files from the
   dedicated config (`tooling/vitest/chaos.config.ts`).
2. Prefer **`withTemporaryListeningProxyToxinForChaosAssertion`** helpers in
   [`src/tests/chaos/helpers/toxiproxy.client.ts`](../../../src/tests/chaos/helpers/toxiproxy.client.ts)
   so toxics are cleared between scenarios.
3. Extend [`src/tests/chaos/setup.ts`](../../../src/tests/chaos/setup.ts) hooks only when every
   chaos test needs the behavior (global database cleanup + `/reset` already run there).
4. Avoid importing production modules before `bootstrap-env` finishes — Vitest runs
   `bootstrap-env.ts` ahead of every chaos file to pin proxy URLs.

```mermaid
flowchart LR
  Vitest[Vitest chaos_suite]
  Api[Fastify_via_buildApp]
  ToxicAdmin[Toxiproxy_admin_8474]
  PgListen[Listener_25432_to_postgres]
  RedisListen[Listener_26379_to_redis]
  Pg[(Postgres_container)]
  Redis[(Redis_container)]

  Vitest --> ToxicAdmin
  Vitest --> Api
  Api --> PgListen --> Pg
  Api --> RedisListen --> Redis
```

## Log signals to watch

| Area                    | Log message (Pino)                                   |
| ----------------------- | ---------------------------------------------------- |
| Permission cache        | `permission-cache.get.failed`                        |
| Mail enqueue            | `mail.enqueue.failed`                                |
| Idempotency cache       | `idempotency.cache.*.failed`                         |
| Idempotency cardinality | `idempotency.cache.cardinality.high` / `.critical`   |
| Circuit breaker Redis   | `circuit-breaker.redis.(get\|set).failed`            |
| Webhook delivery worker | `webhook.delivery.completed` / BullMQ retry counters |

## Commands summary

| Command                | Purpose                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `pnpm chaos:up`        | Builds (first run) + starts the Toxiproxy container (profile `chaos`). |
| `pnpm chaos:down`      | Stops Toxiproxy (`docker compose --profile chaos stop toxiproxy`). |
| `pnpm chaos:provision` | Registers listener proxies via the administration API.             |
| `pnpm test:chaos`      | Executes `tooling/vitest/chaos.config.ts`.                         |
