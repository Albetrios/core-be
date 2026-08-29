import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SESSION_TOKEN_CACHE_TTL_SECONDS } from '@/shared/constants/index.js';

const redisSet = vi.fn().mockResolvedValue('OK');
const redisGet = vi.fn().mockResolvedValue(null);
const redisDel = vi.fn().mockResolvedValue(1);

vi.mock('@/infrastructure/cache/redis.client.js', () => ({
  redisConnection: {
    set: (...args: unknown[]) => redisSet(...args),
    get: (...args: unknown[]) => redisGet(...args),
    del: (...args: unknown[]) => redisDel(...args),
  },
}));

const NOW = new Date('2026-05-29T12:00:00.000Z').getTime();

describe('setCachedSessionTokenValid (bounded TTL)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps the TTL at the full cache window when the session outlives it', async () => {
    const { setCachedSessionTokenValid } = await import(
      '@/domains/auth/sub-domains/auth-session/session-token-cache.service.js'
    );
    await setCachedSessionTokenValid({
      sessionTokenHash: 'hash-long',
      sessionPublicId: 'sess_long',
      sessionExpiresAt: new Date(NOW + 60 * 60 * 1000),
    });
    expect(redisSet).toHaveBeenCalledWith(
      'session:tok:hash-long',
      'sess_long',
      'EX',
      SESSION_TOKEN_CACHE_TTL_SECONDS,
      'NX',
    );
  });

  it('shortens the TTL to the remaining session lifetime when it expires sooner', async () => {
    const { setCachedSessionTokenValid } = await import(
      '@/domains/auth/sub-domains/auth-session/session-token-cache.service.js'
    );
    await setCachedSessionTokenValid({
      sessionTokenHash: 'hash-short',
      sessionPublicId: 'sess_short',
      sessionExpiresAt: new Date(NOW + 10_000),
    });
    expect(redisSet).toHaveBeenCalledWith('session:tok:hash-short', 'sess_short', 'EX', 10, 'NX');
  });

  it('does not cache when the session has already expired', async () => {
    const { setCachedSessionTokenValid } = await import(
      '@/domains/auth/sub-domains/auth-session/session-token-cache.service.js'
    );
    await setCachedSessionTokenValid({
      sessionTokenHash: 'hash-expired',
      sessionPublicId: 'sess_expired',
      sessionExpiresAt: new Date(NOW - 1_000),
    });
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('does not cache when the bounded TTL rounds down to zero', async () => {
    const { setCachedSessionTokenValid } = await import(
      '@/domains/auth/sub-domains/auth-session/session-token-cache.service.js'
    );
    await setCachedSessionTokenValid({
      sessionTokenHash: 'hash-sub-second',
      sessionPublicId: 'sess_sub',
      sessionExpiresAt: new Date(NOW + 500),
    });
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('swallows Redis errors so the caller still succeeds', async () => {
    redisSet.mockRejectedValueOnce(new Error('redis down'));
    const { setCachedSessionTokenValid } = await import(
      '@/domains/auth/sub-domains/auth-session/session-token-cache.service.js'
    );
    await expect(
      setCachedSessionTokenValid({
        sessionTokenHash: 'hash-error',
        sessionPublicId: 'sess_error',
        sessionExpiresAt: new Date(NOW + 60_000),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("revocation tombstone (route-audit session-#1: revoke can't be repopulated)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invalidate writes a short-lived REVOKED tombstone (not a DEL) so a racing populate can't un-revoke", async () => {
    const { invalidateCachedSessionToken } = await import(
      '@/domains/auth/sub-domains/auth-session/session-token-cache.service.js'
    );
    await invalidateCachedSessionToken('hash-revoked');
    expect(redisSet).toHaveBeenCalledWith(
      'session:tok:hash-revoked',
      '__revoked__',
      'EX',
      SESSION_TOKEN_CACHE_TTL_SECONDS,
    );
    expect(redisDel).not.toHaveBeenCalled();
  });

  it('reads a tombstoned hash as a cache MISS so the caller re-checks Postgres (which denies it)', async () => {
    redisGet.mockResolvedValueOnce('__revoked__');
    const { getCachedSessionTokenValid } = await import(
      '@/domains/auth/sub-domains/auth-session/session-token-cache.service.js'
    );
    expect(await getCachedSessionTokenValid('hash-revoked')).toBeNull();
  });

  it('returns the cached session public id on a normal (non-tombstone) hit', async () => {
    redisGet.mockResolvedValueOnce('sess_live');
    const { getCachedSessionTokenValid } = await import(
      '@/domains/auth/sub-domains/auth-session/session-token-cache.service.js'
    );
    expect(await getCachedSessionTokenValid('hash-live')).toBe('sess_live');
  });
});
