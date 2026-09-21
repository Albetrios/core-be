import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS,
  NOTIFICATION_UNREAD_COUNT_CACHE_TTL_SECONDS,
} from '@/shared/constants/ttl.constants.js';

const redisSet = vi.fn().mockResolvedValue('OK');
const redisGet = vi.fn().mockResolvedValue(null);

vi.mock('@/infrastructure/cache/redis.client.js', () => ({
  redisConnection: {
    set: (...args: unknown[]) => redisSet(...args),
    get: (...args: unknown[]) => redisGet(...args),
  },
}));

const recordReadCacheRequest = vi.fn();
vi.mock('@/infrastructure/observability/metrics/prometheus-metrics.js', () => ({
  recordReadCacheRequest: (...args: unknown[]) => recordReadCacheRequest(...args),
}));

async function importCache() {
  return import('@/domains/notify/sub-domains/notification/notification-unread-count.cache.js');
}

const USER = 'usr_kkcpmt8ryin7o5s9jr4av';
const KEY = `notify:unread-count:${USER}`;

describe('unread-count cache — key and TTLs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisSet.mockResolvedValue('OK');
    redisGet.mockResolvedValue(null);
  });

  it('keys on the user public id alone, with no deployment prefix', async () => {
    // ioredis prepends the configured prefix itself. A key that includes it here is written
    // double-prefixed: it never hits, and the test-teardown SCAN never clears it either.
    const { setCachedUnreadNotificationCount } = await importCache();
    await setCachedUnreadNotificationCount(USER, 3);
    expect(redisSet).toHaveBeenCalledWith(KEY, '3', 'EX', expect.any(Number), 'NX');
  });

  it('populates for the cache TTL and tombstones for the much shorter race window', async () => {
    // The two numbers answer different questions, and passing one where the other belongs is the
    // hazard this pins. The cache TTL bounds how stale a badge may be; the tombstone only has to
    // outlive the in-flight read about to issue its `SET … NX`. Making them equal is safe but
    // leaves the key cold for a full minute after every write — so the users interacting most
    // are exactly the ones who lose the cache.
    const { setCachedUnreadNotificationCount, invalidateCachedUnreadNotificationCount } =
      await importCache();

    await setCachedUnreadNotificationCount(USER, 3);
    expect(redisSet).toHaveBeenCalledWith(
      KEY,
      '3',
      'EX',
      NOTIFICATION_UNREAD_COUNT_CACHE_TTL_SECONDS,
      'NX',
    );

    redisSet.mockClear();
    await invalidateCachedUnreadNotificationCount(USER);
    expect(redisSet).toHaveBeenCalledWith(
      KEY,
      '__invalidated__',
      'EX',
      CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS,
    );
    expect(CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS).toBeLessThan(
      NOTIFICATION_UNREAD_COUNT_CACHE_TTL_SECONDS,
    );
  });

  it('reports hit and miss so the cache can be judged on its hit ratio', async () => {
    const { getCachedUnreadNotificationCount } = await importCache();

    redisGet.mockResolvedValueOnce('7');
    await expect(getCachedUnreadNotificationCount(USER)).resolves.toBe(7);
    expect(recordReadCacheRequest).toHaveBeenLastCalledWith('notify_unread_count', 'hit');

    redisGet.mockResolvedValueOnce(null);
    await expect(getCachedUnreadNotificationCount(USER)).resolves.toBeNull();
    expect(recordReadCacheRequest).toHaveBeenLastCalledWith('notify_unread_count', 'miss');
  });

  it('treats a non-integer payload as a miss rather than trusting it', async () => {
    // A `Number('')` is 0 and a `Number('abc')` is NaN — the first would serve a silently wrong
    // "no unread notifications", which is the failure a user would never report as a cache bug.
    const { getCachedUnreadNotificationCount } = await importCache();
    for (const payload of ['', 'abc', '3.5', '{"count":3}']) {
      redisGet.mockResolvedValueOnce(payload);
      await expect(getCachedUnreadNotificationCount(USER)).resolves.toBeNull();
    }
  });

  it('tombstones every recipient of a fan-out, and one failure does not stop the rest', async () => {
    const { invalidateCachedUnreadNotificationCounts } = await importCache();
    redisSet.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(
      invalidateCachedUnreadNotificationCounts(['usr_one', 'usr_two', 'usr_three']),
    ).resolves.toBeUndefined();
    expect(redisSet).toHaveBeenCalledTimes(3);
  });
});
