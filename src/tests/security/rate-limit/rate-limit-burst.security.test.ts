import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { describe, it, expect, afterEach } from 'vitest';

/**
 * Burst rate-limit tests with an isolated app (production test env lifts public caps to 5000).
 */
describe('Security: Rate limit burst (429)', () => {
  const apps: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  async function createRateLimitedApp(options: {
    max: number;
    keyGenerator: (request: { ip: string; headers: Record<string, string | undefined> }) => string;
  }) {
    const app = Fastify();
    await app.register(rateLimit, {
      global: false,
    });
    app.get(
      '/burst-test',
      {
        config: {
          rateLimit: {
            max: options.max,
            timeWindow: 60_000,
            keyGenerator: (request) =>
              options.keyGenerator({
                ip: request.ip,
                headers: request.headers as Record<string, string | undefined>,
              }),
          },
        },
      },
      async () => ({ ok: true }),
    );
    await app.ready();
    apps.push(app);
    return app;
  }

  it('should return 429 after exceeding IP-based limit with rate limit headers', async () => {
    const app = await createRateLimitedApp({
      max: 2,
      keyGenerator: (request) => `ip:${request.ip}`,
    });

    const first = await app.inject({ method: 'GET', url: '/burst-test' });
    const second = await app.inject({ method: 'GET', url: '/burst-test' });
    const third = await app.inject({ method: 'GET', url: '/burst-test' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.headers['x-ratelimit-limit'] ?? third.headers['ratelimit-limit']).toBeDefined();
  });

  it('should key limits per user when user header is present', async () => {
    const app = await createRateLimitedApp({
      max: 2,
      keyGenerator: (request) => {
        const userId = request.headers['x-test-user-id'];
        return userId ? `user:${userId}` : `ip:${request.ip}`;
      },
    });

    const userAFirst = await app.inject({
      method: 'GET',
      url: '/burst-test',
      headers: { 'x-test-user-id': 'user-a' },
    });
    const userASecond = await app.inject({
      method: 'GET',
      url: '/burst-test',
      headers: { 'x-test-user-id': 'user-a' },
    });
    const userAThird = await app.inject({
      method: 'GET',
      url: '/burst-test',
      headers: { 'x-test-user-id': 'user-a' },
    });
    const userBFirst = await app.inject({
      method: 'GET',
      url: '/burst-test',
      headers: { 'x-test-user-id': 'user-b' },
    });

    expect(userAFirst.statusCode).toBe(200);
    expect(userASecond.statusCode).toBe(200);
    expect(userAThird.statusCode).toBe(429);
    expect(userBFirst.statusCode).toBe(200);
  });

  it('should key limits per organization when organization header is present', async () => {
    const app = await createRateLimitedApp({
      max: 2,
      keyGenerator: (request) => {
        const organizationPublicId = request.headers['x-test-organization'];
        return organizationPublicId ? `organization:${organizationPublicId}` : `ip:${request.ip}`;
      },
    });

    const organizationAFirst = await app.inject({
      method: 'GET',
      url: '/burst-test',
      headers: { 'x-test-organization': 'org_public_a' },
    });
    const organizationASecond = await app.inject({
      method: 'GET',
      url: '/burst-test',
      headers: { 'x-test-organization': 'org_public_a' },
    });
    const organizationAThird = await app.inject({
      method: 'GET',
      url: '/burst-test',
      headers: { 'x-test-organization': 'org_public_a' },
    });
    const organizationBFirst = await app.inject({
      method: 'GET',
      url: '/burst-test',
      headers: { 'x-organization-id': 'org_public_b' },
    });

    expect(organizationAFirst.statusCode).toBe(200);
    expect(organizationASecond.statusCode).toBe(200);
    expect(organizationAThird.statusCode).toBe(429);
    expect(organizationBFirst.statusCode).toBe(200);
  });
});
