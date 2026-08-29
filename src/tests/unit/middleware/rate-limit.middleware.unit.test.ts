import Fastify from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { rateLimitPlugin } = vi.hoisted(() => ({
  rateLimitPlugin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@fastify/rate-limit', () => ({
  default: rateLimitPlugin,
}));

vi.mock('@/shared/config/env.config.js', () => ({
  env: {
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60_000,
    REDIS_URL: 'redis://127.0.0.1:6379',
  },
}));

vi.mock('@/infrastructure/cache/redis.client.js', () => ({
  redisConnection: { ping: vi.fn() },
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/infrastructure/observability/sentry/sentry.js', () => ({
  Sentry: { addBreadcrumb: vi.fn() },
}));

import rateLimitMiddleware from '@/shared/middlewares/rate-limit/rate-limit.middleware.js';

describe('rate-limit.middleware', () => {
  let application: ReturnType<typeof Fastify>;

  afterEach(async () => {
    vi.clearAllMocks();
    if (application) {
      await application.close();
    }
  });

  it('uses Redis-backed rate limiting when RUN_REDIS_TESTS is enabled', async () => {
    const previousFlag = process.env.RUN_REDIS_TESTS;
    process.env.RUN_REDIS_TESTS = '1';
    vi.resetModules();
    vi.doMock('@/shared/config/env.config.js', () => ({
      env: {
        NODE_ENV: 'development',
        RATE_LIMIT_MAX: 100,
        RATE_LIMIT_WINDOW_MS: 60_000,
        REDIS_URL: 'redis://127.0.0.1:6379',
      },
    }));
    const { default: redisRateLimitMiddleware } = await import(
      '@/shared/middlewares/rate-limit/rate-limit.middleware.js'
    );
    application = Fastify();
    await application.register(redisRateLimitMiddleware);
    await application.ready();

    // The Redis-backed config now uses a fallback store (Redis with in-process failover)
    // rather than passing `redis` directly, so a Redis blip degrades instead of skipping.
    const options = rateLimitPlugin.mock.calls.at(-1)![1] as { store?: unknown; redis?: unknown };
    expect(options.store).toBeDefined();
    expect(options.redis).toBeUndefined();
    process.env.RUN_REDIS_TESTS = previousFlag;
    vi.resetModules();
  });

  it('registers a global IP-keyed rate limit without Redis in test environment', async () => {
    application = Fastify();
    await application.register(rateLimitMiddleware);
    await application.ready();

    expect(rateLimitPlugin).toHaveBeenCalled();
    const options = rateLimitPlugin.mock.calls[0]![1] as {
      global: boolean;
      max: number;
      timeWindow: number;
      skipOnError: boolean;
      allowList: (request: { url: string }) => boolean;
    };
    expect(options.global).toBe(true);
    // Global cap is a fixed per-IP number; organization/user quotas live in post-auth presets.
    expect(options.max).toBe(100);
    expect(options.timeWindow).toBe(60_000);
    // Fail-open on Redis blip — a few seconds of unmetered traffic beats a blanket 5xx.
    expect(options.skipOnError).toBe(true);
    expect(options.allowList({ url: '/livez' })).toBe(true);
    expect(options.allowList({ url: '/readyz' })).toBe(true);
    // The removed /health route is no longer allow-listed.
    expect(options.allowList({ url: '/health' })).toBe(false);
    expect(options.allowList({ url: testApiPath('/auth/login') })).toBe(false);
  });

  it('registers in-memory rate limiting when Redis is not configured', async () => {
    const previousFlag = process.env.RUN_REDIS_TESTS;
    delete process.env.RUN_REDIS_TESTS;
    vi.resetModules();
    vi.doMock('@/shared/config/env.config.js', () => ({
      env: {
        NODE_ENV: 'development',
        RATE_LIMIT_MAX: 25,
        RATE_LIMIT_WINDOW_MS: 15_000,
        REDIS_URL: undefined,
      },
    }));
    const { default: developmentRateLimitMiddleware } = await import(
      '@/shared/middlewares/rate-limit/rate-limit.middleware.js'
    );
    application = Fastify();
    await application.register(developmentRateLimitMiddleware);
    await application.ready();

    const options = rateLimitPlugin.mock.calls.at(-1)![1] as { store?: unknown; redis?: unknown };
    expect(options.store).toBeUndefined();
    expect(options.redis).toBeUndefined();
    process.env.RUN_REDIS_TESTS = previousFlag;
    vi.resetModules();
  });

  it('uses Redis-backed rate limiting in production', async () => {
    const previousFlag = process.env.RUN_REDIS_TESTS;
    delete process.env.RUN_REDIS_TESTS;
    vi.resetModules();
    vi.doMock('@/shared/config/env.config.js', () => ({
      env: {
        NODE_ENV: 'production',
        RATE_LIMIT_MAX: 50,
        RATE_LIMIT_WINDOW_MS: 30_000,
        REDIS_URL: 'redis://127.0.0.1:6379',
      },
    }));
    const { default: productionRateLimitMiddleware } = await import(
      '@/shared/middlewares/rate-limit/rate-limit.middleware.js'
    );
    application = Fastify();
    await application.register(productionRateLimitMiddleware);
    await application.ready();

    const options = rateLimitPlugin.mock.calls.at(-1)![1] as {
      store?: unknown;
      redis?: unknown;
      skipOnError: boolean;
    };
    // Production uses the Redis fallback store (Redis + in-process failover), not raw `redis`.
    expect(options.store).toBeDefined();
    expect(options.redis).toBeUndefined();
    // skipOnError remains as a last-resort guard even though the fallback store never throws.
    expect(options.skipOnError).toBe(true);
    process.env.RUN_REDIS_TESTS = previousFlag;
    vi.resetModules();
  });

  it('ignores RUN_REDIS_TESTS=0 in production and keeps the Redis-backed store', async () => {
    const previousFlag = process.env.RUN_REDIS_TESTS;
    // A stray chaos-suite switch leaking into a prod env must NOT downgrade the cluster-wide
    // Redis limiter to per-process counting — RUN_REDIS_TESTS is honored only outside production.
    process.env.RUN_REDIS_TESTS = '0';
    vi.resetModules();
    vi.doMock('@/shared/config/env.config.js', () => ({
      env: {
        NODE_ENV: 'production',
        RATE_LIMIT_MAX: 50,
        RATE_LIMIT_WINDOW_MS: 30_000,
        REDIS_URL: 'redis://127.0.0.1:6379',
      },
    }));
    const { default: productionRateLimitMiddleware } = await import(
      '@/shared/middlewares/rate-limit/rate-limit.middleware.js'
    );
    application = Fastify();
    await application.register(productionRateLimitMiddleware);
    await application.ready();

    const options = rateLimitPlugin.mock.calls.at(-1)![1] as { store?: unknown };
    expect(options.store).toBeDefined();
    process.env.RUN_REDIS_TESTS = previousFlag;
    vi.resetModules();
  });

  it('honors RUN_REDIS_TESTS=0 only outside production (in-memory store)', async () => {
    const previousFlag = process.env.RUN_REDIS_TESTS;
    process.env.RUN_REDIS_TESTS = '0';
    vi.resetModules();
    vi.doMock('@/shared/config/env.config.js', () => ({
      env: {
        NODE_ENV: 'development',
        RATE_LIMIT_MAX: 100,
        RATE_LIMIT_WINDOW_MS: 60_000,
        REDIS_URL: 'redis://127.0.0.1:6379',
        RATE_LIMIT_IN_MEMORY_FALLBACK_ALLOWED: true,
      },
    }));
    const { default: testRateLimitMiddleware } = await import(
      '@/shared/middlewares/rate-limit/rate-limit.middleware.js'
    );
    application = Fastify();
    await application.register(testRateLimitMiddleware);
    await application.ready();

    const options = rateLimitPlugin.mock.calls.at(-1)![1] as { store?: unknown };
    expect(options.store).toBeUndefined();
    process.env.RUN_REDIS_TESTS = previousFlag;
    vi.resetModules();
  });

  it('always sets skipOnError: true so Redis outages cannot blanket-fail the API', async () => {
    const previousFlag = process.env.RUN_REDIS_TESTS;
    delete process.env.RUN_REDIS_TESTS;
    vi.resetModules();
    vi.doMock('@/shared/config/env.config.js', () => ({
      env: {
        NODE_ENV: 'development',
        RATE_LIMIT_MAX: 25,
        RATE_LIMIT_WINDOW_MS: 15_000,
        REDIS_URL: undefined,
      },
    }));
    const { default: developmentRateLimitMiddleware } = await import(
      '@/shared/middlewares/rate-limit/rate-limit.middleware.js'
    );
    application = Fastify();
    await application.register(developmentRateLimitMiddleware);
    await application.ready();

    // Even the in-memory configuration registers skipOnError: true, so the option is
    // never accidentally dropped when toggling between stores.
    const options = rateLimitPlugin.mock.calls.at(-1)![1] as { skipOnError: boolean };
    expect(options.skipOnError).toBe(true);
    process.env.RUN_REDIS_TESTS = previousFlag;
    vi.resetModules();
  });

  describe('keyGenerator and allowList', () => {
    it('always keys on request.ip, ignoring the request-asserted organizationId', async () => {
      application = Fastify();
      await application.register(rateLimitMiddleware);
      await application.ready();
      const options = rateLimitPlugin.mock.calls.at(-1)![1] as {
        keyGenerator: (request: { organizationId?: string; ip: string }) => string;
      };
      // A forged/fresh or victim organization id must not influence the global per-IP bucket.
      expect(options.keyGenerator({ organizationId: 'org_public_1', ip: '1.2.3.4' })).toBe(
        '1.2.3.4',
      );
      expect(options.keyGenerator({ ip: '1.2.3.4' })).toBe('1.2.3.4');
      expect(options.keyGenerator({ organizationId: '', ip: '1.2.3.4' })).toBe('1.2.3.4');
    });

    it('allowList exact-matches the liveness/readiness probe paths and rejects prefix collisions', async () => {
      application = Fastify();
      await application.register(rateLimitMiddleware);
      await application.ready();
      const options = rateLimitPlugin.mock.calls.at(-1)![1] as {
        allowList: (request: { url: string }) => boolean;
      };
      // Real probe endpoints are allowed (exact path match)
      expect(options.allowList({ url: '/livez' })).toBe(true);
      expect(options.allowList({ url: '/readyz' })).toBe(true);
      // Query strings are stripped before matching
      expect(options.allowList({ url: '/readyz?verbose=1' })).toBe(true);
      expect(options.allowList({ url: '/livez?probe=docker' })).toBe(true);

      // Prefix collisions must NOT be allowed — exact match, not startsWith/contains
      expect(options.allowList({ url: '/livezz' })).toBe(false);
      expect(options.allowList({ url: '/readyzz' })).toBe(false);
      // The removed /health route (and its prefix collisions) are no longer allow-listed.
      expect(options.allowList({ url: '/health' })).toBe(false);
      expect(options.allowList({ url: '/healthxyz' })).toBe(false);
      expect(options.allowList({ url: testApiPath('/healthcheck') })).toBe(false);
      expect(options.allowList({ url: testApiPath('/health-tracker') })).toBe(false);
      expect(options.allowList({ url: '/foo/health/bar' })).toBe(false);
      expect(options.allowList({ url: testApiPath('/auth/login') })).toBe(false);
    });
  });
});
