import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import type { FastifyInstance } from 'fastify';

/**
 * Billing permissions imported inline to avoid cross-domain coupling in test setup.
 */
const BILLING_PERMISSIONS = {
  SUBSCRIPTION_READ: 'subscription:read',
  SUBSCRIPTION_MANAGE: 'subscription:manage',
} as const;

const ALL_BILLING_PERMISSIONS = Object.values(BILLING_PERMISSIONS);

/**
 * Canonical for what comes back **through** the billing route gates: body shape, list contents,
 * validator boundaries, and the billing-account read denials.
 *
 * Reachability and the plain denial statuses belong in `__tests__/billing.test.ts`. Keep the split:
 * before it, these two files ran 7 identical DB-bound cases on every CI run.
 */
describe('Billing Domain — Response contract (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedPermissions(ALL_BILLING_PERMISSIONS);
  });

  async function createAuthenticatedToken(): Promise<string> {
    const user = await createTestUser();
    return generateTestToken({ userId: user.public_id });
  }

  /**
   * Team organization whose member holds `permissionCodes`, with an ACTIVE local-only subscription that
   * carries a Stripe customer id — the state the billing-account reads need to get past
   * `resolveStripeCustomerId` and reach the Stripe branch.
   */
  async function createBillingReadContext(
    permissionCodes: readonly string[] = ALL_BILLING_PERMISSIONS,
  ) {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const plan = await createTestPlan();
    await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      status: 'ACTIVE',
      providerSubscriptionId: null,
      providerCustomerId: 'cus_test_billing_reads',
      createdByUserId: user.id,
    });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [...permissionCodes],
    });
    await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, organization, token };
  }

  // ─── Plans (public read) ────────────────────────────────────

  describe('GET /api/v1/billing/plans', () => {
    it('should return plans with authentication', async () => {
      const token = await createAuthenticatedToken();
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/plans'),
        token,
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { data: Record<string, unknown> }).data).toBeDefined();
    });

    it('should include created plan in list', async () => {
      await createTestPlan({ name: 'Pro Plan' });
      const token = await createAuthenticatedToken();
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/plans'),
        token,
      });
      expect(response.statusCode).toBe(200);
      const planNames = ((response.json() as { data: Array<{ name: string }> }).data ?? []).map(
        (plan) => plan.name,
      );
      expect(planNames).toContain('Pro Plan');
    });
  });

  describe('GET /api/v1/billing/plans/:id', () => {
    it('should return plan by public ID', async () => {
      const plan = await createTestPlan();
      const token = await createAuthenticatedToken();
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/billing/plans/${plan.public_id}`),
        token,
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { data: Record<string, unknown> }).data).toBeDefined();
    });

    it('should return 400 for a malformed (over-long) plan_id', async () => {
      // `getPlanParamsDto` caps the param at 28 chars. Without the boundary case, a validator
      // that stopped being wired into the route would still pass the 404 test above — the
      // repository lookup simply misses — while unbounded caller input reached the query and
      // the route-tagged metric/Sentry labels.
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath(`/billing/plans/${'p'.repeat(64)}`),
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ─── Billing-account reads (Stripe-proxied) ─────────────────────────────────
  //
  // `GET /billing/invoices` and `GET /billing/payment-methods` each asserted 200 and nothing
  // else. Both are `subscription:read` routes that proxy Stripe, so the interesting properties
  // are the two negatives (no token / wrong permission) and the degradation path when Stripe is
  // not configured — the state every CI and local test run is actually in.

  describe('GET /api/v1/billing/invoices', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/invoices'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return 403 for a member without subscription:read', async () => {
      const { organization } = await createBillingReadContext();
      const outsider = await createTestUser();
      const outsiderToken = await generateTestToken({
        userId: outsider.public_id,
        organizationPublicId: organization.public_id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/invoices'),
        token: outsiderToken,
        organizationPublicId: organization.public_id,
      });
      expect(response.statusCode).toBe(403);
    });

    // The unconfigured-provider degradation path lives in
    // `billing-account-reads.integration.test.ts`, which stubs the Stripe client at module
    // scope — a file-level `vi.mock` here would also apply to the plan-catalog cases above.
  });

  describe('GET /api/v1/billing/payment-methods', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/payment-methods'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return 403 for a member without subscription:read', async () => {
      const { organization } = await createBillingReadContext();
      const outsider = await createTestUser();
      const outsiderToken = await generateTestToken({
        userId: outsider.public_id,
        organizationPublicId: organization.public_id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/payment-methods'),
        token: outsiderToken,
        organizationPublicId: organization.public_id,
      });
      expect(response.statusCode).toBe(403);
    });
  });
});
