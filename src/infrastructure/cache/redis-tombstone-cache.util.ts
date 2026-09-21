import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * Value written by {@link invalidateTombstonedCacheEntry}. Read back as a MISS, and `NX`-blocks a
 * populate, so an in-flight read that computed its value BEFORE a write committed cannot install
 * that stale value afterwards.
 */
const CACHE_INVALIDATION_TOMBSTONE = '__invalidated__';

/**
 * Reads a cached entry, treating an invalidation tombstone as a miss.
 *
 * @remarks
 * - **Algorithm:** one `GET`. An empty string or the tombstone reads as `null` so the caller falls
 *   through to the source of truth.
 * - **Failure modes:** a Redis error is logged at `warn` under `<metricName>.cache.get.failed` and
 *   returns `null` — a cache outage degrades latency, never correctness. Postgres remains the
 *   source of truth on every miss.
 * - **Side effects:** none beyond the read.
 * - **Notes:** `key` is the LOGICAL key; ioredis prepends the configured key prefix itself, so
 *   callers must not include it.
 */
export async function readTombstonedCacheEntry(
  key: string,
  metricName: string,
): Promise<string | null> {
  try {
    const cached = await redisConnection.get(key);
    if (cached === null || cached.length === 0) return null;
    if (cached === CACHE_INVALIDATION_TOMBSTONE) return null;
    return cached;
  } catch (error) {
    logger.warn({ error, key }, `${metricName}.cache.get.failed`);
    return null;
  }
}

/**
 * Populates a cache entry, but never over an invalidation tombstone.
 *
 * @remarks
 * - **Algorithm:** `SET key value EX ttl NX`. The `NX` is the whole point: a read that missed,
 *   queried Postgres, and is only now writing its answer must lose to any invalidation that
 *   happened in between. Without it the classic read-through race reinstates a value the write
 *   already superseded, and it survives for the full TTL.
 * - **Failure modes:** Redis errors are logged and swallowed — the caller's request already has
 *   its answer and must not fail because the cache did.
 * - **Side effects:** one short-lived Redis key, or none when the tombstone wins.
 * - **Notes:** `ttlSeconds <= 0` writes nothing, so callers capping a TTL against an expiry
 *   (`min(ttl, expiresAt - now)`) can pass the result through unguarded.
 */
export async function populateTombstonedCacheEntry(options: {
  key: string;
  value: string;
  ttlSeconds: number;
  metricName: string;
}): Promise<void> {
  if (options.ttlSeconds <= 0) return;
  try {
    await redisConnection.set(options.key, options.value, 'EX', options.ttlSeconds, 'NX');
  } catch (error) {
    logger.warn({ error, key: options.key }, `${options.metricName}.cache.set.failed`);
  }
}

/**
 * Invalidates a cache entry by writing a short-lived tombstone — deliberately NOT a `DEL`.
 *
 * @remarks
 * - **Algorithm:** `SET key <tombstone> EX ttl`. A plain delete leaves a TOCTOU window: a read
 *   that fetched from Postgres just before the write committed can `SET` its now-stale answer
 *   AFTER the delete, and that value then serves for a full TTL. The tombstone reads as a miss
 *   ({@link readTombstonedCacheEntry}) and blocks the `NX` populate
 *   ({@link populateTombstonedCacheEntry}), so the next read goes to Postgres and sees the write.
 *   This is the protocol `auth-session/session-token-cache.service.ts` arrived at for revoked
 *   bearers, generalised.
 * - **Failure modes:** Redis errors are logged and swallowed; staleness stays bounded by the TTL.
 *   Callers for whom stale data is a security problem (not merely a wrong number) should also
 *   report the failure — see the permission cache's Sentry capture.
 * - **Side effects:** one short-lived Redis key.
 * - **Notes:** call AFTER the transaction commits, and size `ttlSeconds` to the race, not to the
 *   cache. Two different quantities get passed here and confusing them is the live hazard:
 *   - a **freshness** tombstone only has to outlive the in-flight read that is about to issue its
 *     `SET … NX` — `CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS` (15 s). Passing the cache's own TTL
 *     instead is safe but leaves the key cold after every write, penalising the users who are
 *     actually using the feature.
 *   - a **revocation** tombstone has to outlive the cached positive entry it overrides, or the
 *     revoked thing keeps working; that one is the full cache TTL (`session-token-cache.service`).
 *
 *   Invalidating before commit is what forces the first kind to be sized like the second: the
 *   tombstone would then also have to cover the remainder of the transaction. Defer instead
 *   (`runEnqueueAfterCommit`), which additionally means a rolled-back write invalidates nothing.
 */
export async function invalidateTombstonedCacheEntry(options: {
  key: string;
  ttlSeconds: number;
  metricName: string;
}): Promise<void> {
  try {
    await redisConnection.set(options.key, CACHE_INVALIDATION_TOMBSTONE, 'EX', options.ttlSeconds);
  } catch (error) {
    logger.warn({ error, key: options.key }, `${options.metricName}.cache.invalidate.failed`);
  }
}
