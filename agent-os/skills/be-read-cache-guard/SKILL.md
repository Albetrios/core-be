---
name: be-read-cache-guard
description: Keeps core-be Redis read caches correct — the four layers (client → tombstone protocol → domain <thing>.cache.ts → caller), keys built from the verified scope and never from a request parameter, invalidate-after-commit by tombstone rather than DEL, fail-open to Postgres, TTL ≤ 60 s, and the five tests every cache owes. Use when adding or changing a *.cache.ts, the shared tombstone util, or any service/controller that reads or invalidates one.
trigger: src/domains/**/*.cache.ts, src/infrastructure/cache/redis-tombstone-cache.util.ts
triggerNote: Redis read caches — key scope, tombstone invalidation, fail-open, TTL, tests
indexNote: Scope-keyed keys, tombstone-not-DEL, invalidate after commit, five tests
---

# Read cache guard

Redis sits **outside** row-level security. Postgres refuses a cross-tenant read; Redis hands over whatever key it is asked for. That is the whole reason this guard exists: a caching mistake here is not a stale number, it is one caller reading another's data with every database protection bypassed.

Contract: [PATTERNS.md → read-caching](../../../src/PATTERNS.md). Long form, including the "when not to cache" table: [docs/reference/runtime/read-caching.md](../../../docs/reference/runtime/read-caching.md). Worked example: [`notification-unread-count.cache.ts`](../../../src/domains/notify/sub-domains/notification/notification-unread-count.cache.ts).

## First — decide whether this should be cached at all

Most reads should not. A cache that misses pays a Redis round trip **and** the Postgres query, and carries an invalidation surface forever after. Refuse when any of these holds, and say which:

- The read is not frequent. "Might be hot" is not a measurement.
- It already opens one context and returns a large payload — you would be moving bytes, not removing pool checkouts.
- The invalidation surface is wide (every membership change, every rename, every upload). Wide invalidation is where cache bugs live.
- Stale data would authorize something, not merely miscount something.
- The value is searchable, sortable or paginated — that is a query space, not an answer.

A read earns a cache by being **frequent, scope-keyed, and cheap to be slightly stale about**.

## The four layers

| Layer | File | Owns |
| --- | --- | --- |
| Client | `infrastructure/cache/redis.client.ts` | the one ioredis connection; it applies the deployment key prefix, so cache modules build **logical** keys only |
| Protocol | `infrastructure/cache/redis-tombstone-cache.util.ts` | read (tombstone = miss) · populate `SET … EX … NX` · invalidate by tombstone |
| Domain cache module | `<domain>/…/<thing>.cache.ts` | key shape, TTL constant, stored shape, `getCached…` / `setCached…` / `invalidateCached…` |
| Caller | service (or controller, for a serialized payload) | reads after authorization; invalidates after commit at every write choke point |

Do **not** add a generic cache abstraction — `cache.overview.md` rules one out and still does. The shared util is the race protocol, not a cache: key shape, TTL, stored shape and invalidation points stay in the domain where they can be argued about.

## Review checklist

