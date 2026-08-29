import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { buildIdempotencyCacheKey } from '@/shared/utils/idempotency/idempotency-key.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * **409 was specified everywhere and observed nowhere.**
 *
 * All five `idempotencyRequired` billing writes reject a key that is still in flight with 409
 * (`conflict_in_flight`), distinct from the 422 they return for a *missing* key and the 422 for
 * a key reused with a different payload. Before this suite:
 *
 * - the missing-key 422 was asserted at three of the five routes,
 * - the in-flight 409 was asserted at none of them,
 * - per-organization lock contention was proven only as a thrown `ConflictError` in
 *   `subscription.service.unit.test.ts`, and
 * - the k6 scenario accepts `409 | 422`.
 *
 * So a regression that collapsed every 409 into a 422 — telling well-behaved clients "your key
 * was reused wrong, do not retry" when the correct signal is "still running, retry shortly" —
 * would have passed every gate in the repo.
 *
 * Racing two concurrent requests would reproduce this only probabilistically. Instead each case
 * writes the in-flight placeholder the middleware itself would write (`SETNX` of
 * `{state:'in_flight'}` under {@link buildIdempotencyCacheKey}) and then issues the request, so
 * the second-caller path is exercised deterministically. The placeholder is written WITHOUT a
 * `fingerprint`, which is the documented backward-compatible shape and keeps the assertion on
 * the in-flight branch rather than the key-reuse branch.
 */
const BILLING_PERMISSIONS = ['subscription:read', 'subscription:manage'] as const;

