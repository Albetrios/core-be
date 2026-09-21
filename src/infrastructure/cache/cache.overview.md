`src/infrastructure/cache/`

# Cache infrastructure

## Purpose

Redis client management. Owns the singleton `ioredis` client used by domain-level caches (permission cache, idempotency, rate-limiter), the BullMQ queue connection (re-exported by [src/infrastructure/queue/connection.ts](src/infrastructure/queue/connection.ts)), and the URL parser that normalises managed-Redis URLs (Railway, Upstash) into the connection options BullMQ expects.

## Design decisions

- **`ioredis` over `node-redis`**: native cluster + sentinel support, robust TLS handling on managed providers, and the API BullMQ expects.
- **Single client per process**: one connection multiplexes all GET/SET/SETNX traffic. BullMQ requires a separate connection — handled by [bullmq-redis.client.ts](src/infrastructure/cache/bullmq-redis.client.ts).
- **URL parser handles managed-provider quirks**: Railway and Upstash sometimes encode TLS / family options differently from canonical `redis://` URLs. The parser normalises before handing to ioredis.
- **No application-level cache abstraction**: domains call ioredis directly through this module's exports. The cost of a generic cache abstraction is rarely paid back; specific call sites use the right TTL and key shape.
- **One shared piece, and it is a protocol, not a cache**: [redis-tombstone-cache.util.ts](src/infrastructure/cache/redis-tombstone-cache.util.ts) holds the three-command read-through race protocol — read (a tombstone reads as a miss) · populate with `SET … EX … NX` · invalidate by writing a short-lived tombstone rather than `DEL`. It was extracted after that protocol had been hand-written once for revoked bearers in [session-token-cache.service.ts](src/domains/auth/sub-domains/auth-session/session-token-cache.service.ts); re-deriving it per cache is how the second one gets the `DEL` race wrong. Key shape, TTL, stored shape and invalidation points stay in the domain's own `<thing>.cache.ts`, so this does not become the abstraction the bullet above rules out. Contract: [PATTERNS.md → read-caching](src/PATTERNS.md); long form: [docs/reference/runtime/read-caching.md](docs/reference/runtime/read-caching.md).

## Operational concerns

- **TLS in production**: managed providers issue TLS-only URLs (`rediss://`); the parser detects and configures, and [buildRedisTlsOptions](src/infrastructure/cache/redis-url.parse.util.ts) passes an explicit `tls: { rejectUnauthorized: true }` to ioredis for `rediss://` URLs so the server certificate is verified, not merely encrypted.
- **TLS boot assertion**: [assert-redis-tls-safety.ts](src/infrastructure/cache/assert-redis-tls-safety.ts) refuses to boot a hosted deployment when `REDIS_URL` (or a `REDIS_BULLMQ_URL` override) is plaintext `redis://` to a public host. Plaintext is permitted only on trusted private networks (Railway `*.railway.internal`, Kubernetes `*.cluster.local`, RFC 1918, loopback) — the documented Railway private-networking topology stays valid. See [redis-topology runbook](docs/deployment/runbooks/redis-topology.md).
- **Connection budget**: managed Redis tiers cap per-account connections; the worker / API processes should each open ≤ 2 connections (general + BullMQ).
- **Latency budget**: cache reads are on the hot path of permission checks and idempotency; degraded Redis latency directly hits API p99.

## External dependencies

- **Redis 7+** — production runs against managed Redis (`REDIS_URL`).

## Tuning parameters

- `REDIS_URL`, `REDIS_TLS` (when not in URL), `REDIS_FAMILY` (4 / 6).

## Failure modes

- **Redis unavailable** → permission cache misses fall through to Postgres recompute (degraded latency); BullMQ workers fail fast and the process exits.
- **Connection drop mid-command** → ioredis auto-reconnects; in-flight commands are reported as failures.
- **Eviction under memory pressure** → permission cache entries may evict early; recomputed on next miss. Idempotency keys must not evict (eviction policy on the managed instance is `noeviction` for the keys we depend on).
