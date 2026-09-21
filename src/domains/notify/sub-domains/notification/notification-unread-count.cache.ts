import {
  invalidateTombstonedCacheEntry,
  populateTombstonedCacheEntry,
  readTombstonedCacheEntry,
} from '@/infrastructure/cache/redis-tombstone-cache.util.js';
import { recordReadCacheRequest } from '@/infrastructure/observability/metrics/prometheus-metrics.js';
import {
  CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS,
  NOTIFICATION_UNREAD_COUNT_CACHE_TTL_SECONDS,
} from '@/shared/constants/ttl.constants.js';

/** Logical key prefix. ioredis prepends the deployment prefix; never include it here. */
const UNREAD_COUNT_CACHE_PREFIX = 'notify:unread-count';

/** Metric label and log-event namespace for this cache. */
const UNREAD_COUNT_CACHE_NAME = 'notify_unread_count';

/**
 * Keyed on the USER alone, with no organization segment — and that is a claim about row visibility,
 * not a shortcut.
 *
 * @remarks
 * `notify.notifications` carries two permissive RLS policies, OR'd: `notifications_owner_access`
 * (rows whose `user_id` is the current user GUC) and `notifications_tenant_isolation` (rows in the
 * active organization). The count query additionally filters `user_id = <me>` in SQL, so the
 * tenant arm can only ever add rows the app-level predicate then removes. The visible set is
 * therefore `{ mine, unread }` regardless of which organization is active, and an organization
 * segment in the key would fragment one answer across N entries — each of them correct, all of
 * them redundant, and every switch a cold miss.
 */
function buildUnreadCountCacheKey(userPublicId: string): string {
  return `${UNREAD_COUNT_CACHE_PREFIX}:${userPublicId}`;
}

/**
 * Returns the cached unread-notification count for a user, or `null` on a miss.
 *
 * @remarks
 * - **Algorithm:** one Redis `GET` through the tombstone protocol; a non-numeric payload is
 *   treated as a miss rather than trusted.
 * - **Failure modes:** Redis errors surface as a miss (logged by the shared util), so the caller
 *   falls through to Postgres. Never throws into the read path.
 * - **Side effects:** increments `read_cache_requests_total{cache="notify_unread_count"}`.
 * - **Notes:** the caller MUST already have authenticated and narrowed the scope — this cache
 *   sits outside RLS, so reading it before authorization would hand one user another's count.
 */
export async function getCachedUnreadNotificationCount(
  userPublicId: string,
): Promise<number | null> {
  const cached = await readTombstonedCacheEntry(
    buildUnreadCountCacheKey(userPublicId),
    UNREAD_COUNT_CACHE_NAME,
  );
  const parsed = cached === null ? Number.NaN : Number(cached);
  const hit = Number.isInteger(parsed);
  recordReadCacheRequest(UNREAD_COUNT_CACHE_NAME, hit ? 'hit' : 'miss');
  return hit ? parsed : null;
}

/**
 * Caches a freshly computed unread count.
 *
 * @remarks
 * - **Algorithm:** `SET … EX … NX` via the shared protocol, so a racing invalidation wins over a
 *   populate that computed its value before the write committed.
 * - **Failure modes:** swallowed — the caller already has the number to return.
 * - **Side effects:** one short-lived Redis key.
 * - **Notes:** TTL is {@link NOTIFICATION_UNREAD_COUNT_CACHE_TTL_SECONDS}. It is a backstop, not
 *   the invalidation strategy: two writers move this count without naming a user — the retention
 *   sweep (deletes by `created_at`) and the enqueue-rollback delete (knows only a row id) — and
 *   the TTL is what bounds staleness from those.
 */
export async function setCachedUnreadNotificationCount(
  userPublicId: string,
  count: number,
): Promise<void> {
  await populateTombstonedCacheEntry({
    key: buildUnreadCountCacheKey(userPublicId),
    value: String(count),
    ttlSeconds: NOTIFICATION_UNREAD_COUNT_CACHE_TTL_SECONDS,
    metricName: UNREAD_COUNT_CACHE_NAME,
  });
}

/**
 * Invalidates one user's cached unread count. Call AFTER the write commits.
 *
 * @remarks
 * - **Algorithm:** writes a tombstone rather than deleting, so an in-flight read cannot reinstate
 *   the pre-write count. The tombstone lives {@link CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS},
 *   NOT the cache TTL — it only has to outlive that racing read's `SET … NX`, and holding the key
 *   cold for a full minute after every mark-read would penalise exactly the users who are using
 *   the app.
 * - **Failure modes:** swallowed and logged; the stale count then expires with the TTL. A wrong
 *   badge for up to a minute is a cosmetic fault, not a security one — which is why this does not
 *   escalate to Sentry the way a permission-cache invalidation failure does.
 * - **Side effects:** one short-lived Redis key.
 * - **Notes:** every path that changes `is_read` or removes a row for a KNOWN user calls this —
 *   mark-read, mark-all-read, delete (only when a row actually went; a 404 changes no count, and
 *   tombstoning on one would let a caller cold-start their own cache by deleting ids that do not
 *   exist), and the invite-accepted producer, per recipient, after its transaction commits. User
 *   offboarding deliberately does NOT: it revokes every session first, and a revoked bearer is
 *   refused by the session-token tombstone, so no request can reach this cache to read the entry.
 */
export async function invalidateCachedUnreadNotificationCount(userPublicId: string): Promise<void> {
  await invalidateTombstonedCacheEntry({
    key: buildUnreadCountCacheKey(userPublicId),
    ttlSeconds: CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS,
    metricName: UNREAD_COUNT_CACHE_NAME,
  });
}

/**
 * Invalidates several users at once — the invite-accepted fan-out.
 *
 * @remarks
 * - **Algorithm:** one tombstone per recipient, issued concurrently. Bounded by the notification
 *   fan-out itself (an organization's `membership:manage` holders), so no chunking is needed.
 * - **Failure modes:** individually swallowed; one unreachable key does not stop the rest.
 * - **Side effects:** one short-lived Redis key per recipient.
 */
export async function invalidateCachedUnreadNotificationCounts(
  userPublicIds: readonly string[],
): Promise<void> {
  await Promise.all(userPublicIds.map(invalidateCachedUnreadNotificationCount));
}
