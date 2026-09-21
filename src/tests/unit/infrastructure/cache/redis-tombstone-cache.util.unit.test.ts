import { describe, it, expect, vi, beforeEach } from 'vitest';

const redisSet = vi.fn().mockResolvedValue('OK');
const redisGet = vi.fn().mockResolvedValue(null);

vi.mock('@/infrastructure/cache/redis.client.js', () => ({
  redisConnection: {
    set: (...args: unknown[]) => redisSet(...args),
    get: (...args: unknown[]) => redisGet(...args),
  },
}));

const warn = vi.fn();
vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { warn: (...args: unknown[]) => warn(...args) },
}));

async function importUtil() {
  return import('@/infrastructure/cache/redis-tombstone-cache.util.js');
}

const KEY = 'thing:scope_abc';
const METRIC = 'thing_cache';

describe('redis-tombstone-cache — read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stored value on a hit', async () => {
    redisGet.mockResolvedValueOnce('41');
    const { readTombstonedCacheEntry } = await importUtil();
    await expect(readTombstonedCacheEntry(KEY, METRIC)).resolves.toBe('41');
  });

  it('reads an invalidation tombstone as a miss', async () => {
    redisGet.mockResolvedValueOnce('__invalidated__');
    const { readTombstonedCacheEntry } = await importUtil();
    await expect(readTombstonedCacheEntry(KEY, METRIC)).resolves.toBeNull();
  });

  it('reads an empty string as a miss rather than as a value', async () => {
    redisGet.mockResolvedValueOnce('');
    const { readTombstonedCacheEntry } = await importUtil();
    await expect(readTombstonedCacheEntry(KEY, METRIC)).resolves.toBeNull();
  });

  it('degrades to a miss when Redis is unreachable, and says so in the log', async () => {
    redisGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { readTombstonedCacheEntry } = await importUtil();
    await expect(readTombstonedCacheEntry(KEY, METRIC)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: KEY }),
      'thing_cache.cache.get.failed',
    );
  });
});

describe('redis-tombstone-cache — populate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes with NX so a racing invalidation wins over a late populate', async () => {
    const { populateTombstonedCacheEntry } = await importUtil();
    await populateTombstonedCacheEntry({
      key: KEY,
      value: '7',
      ttlSeconds: 60,
      metricName: METRIC,
    });
    expect(redisSet).toHaveBeenCalledWith(KEY, '7', 'EX', 60, 'NX');
  });

  it('writes nothing when the TTL has already elapsed', async () => {
    const { populateTombstonedCacheEntry } = await importUtil();
    await populateTombstonedCacheEntry({ key: KEY, value: '7', ttlSeconds: 0, metricName: METRIC });
    await populateTombstonedCacheEntry({
      key: KEY,
      value: '7',
      ttlSeconds: -5,
      metricName: METRIC,
    });
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('swallows a Redis failure — the caller already has its answer', async () => {
    redisSet.mockRejectedValueOnce(new Error('OOM'));
    const { populateTombstonedCacheEntry } = await importUtil();
    await expect(
      populateTombstonedCacheEntry({ key: KEY, value: '7', ttlSeconds: 60, metricName: METRIC }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: KEY }),
      'thing_cache.cache.set.failed',
    );
  });
});

describe('redis-tombstone-cache — invalidate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes a tombstone instead of deleting the key', async () => {
    const { invalidateTombstonedCacheEntry } = await importUtil();
    await invalidateTombstonedCacheEntry({ key: KEY, ttlSeconds: 60, metricName: METRIC });
    expect(redisSet).toHaveBeenCalledWith(KEY, '__invalidated__', 'EX', 60);
  });

  it('closes the read-through race a DEL would leave open', async () => {
    const {
      invalidateTombstonedCacheEntry,
      populateTombstonedCacheEntry,
      readTombstonedCacheEntry,
    } = await importUtil();

    // A real Redis, reduced to the two commands this protocol depends on. `SET … NX` must refuse
    // when a value is present — that refusal IS the mechanism, so a test that stubs it away would
    // pass against a DEL-based implementation too.
    const store = new Map<string, string>();
    redisSet.mockImplementation(async (key: string, value: string, _ex, _ttl, nx?: string) => {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    });
    redisGet.mockImplementation(async (key: string) => store.get(key) ?? null);

    // A reader counts the pre-write state…
    const staleValue = '5';
    // …the write lands and invalidates…
    await invalidateTombstonedCacheEntry({ key: KEY, ttlSeconds: 60, metricName: METRIC });
    // …and only then does the slow reader try to install what it computed.
    await populateTombstonedCacheEntry({
      key: KEY,
      value: staleValue,
      ttlSeconds: 60,
      metricName: METRIC,
    });

    expect(store.get(KEY)).toBe('__invalidated__');
    await expect(readTombstonedCacheEntry(KEY, METRIC)).resolves.toBeNull();
  });

  it('swallows a Redis failure — staleness stays bounded by the TTL', async () => {
    redisSet.mockRejectedValueOnce(new Error('READONLY'));
    const { invalidateTombstonedCacheEntry } = await importUtil();
    await expect(
      invalidateTombstonedCacheEntry({ key: KEY, ttlSeconds: 60, metricName: METRIC }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: KEY }),
      'thing_cache.cache.invalidate.failed',
    );
  });
});
