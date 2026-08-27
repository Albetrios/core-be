`src/tests/integration/`

# Integration tests

## Purpose

End-to-end tests that boot Fastify, open Postgres + Redis connections, run real migrations, and exercise the API and workers as a customer would. This is the suite that catches RLS leaks, transaction-boundary bugs, and worker / queue regressions.

Vitest project: `integration` (configured in [tooling/vitest/projects.ts](tooling/vitest/projects.ts)).

What this suite **does** cover:

- HTTP route behavior end-to-end (controllers + services + repositories + DB).
- BullMQ worker / processor pipelines against real Redis.
- RLS contracts (read/write through `withPrincipalDatabaseContext`, etc.).
- Cross-domain interactions through the event bus.
- Cursor pagination, idempotency, rate limit headers, audit emission.

What it does **not** cover: outbound HTTP contracts (Stripe / Resend / S3 — see `contract/`), failure-mode chaos (see `chaos/`), latency / SLO (see `performance/`, `load/`).

## Test types

- **API tests** (`api/`) — HTTP behavior end-to-end.
- **Auth, billing, tenancy, notify, etc.** — domain-scoped flows including cross-domain side effects.
- **Worker tests** — the worker pipeline runs in-process, claiming jobs and asserting DB state changes.

## How to run

```bash
pnpm compose:up && pnpm compose:wait   # start Postgres + Redis (one-time)
pnpm db:migrate                        # apply migrations
pnpm test:integration                  # run the suite
pnpm test:integration -- <path>        # run a single file
```

## Fixtures and helpers

- `src/tests/global-setup.ts` truncates and reseeds tenancy permission rows before each run.
- `src/tests/setup.ts` configures the test app instance.
- `src/tests/helpers/test-http-inject.helper.ts` is the standard `fastify.inject()` wrapper used across the suite.
- Domain factories live in `src/tests/factories/` (cross-domain) and `src/domains/<domain>/__tests__/factories/` (domain-scoped).

## Dependencies

- **Postgres** (Docker compose, `DATABASE_URL`) — required.
- **Redis** (Docker compose, `REDIS_URL`) — required.
- **No outbound HTTP** — Stripe / Resend / S3 calls are mocked or skipped; for outbound contracts see `contract/`.

## Failure modes

- **Test that mutates global state** (e.g. inserts a permission row) without cleaning up → next test sees the leftover and may pass / fail spuriously. Prefer `withTransaction` + rollback in tests, or a per-suite truncate.
- **Flaky timer-based test** (worker poll loops) → use Vitest's fake timers or the test helpers in `helpers/`.
- **Compose stack not running** → tests fail at connection time; `pnpm compose:up && pnpm compose:wait` first.
