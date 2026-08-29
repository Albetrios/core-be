import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectAuthenticatedOrganizationMutation,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';

/**
 * E2E coverage for the billing payment-method / invoice read routes and the SetupIntent write.
 * Stripe is stubbed (only the client functions these routes touch) so the happy-path statuses
 * (200/200/200/200) are exercised deterministically without a live Stripe call.
 */
vi.mock('@/infrastructure/payment/stripe.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/infrastructure/payment/stripe.client.js')>();
  return {
    ...actual,
    isStripeConfigured: () => true,
    listStripeInvoices: vi.fn(async () => ({ data: [], has_more: false })),
    listStripePaymentMethods: vi.fn(async () => []),
    retrieveStripeCustomerDefaultPaymentMethodId: vi.fn(async () => null),
    createStripeSetupIntent: vi.fn(async () => 'seti_test_client_secret_0123456789'),
    retrieveStripeSubscriptionPaymentClientSecret: vi.fn(async () => 'pi_test_client_secret'),
  };
});

const BILLING_PERMISSIONS = ['subscription:read', 'subscription:manage'] as const;

describe('Billing payment methods (e2e)', () => {
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
    await seedPermissions([...BILLING_PERMISSIONS]);
  });

  /** Team organization + membership with billing perms, plus an ACTIVE Stripe-backed subscription. */
  async function createBillingContext() {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [...BILLING_PERMISSIONS],
    });
    await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });
    const plan = await createTestPlan();
    const subscription = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      status: 'ACTIVE',
      providerCustomerId: 'cus_test_billing_e2e',
      createdByUserId: user.id,
    });
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { token, subscription };
  }

  it('GET /billing/invoices returns 200 with a paginated envelope', async () => {
    const { token } = await createBillingContext();
    const response = await injectAuthenticated(app, {
      url: testApiPath('/billing/invoices'),
      token,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: unknown[];
      meta: { pagination: { has_more: boolean; next: string | null } };
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.pagination).toMatchObject({ has_more: false, next: null });
  });

  it('GET /billing/payment-methods returns 200', async () => {
    const { token } = await createBillingContext();
    const response = await injectAuthenticated(app, {
      url: testApiPath('/billing/payment-methods'),
      token,
    });
    expect(response.statusCode).toBe(200);
  });

  it('GET /billing/subscriptions/:subscription_id/payment-setup returns 200', async () => {
    const { token, subscription } = await createBillingContext();
    const response = await injectAuthenticated(app, {
      url: testApiPath(`/billing/subscriptions/${subscription.public_id}/payment-setup`),
      token,
    });
    expect(response.statusCode).toBe(200);
  });

  it('POST /billing/payment-methods/setup returns 200', async () => {
    const { token } = await createBillingContext();
    const response = await injectAuthenticatedOrganizationMutation(app, {
      method: 'POST',
      url: testApiPath('/billing/payment-methods/setup'),
      token,
      payload: {},
      headers: { 'x-idempotency-key': 'e2e-payment-method-setup-key-000001' },
    });
    expect(response.statusCode).toBe(200);
  });
});
