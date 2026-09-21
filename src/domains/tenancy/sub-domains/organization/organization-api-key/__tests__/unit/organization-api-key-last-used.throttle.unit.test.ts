import { describe, it, expect, vi, beforeEach } from 'vitest';
import { API_KEY_LAST_USED_THROTTLE_TTL_SECONDS } from '@/shared/constants/ttl.constants.js';

const redisSet = vi.fn();
vi.mock('@/infrastructure/cache/redis.client.js', () => ({
  redisConnection: { set: (...args: unknown[]) => redisSet(...args) },
}));

const warn = vi.fn();
vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { warn: (...args: unknown[]) => warn(...args) },
}));

async function importThrottle() {
  return import(
    '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key-last-used.throttle.js'
  );
}

const API_KEY_PUBLIC_ID = 'apikey_e9x2m4qv7c1ktp05rbnwa';

describe('API-key last-used throttle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims the window with SET NX and the throttle TTL', async () => {
    redisSet.mockResolvedValueOnce('OK');
    const { claimApiKeyLastUsedWrite } = await importThrottle();

    await expect(claimApiKeyLastUsedWrite(API_KEY_PUBLIC_ID)).resolves.toBe(true);
    expect(redisSet).toHaveBeenCalledWith(
      `apikey:last-used:${API_KEY_PUBLIC_ID}`,
      '1',
      'EX',
      API_KEY_LAST_USED_THROTTLE_TTL_SECONDS,
      'NX',
    );
  });

  it('refuses a second claim inside the same window', async () => {
    // `NX` returning null is the mechanism, not an error case — it is how every request after the
    // first in a window learns to skip the transaction.
    redisSet.mockResolvedValueOnce(null);
    const { claimApiKeyLastUsedWrite } = await importThrottle();
    await expect(claimApiKeyLastUsedWrite(API_KEY_PUBLIC_ID)).resolves.toBe(false);
  });

  it('keys on the public id, never on the key hash', async () => {
    // The public id is the key's external identity and carries no secret. A hash would work as a
    // key too, but there is no reason to put one in Redis when a non-secret identifier is at hand.
    redisSet.mockResolvedValueOnce('OK');
    const { claimApiKeyLastUsedWrite } = await importThrottle();
    await claimApiKeyLastUsedWrite(API_KEY_PUBLIC_ID);

    const [key] = redisSet.mock.calls[0] as [string];
    expect(key).toBe(`apikey:last-used:${API_KEY_PUBLIC_ID}`);
    // A SHA-256 hex digest is 64 characters; a public id is `<prefix>_<21 [a-z0-9]>`.
    expect(key).not.toMatch(/[0-9a-f]{64}/);
  });

  it('falls back to allowing the write when Redis is unreachable', async () => {
    // Deliberately NOT fail-closed. Under a Redis outage the safe degradation is exactly the
    // behaviour this throttle replaced — one transaction per request — rather than silently
    // freezing a timestamp. No worse than before it existed, and the failure is visible.
    redisSet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { claimApiKeyLastUsedWrite } = await importThrottle();

    await expect(claimApiKeyLastUsedWrite(API_KEY_PUBLIC_ID)).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyPublicId: API_KEY_PUBLIC_ID }),
      'api_key.last_used_throttle.claim.failed',
    );
  });
});