describe('Billing idempotency replay — 409 while a key is in flight', () => {
  let app: FastifyInstance;
  const seededCacheKeys: string[] = [];

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedPermissions([...BILLING_PERMISSIONS]);
  });

  afterEach(async () => {
    // The idempotency cache is Redis, not Postgres — `cleanupDatabase` does not touch it.
    if (seededCacheKeys.length > 0) {
      await redisConnection.del(...seededCacheKeys);
      seededCacheKeys.length = 0;
    }
  });

  /** Team organization + billing permissions + a local-only ACTIVE subscription with a Stripe customer. */
  async function createBillingContext() {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const plan = await createTestPlan();
    const subscription = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      status: 'ACTIVE',
      providerSubscriptionId: null,
      providerCustomerId: 'cus_test_idempotency_replay',
      createdByUserId: user.id,
    });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [...BILLING_PERMISSIONS],
    });
    await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, organization, plan, subscription, token };
  }

  /**
   * Writes the exact in-flight placeholder the idempotency preHandler writes when it wins the
   * `SETNX` race, so the request under test takes the "someone else is already running this key"
   * branch instead of claiming the key itself.
   */
  async function seedInFlightClaim(options: {
    idempotencyKey: string;
    userPublicId: string;
    organizationPublicId: string;
  }): Promise<void> {
    const cacheKey = buildIdempotencyCacheKey(options.idempotencyKey, {
      userId: options.userPublicId,
      organizationId: options.organizationPublicId,
    });
    seededCacheKeys.push(cacheKey);
    await redisConnection.set(
      cacheKey,
      JSON.stringify({ state: 'in_flight', claimedAt: Date.now(), requestId: 'req-first-caller' }),
      'EX',
      60,
    );
  }

  function expectInFlightConflict(response: { statusCode: number; json: () => unknown }): void {
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error?: { code?: string; type?: string } };
    // Pinning the code, not just the status: 409 with `conflict`/`conflict_in_flight` tells the
    // client to retry the same key; the 422 `idempotency_key_reuse` tells it never to.
    expect(body.error?.code).toBe('conflict_in_flight');
    expect(body.error?.type).toBe('request_error');
  }

  it('POST /billing/subscriptions returns 409, not 422, while the key is in flight', async () => {
    const { user, organization, plan, token } = await createBillingContext();
    const idempotencyKey = generatePublicId('subscription');
    await seedInFlightClaim({
      idempotencyKey,
      userPublicId: user.public_id,
      organizationPublicId: organization.public_id,
    });

    const response = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/billing/subscriptions'),
      token,
      payload: { plan_id: plan.public_id, billing_cycle: 'monthly' },
      headers: { 'x-idempotency-key': idempotencyKey },
    });

    expectInFlightConflict(response);
  });

  it('POST /billing/subscriptions/:subscription_id/change-plan returns 409 while the key is in flight', async () => {
    const { user, organization, subscription, token } = await createBillingContext();
    const newPlan = await createTestPlan({ name: 'Replay Plan' });
    const idempotencyKey = generatePublicId('subscription');
    await seedInFlightClaim({
      idempotencyKey,
      userPublicId: user.public_id,
      organizationPublicId: organization.public_id,
    });

    const response = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath(`/billing/subscriptions/${subscription.public_id}/change-plan`),
      token,
      payload: { plan_id: newPlan.public_id },
      headers: { 'x-idempotency-key': idempotencyKey },
    });

    expectInFlightConflict(response);
  });

  it('POST /billing/subscriptions/:subscription_id/cancel returns 409 while the key is in flight', async () => {
    const { user, organization, subscription, token } = await createBillingContext();
    const idempotencyKey = generatePublicId('subscription');
    await seedInFlightClaim({
      idempotencyKey,
      userPublicId: user.public_id,
      organizationPublicId: organization.public_id,
    });

    const response = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath(`/billing/subscriptions/${subscription.public_id}/cancel`),
      token,
      headers: { 'x-idempotency-key': idempotencyKey },
    });

    expectInFlightConflict(response);
  });

  it('POST /billing/subscriptions/:subscription_id/resume returns 409 while the key is in flight', async () => {
    const { user, organization, subscription, token } = await createBillingContext();
    const idempotencyKey = generatePublicId('subscription');
    await seedInFlightClaim({
      idempotencyKey,
      userPublicId: user.public_id,
      organizationPublicId: organization.public_id,
    });

    const response = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath(`/billing/subscriptions/${subscription.public_id}/resume`),
      token,
      headers: { 'x-idempotency-key': idempotencyKey },
    });

    expectInFlightConflict(response);
  });

  it('POST /billing/payment-methods/setup returns 409 while the key is in flight', async () => {
    const { user, organization, token } = await createBillingContext();
    const idempotencyKey = generatePublicId('subscription');
    await seedInFlightClaim({
      idempotencyKey,
      userPublicId: user.public_id,
      organizationPublicId: organization.public_id,
    });

    const response = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/billing/payment-methods/setup'),
      token,
      payload: {},
      headers: { 'x-idempotency-key': idempotencyKey },
    });

    expectInFlightConflict(response);
  });

  it('a COMPLETED entry replays the cached response instead of conflicting', async () => {
    // The contrast that makes the five cases above non-vacuous: the 409 is specific to the
    // in-flight state. A completed entry must replay the original response body with
    // `x-idempotency-replay: true` — never 409, and never re-execute the handler.
    const { user, organization, token } = await createBillingContext();
    const idempotencyKey = generatePublicId('subscription');
    const cacheKey = buildIdempotencyCacheKey(idempotencyKey, {
      userId: user.public_id,
      organizationId: organization.public_id,
    });
    seededCacheKeys.push(cacheKey);
    await redisConnection.set(
      cacheKey,
      JSON.stringify({
        state: 'completed',
        statusCode: 200,
        body: JSON.stringify({ data: { replayed: true } }),
        headers: { 'content-type': 'application/json' },
      }),
      'EX',
      60,
    );

    const response = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/billing/payment-methods/setup'),
      token,
      payload: {},
      headers: { 'x-idempotency-key': idempotencyKey },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-idempotency-replay']).toBe('true');
    // The cached body is re-enveloped by the global response hook, so assert on the marker
    // rather than the envelope shape: what matters is that the REPLAYED payload came back
    // instead of a freshly-executed handler result (which would carry a `client_secret`).
    expect(response.body).toContain('"replayed":true');
    expect(response.body).not.toContain('client_secret');
  });

  it('an in-flight key belonging to ANOTHER actor does not conflict (cache keys are actor-scoped)', async () => {
    // Guards the scope segment of the cache key. If it regressed to a global
    // `idempotency:<key>` namespace, one tenant holding a key in flight would 409 every other
    // tenant that happened to pick the same key string.
    const { organization, token } = await createBillingContext();
    const otherUser = await createTestUser();
    const idempotencyKey = generatePublicId('subscription');
    await seedInFlightClaim({
      idempotencyKey,
      userPublicId: otherUser.public_id,
      organizationPublicId: organization.public_id,
    });

    const response = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/billing/payment-methods/setup'),
      token,
      payload: {},
      headers: { 'x-idempotency-key': idempotencyKey },
    });

    expect(response.statusCode).not.toBe(409);
  });
});