| # | Check | Failure it prevents |
| - | ----- | ------------------- |
| 1 | Key is `<domain>:<thing>:<scope public id>`, built from the **verified scope** (`UserPrincipalDatabaseScope` → user, `OrganizationPrincipalDatabaseScope` → organization) — never from `request.params`, `request.query` or a header | Cross-tenant read with RLS bypassed |
| 2 | The key is **logical** — no deployment prefix baked in | Double-prefixed keys that never hit, and never clear in tests |
| 3 | The cached read happens **after** `authenticate` and the permission preHandler, never in an `onRequest` hook | Warm entry served to an unauthorized caller |
| 4 | The scope choice is argued in TSDoc against the table's actual RLS policies — an organization segment on a user-visible set fragments one answer into N | A "safe-looking" extra segment that makes every switch a cold miss, or a missing one that crosses tenants |
| 5 | Invalidation writes a **tombstone**, never `DEL` | The read-through race: a slow reader installs a pre-write value *after* the delete, and it serves for a full TTL |
| 6 | The tombstone TTL is `CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS` (15 s), not the cache's TTL — unless it is a **revocation** tombstone, which must outlive the positive entry it overrides | Reaching for the cache TTL leaves the key cold after every write, so the users interacting most lose the cache; reaching for 15 s on a revocation tombstone lets a revoked thing keep working |
| 7 | Populate uses `SET … EX … NX` | Removes the mechanism in the two rows above — the `NX` refusal is what blocks the stale install |
| 8 | Invalidation runs **after commit** (`runEnqueueAfterCommit` from a handler inside a transaction), at every write choke point for that key — API **and** workers | A path that changes the value without telling the cache; and a pre-commit tombstone has to cover the rest of the transaction too, which forces the tombstone TTL the wrong way |
| 9 | The invalidation is skipped when the write found nothing (a 404 delete changes no value) | A caller cold-starting their own cache at will by deleting ids that do not exist |
| 10 | Writers that cannot name the scope (retention sweeps, id-only deletes) are named in TSDoc with the direction of the resulting error | A silent staleness source nobody can find later |
| 11 | Every Redis call fails open — logs `<cache>.cache.<operation>.failed`, falls through to Postgres. Read **and** populate | A cache outage becoming an outage |
| 12 | A failed invalidation that would leave *authorization* stale also reports to Sentry (permission-cache bar); a wrong number does not | Treating a security failure as a log line |
| 13 | TTL ≤ 60 s, own literal in `ttl.constants.ts` (not aliased to an unrelated cache), entry in `POLICIES.md` | Retuning one cache silently retuning another |
| 14 | Stored shape is JSON-safe — no `Date`, no class instances | `"2026-09-21T…"` read back where a `Date` was expected |
| 15 | Module records `read_cache_requests_total{cache,result}` with the cache **name** as the label, not the key | An unfalsifiable cache; or unbounded metric cardinality |
| 16 | Key prefix registered in `TEST_REDIS_PREFIXES` (`src/tests/helpers/test-redis.ts`) | Recycled ids leak one case's entry — or its `NX`-blocking tombstone — into the next |
| 17 | No environment kill switch | One more untested branch on a hot path; a ≤ 60 s TTL self-heals and the revert is the switch |

## The five tests every cache owes

Integration, over HTTP — against the cache module they would prove much less. Pattern: [`notification-unread-count-cache.integration.test.ts`](../../../src/domains/notify/sub-domains/notification/__tests__/integration/notification-unread-count-cache.integration.test.ts).

1. **A hit serves a value Postgres has since changed.** Write to the database *directly* (through the API would invalidate and prove nothing), then assert the stale value comes back. This is the only assertion that proves the cache is being read at all.
2. **Each write path invalidates.** One case per choke point; a missing one is the most common regression.
3. **Scope isolation with two warm callers.** Warm both, re-read both. A shared key, or one keyed on the wrong scope, crosses here and nowhere else.
4. **The route's own gate refuses while the entry is warm** (401 or 403, whichever that route has).
5. **Redis down falls back to Postgres.** Reject *both* `get` and `set` — a guarded read with an unguarded populate still throws into the request on a miss.

For the shared protocol itself, the unit test must model `SET … NX` actually refusing when a value is present. A stub that always accepts passes against a `DEL`-based implementation too, which makes the test worthless for the one property it exists to check.

## Related skills

- **be-rls-tenant-isolation-guard** — the scope types and what each GUC grants; consult it when choosing the key's scope.
- **be-tsdoc-export-guard** — every cache export needs a summary and `@remarks`.
- **be-change-completeness-guard** — the cache's docs (`PATTERNS.md`, `read-caching.md`, `POLICIES.md`, the cache table in the reference doc) move with the code.
