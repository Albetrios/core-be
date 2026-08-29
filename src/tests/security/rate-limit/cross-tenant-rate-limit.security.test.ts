import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it } from 'vitest';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';

/**
 * Regression for audit #14 — authenticated cross-tenant rate-limit exhaustion.
 *
 * Two properties are asserted against the real {@link ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT}
 * key generator and hook wiring (the production preset, only `max` lowered for speed):
 *
 *  1. **Hook order** — the limiter's `preHandler` is appended AFTER the route's
 *     `requireOrganizationPermission` preHandler, so an unauthorized actor is rejected
 *     with 403 before the key is ever derived. Their requests never touch the limiter.
 *  2. **Per-actor isolation** — even when the limiter does run (authorized members), each
 *     actor gets its own `organization:<id>:actor:<actorId>` bucket, so one actor cannot
 *     drain another member's quota within the same organization.
 */
describe('Security: cross-tenant organization rate-limit isolation (audit #14)', () => {
  const apps: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  /**
   * Mirrors the production route wiring: a `requireOrganizationPermission`-style preHandler
   * (403 for non-members) plus the real organization-scoped rate-limit preset (lowered `max`). The
   * limiter hook is appended to the route `preHandler` array exactly as `@fastify/rate-limit`
   * does in production.
   */
  async function createOrganizationScopedApp(max: number) {
    const app = Fastify();
    await app.register(rateLimit, { global: false });

    app.addHook('onRequest', async (request: FastifyRequest) => {
      const actorId = request.headers['x-test-actor'];
      const organizationId = request.headers['x-test-org'];
      const mutableRequest = request as {
        auth?: { kind: 'user'; userId: string; organizationPublicId?: string } | undefined;
        organizationId?: string | null;
      };
      // Post-flatten the active organization rides the signed `org` token claim
      // (`auth.organizationPublicId`), not the header — set it there so the per-(organization, actor)
      // rate-limit key is exercised the way real requests resolve it.
      mutableRequest.auth =
        typeof actorId === 'string'
          ? {
              kind: 'user',
              userId: actorId,
              ...(typeof organizationId === 'string'
                ? { organizationPublicId: organizationId }
                : {}),
            }
          : undefined;
      mutableRequest.organizationId = typeof organizationId === 'string' ? organizationId : null;
    });

    const requireMembership = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<void> => {
      if (request.headers['x-test-member'] !== 'true') {
        await reply.code(403).send({ error: { code: 'forbidden' } });
      }
    };

    app.post(
      '/tenancy/organization/resource',
      {
        preHandler: [requireMembership],
        config: {
          rateLimit: {
            ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config.rateLimit,
            max,
          },
        },
      },
      async () => ({ ok: true }),
    );

    await app.ready();
    apps.push(app);
    return app;
  }

  it('an unauthorized actor (403) never decrements the victim organization bucket', async () => {
    const max = 2;
    const app = await createOrganizationScopedApp(max);

    // Attacker is authenticated but NOT a member of the victim organization: spam the route.
    for (let attempt = 0; attempt < max + 3; attempt += 1) {
      const attacker = await app.inject({
        method: 'POST',
        url: '/tenancy/organization/resource',
        headers: { 'x-test-actor': 'attacker', 'x-test-org': 'victim-org' },
      });
      expect(attacker.statusCode).toBe(403);
    }

    // A real member of the victim organization can still consume their full quota — unharmed.
    for (let attempt = 0; attempt < max; attempt += 1) {
      const member = await app.inject({
        method: 'POST',
        url: '/tenancy/organization/resource',
        headers: {
          'x-test-actor': 'member',
          'x-test-org': 'victim-org',
          'x-test-member': 'true',
        },
      });
      expect(member.statusCode).toBe(200);
    }
  });

  it('one member exhausting their bucket does not throttle another member of the same org', async () => {
    const max = 2;
    const app = await createOrganizationScopedApp(max);

    const memberHeaders = (actorId: string) => ({
      'x-test-actor': actorId,
      'x-test-org': 'shared-org',
      'x-test-member': 'true',
    });

    // Member A burns through their per-actor bucket until throttled.
    const firstA = await app.inject({
      method: 'POST',
      url: '/tenancy/organization/resource',
      headers: memberHeaders('member-a'),
    });
    const secondA = await app.inject({
      method: 'POST',
      url: '/tenancy/organization/resource',
      headers: memberHeaders('member-a'),
    });
    const thirdA = await app.inject({
      method: 'POST',
      url: '/tenancy/organization/resource',
      headers: memberHeaders('member-a'),
    });

    expect(firstA.statusCode).toBe(200);
    expect(secondA.statusCode).toBe(200);
    expect(thirdA.statusCode).toBe(429);

    // Member B in the SAME organization is unaffected — separate per-actor bucket.
    const firstB = await app.inject({
      method: 'POST',
      url: '/tenancy/organization/resource',
      headers: memberHeaders('member-b'),
    });
    expect(firstB.statusCode).toBe(200);
  });
});
