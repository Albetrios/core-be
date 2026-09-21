import { afterEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  RATE_LIMIT_RELAXED_CAPS: true as boolean,
}));

vi.mock('@/shared/config/env.config.js', () => ({
  env: mockEnv,
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/infrastructure/observability/sentry/sentry.js', () => ({
  Sentry: { addBreadcrumb: vi.fn() },
}));

describe('rate-limit-presets', () => {
  afterEach(() => {
    mockEnv.RATE_LIMIT_RELAXED_CAPS = true;
    vi.resetModules();
  });

  it('STRICT_PUBLIC_RATE_LIMIT allows 5000 req/min when RATE_LIMIT_RELAXED_CAPS', async () => {
    mockEnv.RATE_LIMIT_RELAXED_CAPS = true;
    const { STRICT_PUBLIC_RATE_LIMIT } = await import(
      '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js'
    );
    expect(STRICT_PUBLIC_RATE_LIMIT.config.rateLimit.max).toBe(5000);
  });

  it('STRICT_PUBLIC_RATE_LIMIT caps public auth routes at 5 req/min outside test', async () => {
    mockEnv.RATE_LIMIT_RELAXED_CAPS = false;
    const { STRICT_PUBLIC_RATE_LIMIT } = await import(
      '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js'
    );
    expect(STRICT_PUBLIC_RATE_LIMIT.config.rateLimit.max).toBe(5);
    expect(STRICT_PUBLIC_RATE_LIMIT.config.rateLimit.timeWindow).toBe(60_000);
  });

  it('STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS caps per email at 5 / 15 min on preHandler outside test', async () => {
    mockEnv.RATE_LIMIT_RELAXED_CAPS = false;
    const { STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS } = await import(
      '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js'
    );
    expect(STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS.max).toBe(5);
    expect(STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS.timeWindow).toBe(15 * 60_000);
    expect(STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS.hook).toBe('preHandler');
  });

  it('STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS lifts the cap when RATE_LIMIT_RELAXED_CAPS', async () => {
    mockEnv.RATE_LIMIT_RELAXED_CAPS = true;
    const { STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS } = await import(
      '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js'
    );
    expect(STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS.max).toBe(5000);
  });

  it('sec-re-11: per-email key generator hashes the normalized body email and never embeds the raw address', async () => {
    // Prior to this fix the key was `email:user@example.com` verbatim — the
    // literal value Redis stored, the value the structured log carried, and
    // the value the Sentry breadcrumb message embedded. Hashing makes the
    // bucket stable (deterministic per address) while keeping the
    // log/breadcrumb value opaque so a credential-stuffing run no longer
    // ships the targeted addresses to observability.
    const crypto = await import('node:crypto');
    mockEnv.RATE_LIMIT_RELAXED_CAPS = false;
    const { STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS } = await import(
      '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js'
    );
    const keyGenerator = STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS.keyGenerator;
    expect(keyGenerator).toBeDefined();
    const key = await keyGenerator?.({
      ip: '203.0.113.7',
      body: { email: '  USER@Example.COM ' },
    } as never);
    // Normalization (trim + lowercase) THEN hash, then take the first 16 hex chars.
    const expectedHashPrefix = crypto
      .createHash('sha256')
      .update('user@example.com')
      .digest('hex')
      .slice(0, 16);
    expect(key).toBe(`email:${expectedHashPrefix}`);
    // Belt-and-braces: the raw address must not appear anywhere.
    expect(key).not.toContain('user@example.com');
    expect(key).not.toContain('@');
  });

  it('sec-re-11: per-email key generator yields stable buckets per address (same email → same key)', async () => {
    mockEnv.RATE_LIMIT_RELAXED_CAPS = false;
    const { STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS } = await import(
      '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js'
    );
    const keyGenerator = STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS.keyGenerator;
    const keyFromFirstIp = await keyGenerator?.({
      ip: '203.0.113.7',
      body: { email: 'victim@example.com' },
    } as never);
    const keyFromDifferentIp = await keyGenerator?.({
      ip: '198.51.100.4', // Different IP — bucket must still collapse on the same email.
      body: { email: 'victim@example.com' },
    } as never);
    expect(keyFromFirstIp).toBe(keyFromDifferentIp);

    // And different emails yield different buckets.
    const otherKey = await keyGenerator?.({
      ip: '203.0.113.7',
      body: { email: 'someone-else@example.com' },
    } as never);
    expect(otherKey).not.toBe(keyFromFirstIp);
  });

  it('per-email key generator falls back to IP when the body has no usable email', async () => {
    mockEnv.RATE_LIMIT_RELAXED_CAPS = false;
    const { STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS } = await import(
      '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js'
    );
    const keyGenerator = STRICT_PUBLIC_PER_EMAIL_RATE_LIMIT_OPTIONS.keyGenerator;
    const key = await keyGenerator?.({ ip: '203.0.113.7', body: {} } as never);
    expect(key).toBe('ip:203.0.113.7');
  });

  it('org-scoped key namespaces the organization by actor so victim buckets are isolated (audit #14)', async () => {
    const { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } = await import(
      '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js'
    );
    const keyGenerator = ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config.rateLimit.keyGenerator;
    expect(keyGenerator).toBeDefined();

    // An attacker and a real member hitting the SAME victim organization resolve to DIFFERENT buckets,
    // so the attacker can never drain the member's quota.
    const attackerKey = await keyGenerator?.({
      ip: '203.0.113.7',
      organizationId: 'victim-organization',
      auth: { kind: 'user', userId: 'attacker-user' },
    } as never);
    const memberKey = await keyGenerator?.({
      ip: '198.51.100.4',
      organizationId: 'victim-organization',
      auth: { kind: 'user', userId: 'member-user' },
    } as never);

    expect(attackerKey).toBe('organization:victim-organization:actor:attacker-user');
    expect(memberKey).toBe('organization:victim-organization:actor:member-user');
    expect(attackerKey).not.toBe(memberKey);
  });

  it('org-scoped key namespaces API-key actors and falls back to actor, then IP', async () => {
    const { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } = await import(
      '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js'
    );
    const keyGenerator = ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config.rateLimit.keyGenerator;

    // Production shape: an API-key principal carries `kind: 'apiKey'` and no `userId`. The old
    // `userId ?? apiKeyPublicId` returned the empty-string user sentinel here, collapsing the
    // bucket to `ip:` (finding D); the actor helper now resolves the api-key public id.
    const apiKeyActor = await keyGenerator?.({
      ip: '203.0.113.7',
      organizationId: 'organization-1',
      auth: { kind: 'apiKey', apiKeyPublicId: 'apikey-1' },
    } as never);
    expect(apiKeyActor).toBe('organization:organization-1:actor:apikey-1');

    const noOrgContext = await keyGenerator?.({
      ip: '203.0.113.7',
      auth: { kind: 'user', userId: 'user-1' },
    } as never);
    expect(noOrgContext).toBe('actor:user-1');

    const unauthenticated = await keyGenerator?.({
      ip: '203.0.113.7',
      auth: undefined,
    } as never);
    expect(unauthenticated).toBe('ip:203.0.113.7');
  });
});
