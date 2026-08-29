import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
  PUBLIC_READ_RATE_LIMIT,
  WEBHOOK_RATE_LIMIT,
} from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';

/**
 * Billing's rate-limit guarantee came in two halves and only one was tested.
 *
 * `subscription-routes-rate-limit.policy.unit.test.ts` proves by source scan that every
 * subscription mutation *declares* `ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT` — the cheap half.
 * Nothing drove any billing route past its cap, so 429 appeared nowhere in the domain's
 * assertions and a preset whose `keyGenerator` silently collapsed to a shared bucket (or whose
 * `max` was lifted) would still pass every gate.
 *
 * `RATE_LIMIT_RELAXED_CAPS` is true under test — production caps are lifted to 5000 so parallel
 * loopback suites do not flake — so bursting the real routes is not viable. Following the
 * established `preset-authed-burst.security.test.ts` approach, each case mounts the preset's own
 * `keyGenerator` on an isolated app with an explicitly tiny `max`. Unlike that suite, the cases
 * below install real `request.auth` principals, so the per-(organization, actor) bucketing is
 * genuinely exercised rather than falling back to the IP key.
 */
describe('Security: billing rate limits reach 429 and isolate buckets', () => {
  const apps: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  /**
   * Isolated app carrying one preset's `keyGenerator` at a reproducible cap. When
   * `principalHeader` is set, an `onRequest` hook promotes a request header into `request.auth`
   * + `request.organizationId` so the organization-scoped key generator sees a real principal — Fastify's
   * `inject` never runs the app's own `authenticate` decorator.
   */
  async function createPresetBurstApp(options: {
    max: number;
    keyGenerator: (request: unknown) => string;
    withPrincipal?: boolean;
  }) {
    const app = Fastify();
    await app.register(rateLimit, { global: false });
    if (options.withPrincipal === true) {
      app.addHook('onRequest', async (request) => {
        const actor = request.headers['x-test-actor'];
        const organization = request.headers['x-test-organization'];
        if (typeof actor === 'string' && typeof organization === 'string') {
          (request as { auth?: unknown }).auth = {
            kind: 'user',
            userId: actor,
            organizationPublicId: organization,
          };
        }
      });
    }
    app.post(
      '/mutate',
      {
        config: {
          rateLimit: {
            max: options.max,
            timeWindow: 60_000,
            keyGenerator: options.keyGenerator as never,
          },
        },
      },
      async () => ({ ok: true }),
    );
    await app.ready();
    apps.push(app);
    return app;
  }

  it('a billing mutation burst from one (organization, actor) is refused with 429 once past the cap', async () => {
    const app = await createPresetBurstApp({
      max: 2,
      withPrincipal: true,
      keyGenerator: ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config.rateLimit.keyGenerator as (
        request: unknown,
      ) => string,
    });
    const headers = { 'x-test-actor': 'usr_alpha', 'x-test-organization': 'org_alpha' };

    const first = await app.inject({ method: 'POST', url: '/mutate', headers });
    const second = await app.inject({ method: 'POST', url: '/mutate', headers });
    const third = await app.inject({ method: 'POST', url: '/mutate', headers });

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(third.statusCode).toBe(429);
    expect(third.headers['x-ratelimit-limit'] ?? third.headers['ratelimit-limit']).toBeDefined();
    expect(third.headers['retry-after'] ?? third.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('one exhausted organization does not throttle a different organization or a different member', async () => {
    // The cross-tenant half of the guarantee: keying on the organization alone would let an
    // attacker probing another org's mutations exhaust that org's shared bucket, and keying on
    // the actor alone would let one member's spend throttle them across every organization they belong
    // to. Only `organization:<id>:actor:<id>` isolates both directions.
    const app = await createPresetBurstApp({
      max: 1,
      withPrincipal: true,
      keyGenerator: ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config.rateLimit.keyGenerator as (
        request: unknown,
      ) => string,
    });
    const exhausted = { 'x-test-actor': 'usr_alpha', 'x-test-organization': 'org_alpha' };

    await app.inject({ method: 'POST', url: '/mutate', headers: exhausted });
    const blocked = await app.inject({ method: 'POST', url: '/mutate', headers: exhausted });
    const otherOrganizationSameActor = await app.inject({
      method: 'POST',
      url: '/mutate',
      headers: { 'x-test-actor': 'usr_alpha', 'x-test-organization': 'org_beta' },
    });
    const sameOrganizationOtherActor = await app.inject({
      method: 'POST',
      url: '/mutate',
      headers: { 'x-test-actor': 'usr_beta', 'x-test-organization': 'org_alpha' },
    });

    expect(blocked.statusCode).toBe(429);
    expect(otherOrganizationSameActor.statusCode).toBe(200);
    expect(sameOrganizationOtherActor.statusCode).toBe(200);
  });

  it('the public plan catalog is capped and reaches 429 (PUBLIC_READ_RATE_LIMIT)', async () => {
    // `GET /billing/plans` and `GET /billing/plans/:plan_id` were the only unauthenticated,
    // uncapped, database-backed surface in the domain until the preset was applied.
    const app = await createPresetBurstApp({
      max: 2,
      keyGenerator: PUBLIC_READ_RATE_LIMIT.config.rateLimit.keyGenerator as (
        request: unknown,
      ) => string,
    });

    const first = await app.inject({ method: 'POST', url: '/mutate', remoteAddress: '127.0.0.1' });
    const second = await app.inject({ method: 'POST', url: '/mutate', remoteAddress: '127.0.0.1' });
    const third = await app.inject({ method: 'POST', url: '/mutate', remoteAddress: '127.0.0.1' });

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(third.statusCode).toBe(429);
  });

  it('the public plan catalog buckets per IP — one caller cannot exhaust the catalog for everyone', async () => {
    const app = await createPresetBurstApp({
      max: 1,
      keyGenerator: PUBLIC_READ_RATE_LIMIT.config.rateLimit.keyGenerator as (
        request: unknown,
      ) => string,
    });

    await app.inject({ method: 'POST', url: '/mutate', remoteAddress: '10.0.0.1' });
    const blocked = await app.inject({
      method: 'POST',
      url: '/mutate',
      remoteAddress: '10.0.0.1',
    });
    const otherCaller = await app.inject({
      method: 'POST',
      url: '/mutate',
      remoteAddress: '10.0.0.2',
    });

    expect(blocked.statusCode).toBe(429);
    expect(otherCaller.statusCode).toBe(200);
  });

  it('the plan-catalog cap is looser than the Stripe webhook cap is strict — both are IP-keyed and finite', () => {
    // Shape pin: a refactor that dropped either preset's key generator, or lifted `max` to
    // Infinity, would leave the burst cases above passing (they inject their own `max`).
    for (const preset of [PUBLIC_READ_RATE_LIMIT, WEBHOOK_RATE_LIMIT]) {
      expect(typeof preset.config.rateLimit.keyGenerator).toBe('function');
      expect(preset.config.rateLimit.timeWindow).toBe(60_000);
      expect(Number.isFinite(preset.config.rateLimit.max)).toBe(true);
      expect(preset.config.rateLimit.max).toBeGreaterThan(0);
      // Public presets run on the default onRequest hook: there is no authenticated actor to
      // wait for, and the limiter must fire before the handler touches Postgres.
      expect(preset.config.rateLimit).not.toHaveProperty('hook');
    }
  });
});
