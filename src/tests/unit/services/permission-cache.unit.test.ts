import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock Redis client module.
// NOTE: The factory passed to vi.mock is hoisted, so we must avoid
// referencing any top-level variables inside it.
vi.mock('@/infrastructure/cache/redis.client.js', () => {
  const redisConnection = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    scan: vi.fn(),
  };

  return { redisConnection };
});

import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { mockedRedisSet } from '@/tests/helpers/redis-mock.helper.js';
import {
  getCachedPermissions,
  setCachedPermissions,
  invalidatePermissions,
} from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';

describe('PermissionCacheService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getCachedPermissions', () => {
    it('returns null on cache miss', async () => {
      vi.mocked(redisConnection.get).mockResolvedValue(null);
      const result = await getCachedPermissions('user-1', 'organization-1');
      expect(result).toBeNull();
      expect(redisConnection.get).toHaveBeenCalledWith('perm:org:organization-1:v');
      expect(redisConnection.get).toHaveBeenCalledWith('perm:0:user-1:organization-1');
    });

    it('returns parsed codes on cache hit', async () => {
      // The integer version key and the JSON data key are distinct — mock per-key so the
      // version reader parses an integer, not the codes array.
      vi.mocked(redisConnection.get).mockImplementation(async (key) =>
        String(key).startsWith('perm:org:')
          ? '0'
          : JSON.stringify(['billing:read', 'billing:manage']),
      );
      const result = await getCachedPermissions('user-1', 'organization-1');
      expect(result).toEqual(['billing:read', 'billing:manage']);
    });

    it('returns null on Redis error', async () => {
      vi.mocked(redisConnection.get).mockRejectedValue(new Error('Redis down'));
      const result = await getCachedPermissions('user-1', 'organization-1');
      expect(result).toBeNull();
    });
  });

  describe('setCachedPermissions', () => {
    it('stores codes in Redis with TTL plus jitter', async () => {
      vi.mocked(redisConnection.get).mockResolvedValue(null); // organization version unset → 0
      mockedRedisSet(redisConnection.set).mockResolvedValue('OK');
      await setCachedPermissions('user-1', 'organization-1', ['billing:read'], 600);
      expect(redisConnection.set).toHaveBeenCalledTimes(1);
      const args = mockedRedisSet(redisConnection.set).mock.calls[0]!;
      expect(args[0]).toBe('perm:0:user-1:organization-1');
      expect(args[1]).toBe('["billing:read"]');
      expect(args[2]).toBe('EX');
      const ttlSeconds = Number(args[3]);
      expect(ttlSeconds).toBeGreaterThanOrEqual(600);
      expect(ttlSeconds).toBeLessThanOrEqual(600 + 60);
    });
  });

  describe('invalidatePermissions', () => {
    it('deletes the cache key and recompute lock', async () => {
      vi.mocked(redisConnection.get).mockResolvedValue(null); // organization version unset → 0
      vi.mocked(redisConnection.del).mockResolvedValue(1);
      await invalidatePermissions('user-1', 'organization-1');
      expect(redisConnection.del).toHaveBeenCalledWith(
        'perm:0:user-1:organization-1',
        'perm:lock:user-1:organization-1',
      );
    });
  });
});
