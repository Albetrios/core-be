import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  buildIdempotencyCacheKey,
  buildIdempotencyClaimCounterShardKey,
  hasAuthenticatedIdempotencyActor,
  IDEMPOTENCY_CLAIM_COUNTER_SHARD_COUNT,
  parseIdempotencyKeyHeader,
  selectIdempotencyClaimCounterShardKey,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from '@/shared/utils/idempotency/idempotency-key.util.js';

describe('buildIdempotencyCacheKey', () => {
  it('scopes keys by organization and user', () => {
    const key = buildIdempotencyCacheKey('my-key', {
      userId: 'user-1',
      organizationId: 'organization-1',
    });
    expect(key).toBe('idempotency:organization-1:user-1:my-key');
  });

  it('uses anonymous when scope is missing', () => {
    const key = buildIdempotencyCacheKey('my-key', {});
    expect(key).toBe('idempotency:none:anonymous:my-key');
  });

  it('separates the same idempotency key across different users (no cross-user replay)', () => {
    const userAKey = buildIdempotencyCacheKey('shared-key', {
      userId: 'user-a',
      organizationId: 'organization-1',
    });
    const userBKey = buildIdempotencyCacheKey('shared-key', {
      userId: 'user-b',
      organizationId: 'organization-1',
    });
    expect(userAKey).not.toBe(userBKey);
  });

  it('separates the same idempotency key across different organizations', () => {
    const organizationAKey = buildIdempotencyCacheKey('shared-key', {
      userId: 'user-1',
      organizationId: 'org-a',
    });
    const organizationBKey = buildIdempotencyCacheKey('shared-key', {
      userId: 'user-1',
      organizationId: 'org-b',
    });
    expect(organizationAKey).not.toBe(organizationBKey);
  });

  it('separates api-key actor from user actor for the same identifier', () => {
    const userScopedKey = buildIdempotencyCacheKey('shared-key', {
      userId: 'public-id-abc',
      organizationId: 'organization-1',
    });
    const apiKeyScopedKey = buildIdempotencyCacheKey('shared-key', {
      apiKeyPublicId: 'public-id-abc',
      organizationId: 'organization-1',
    });
    expect(userScopedKey).not.toBe(apiKeyScopedKey);
    expect(apiKeyScopedKey).toBe('idempotency:organization-1:api-key:public-id-abc:shared-key');
  });

  it('omits the request fingerprint from the key (it is compared via the cache entry instead)', () => {
    // The same key + scope must collide regardless of body so a reuse with a different payload
    // is detected and rejected (422) rather than executing as a second, independent operation.
    const key = buildIdempotencyCacheKey('my-key', {
      userId: 'user-1',
      organizationId: 'organization-1',
    });
    expect(key).toBe('idempotency:organization-1:user-1:my-key');
    expect(key).not.toContain('fingerprint');
  });

  it('prefers api-key over user when both are provided', () => {
    const key = buildIdempotencyCacheKey('my-key', {
      userId: 'user-1',
      apiKeyPublicId: 'api-key-1',
      organizationId: 'organization-1',
    });
    expect(key).toBe('idempotency:organization-1:api-key:api-key-1:my-key');
  });

  it('falls back to user when api-key is empty string', () => {
    const key = buildIdempotencyCacheKey('my-key', {
      userId: 'user-1',
      apiKeyPublicId: '',
      organizationId: 'organization-1',
    });
    expect(key).toBe('idempotency:organization-1:user-1:my-key');
  });
});

describe('hasAuthenticatedIdempotencyActor', () => {
  it('is true when a user id is present', () => {
    expect(hasAuthenticatedIdempotencyActor({ userId: 'user-1' })).toBe(true);
  });

  it('is true when an api key public id is present', () => {
    expect(hasAuthenticatedIdempotencyActor({ apiKeyPublicId: 'api-key-1' })).toBe(true);
  });

  it('is false for an empty scope', () => {
    expect(hasAuthenticatedIdempotencyActor({})).toBe(false);
  });

  it('is false when only an (unverified) organization id is present', () => {
    expect(hasAuthenticatedIdempotencyActor({ organizationId: 'organization-1' })).toBe(false);
  });

  it('is false when actor identifiers are empty strings', () => {
    expect(hasAuthenticatedIdempotencyActor({ userId: '', apiKeyPublicId: '' })).toBe(false);
  });
});

describe('idempotency claim counter sharding', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a shard key under the claim-counter namespace', () => {
    expect(buildIdempotencyClaimCounterShardKey(3)).toBe('idempotency-claim-counter:shard:3');
  });

  it('selects shard keys within the configured shard range', () => {
    // crypto.randomInt(COUNT) always yields an integer in [0, COUNT); sample many to confirm.
    for (let attempt = 0; attempt < 256; attempt += 1) {
      const shard = Number(selectIdempotencyClaimCounterShardKey().split(':').pop());
      expect(Number.isInteger(shard)).toBe(true);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(IDEMPOTENCY_CLAIM_COUNTER_SHARD_COUNT);
    }
  });

  it('never selects a shard outside the namespace prefix', () => {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      expect(selectIdempotencyClaimCounterShardKey()).toMatch(
        /^idempotency-claim-counter:shard:\d+$/,
      );
    }
  });
});

describe('parseIdempotencyKeyHeader', () => {
  it('returns absent when header is missing or empty', () => {
    expect(parseIdempotencyKeyHeader(undefined).kind).toBe('absent');
    expect(parseIdempotencyKeyHeader('').kind).toBe('absent');
    expect(parseIdempotencyKeyHeader('   ').kind).toBe('absent');
  });

  it('returns valid and trims', () => {
    const parsed = parseIdempotencyKeyHeader('  abc-123-456-789-0  ');
    expect(parsed).toEqual({ kind: 'valid', value: 'abc-123-456-789-0' });
  });

  it('returns invalid when too long', () => {
    expect(parseIdempotencyKeyHeader('a'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)).kind).toBe(
      'invalid',
    );
  });

  it('returns invalid for disallowed characters', () => {
    expect(parseIdempotencyKeyHeader('foo bar').kind).toBe('invalid');
    expect(parseIdempotencyKeyHeader('你好').kind).toBe('invalid');
  });

  it('uses the first value when the header is an array', () => {
    expect(parseIdempotencyKeyHeader(['  first-value-1234  ', 'second'])).toEqual({
      kind: 'valid',
      value: 'first-value-1234',
    });
  });

  it('returns invalid when shorter than the minimum length', () => {
    // 15 allowed-charset chars sit below the 16-char floor → invalid (422 idempotencyKeyInvalid).
    expect(parseIdempotencyKeyHeader('abcdefghijklmno').kind).toBe('invalid');
    expect(parseIdempotencyKeyHeader('a'.repeat(15)).kind).toBe('invalid');
  });

  it('accepts a key at exactly the minimum length and a UUID', () => {
    expect(parseIdempotencyKeyHeader('abcdefghijklmnop')).toEqual({
      kind: 'valid',
      value: 'abcdefghijklmnop',
    });
    expect(parseIdempotencyKeyHeader('3f9c2a7e-9b1d-4f6a-8c2e-1a2b3c4d5e6f')).toEqual({
      kind: 'valid',
      value: '3f9c2a7e-9b1d-4f6a-8c2e-1a2b3c4d5e6f',
    });
  });
});
