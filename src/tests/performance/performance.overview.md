`src/tests/performance/`

# Performance tests

## Purpose

Latency + throughput tests run against a booted Fastify instance. Used to catch regressions in p95 / p99 latency and to validate that scaling-sensitive code paths (permission cache, idempotency middleware, audit emission) stay within the platform's SLO budget.

What this suite covers:

- Per-route p50 / p95 / p99 latency under low-concurrency load.
- Concurrent-request handling (no leaks, no pool exhaustion).
- Cache hit-ratio for the permission cache under repeated reads (`permission-cache.performance.test.ts` — exact join-count budgets: one 5-table join per distinct (user, organization); the strict cache-bypass path never caches).
- N+1 / scaling tripwires on the read-heavy list routes per domain: organizations + users (`n-plus-one`), memberships (`membership-list`), billing subscriptions + plans (`billing-list`), notification inbox + unread count (`notify-list`), auth session list (`auth-session-list`).
- EXPLAIN-plan assertions that the migration-provided indexes actually serve the hot queries (`explain-analyze` — audit organization filter, user email trgm; `notify-list` — inbox keyset index).
- Worker concurrency bulkheads stay independent per queue (`worker-bulkheads`).

What it does **not** cover: real-world traffic shape (see `load/` for k6 SLO scenarios), large-payload behavior (separate fixtures), failure modes (see `chaos/`).

## How to run

```bash
pnpm compose:up && pnpm compose:wait
pnpm test:performance
```

## Fixtures and helpers

- Boots the same Fastify app as integration tests but with a single-tenant seed.
- Latency assertions are loose (multiplier-based, not absolute) to avoid CI flakes.

## Dependencies

- **Postgres + Redis** — required.

## Failure modes

- **Flaky CI run** when CI is under load → use the multiplier-based assertions; check the latest run's variance before marking as a regression.
- **Pool exhaustion** during a concurrent-request test → typically a leaked connection from a transaction that didn't commit / rollback.
