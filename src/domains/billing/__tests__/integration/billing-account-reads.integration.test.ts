import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * The billing-account reads (`GET /billing/invoices`, `GET /billing/payment-methods`) proxy
 * Stripe, and their **unconfigured-provider** behaviour is a deliberate asymmetry with the
 * billing writes that nothing asserted:
 *
 * - writes are **fail-closed** — a provider failure surfaces as 503 and the local row is left
 *   untouched (`billing-subscription-mutations.integration.test.ts`),
 * - reads are **fail-open** — no billing provider means an empty invoice/card list, so a
 *   self-hosted or not-yet-onboarded deployment renders an empty billing page rather than an
 *   error.
 *
 * The provider is stubbed as unconfigured at module scope rather than relying on the ambient
 * environment: a `.env` carrying *any* `STRIPE_SECRET_KEY` (including a placeholder) flips
 * `isStripeConfigured()` to true and sends these routes down a live network call, which makes
 * the assertion environment-dependent. The configured-and-healthy branch is covered separately
 * in `billing-payment-methods.e2e.test.ts`.
 */
vi.mock('@/infrastructure/payment/stripe.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/infrastructure/payment/stripe.client.js')>();
  return { ...actual, isStripeConfigured: () => false };
});

const BILLING_PERMISSIONS = ['subscription:read', 'subscription:manage'] as const;

describe('Billing account reads — unconfigured provider degradation', () => {
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

  /** Team organization with billing permissions and an ACTIVE subscription carrying a Stripe customer id. */
  async function createBillingReadContext() {
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
      permissionCodes: [...BILLING_PERMISSIONS],
    });
    await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { organization, token };
  }

  it('GET /billing/invoices returns an empty page (200), not 503', async () => {
    const { organization, token } = await createBillingReadContext();

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/billing/invoices'),
      token,
      organizationPublicId: organization.public_id,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: unknown[];
      meta: { pagination: { has_more: boolean; next: string | null } };
    };
    expect(body.data).toEqual([]);
    // The pagination envelope must still be well-formed on the degraded path — clients paginate
    // off `has_more`/`next` and a missing envelope would break the list component, not just
    // leave it empty.
    expect(body.meta.pagination).toMatchObject({ has_more: false, next: null });
  });

  it('GET /billing/payment-methods returns an empty list (200), not 503', async () => {
    const { organization, token } = await createBillingReadContext();

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/billing/payment-methods'),
      token,
      organizationPublicId: organization.public_id,
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: unknown[] }).data).toEqual([]);
  });

  it('GET /billing/subscriptions/:subscription_id/payment-setup returns a null client_secret, not 503', async () => {
    // Same fail-open contract on the third Stripe-proxied read: the frontend branches on a null
    // `client_secret` (nothing to confirm) rather than handling an error response.
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const plan = await createTestPlan();
    const subscription = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      status: 'INCOMPLETE',
      providerCustomerId: 'cus_test_billing_reads',
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

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath(`/billing/subscriptions/${subscription.public_id}/payment-setup`),
      token,
      organizationPublicId: organization.public_id,
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: { client_secret: string | null } }).data.client_secret).toBe(
      null,
    );
  });
});
