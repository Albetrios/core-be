import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';
import { database } from '@/infrastructure/database/connection.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * **The under-privileged insider.** Billing's security layer was a single file of four cases,
 * all RLS `WITH CHECK` on one table — nothing covered the member who is legitimately inside the
 * organization but is not supposed to touch the money.
 *
 * `subscription:read` and `subscription:manage` are separate permissions precisely so a member
 * who can *see* the bill cannot *change* it: every mutation drives real Stripe operations
 * (proration, ledger churn, cancellation). That split was asserted only at the service layer,
 * so nothing proved the `requireOrganizationPermission` preHandler is still wired onto each
 * mutating route — and a route that lost its preHandler fails open, not closed.
 *
 * The other billing attacker model — the webhook replayer — lives in
 * `stripe-webhook-replay.integration.test.ts`. It is in the integration tier because the
 * security project shares one global per-IP rate-limit budget (`RATE_LIMIT_MAX`, keyed on
 * `127.0.0.1` in Redis) across every file running in parallel, and posting webhooks is
 * request-heavy enough to push neighbouring suites over that shared cap.
 */
const READ_PERMISSION = 'subscription:read';
const MANAGE_PERMISSION = 'subscription:manage';
const ALL_BILLING_PERMISSIONS = [READ_PERMISSION, MANAGE_PERMISSION] as const;

describe('Security: billing privilege separation', () => {
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
    await seedPermissions([...ALL_BILLING_PERMISSIONS]);
  });

  /**
   * A team organization holding an ACTIVE subscription, plus a member whose role grants
   * `subscription:read` and deliberately NOT `subscription:manage`.
   */
  async function createReadOnlyMemberContext() {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const plan = await createTestPlan();
    const subscription = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      status: 'ACTIVE',
      providerSubscriptionId: null,
      providerCustomerId: 'cus_test_privilege',
      createdByUserId: owner.id,
    });
    const readOnlyRole = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [READ_PERMISSION],
    });
    const readOnlyMember = await createTestUser({
      email: `read-only-${generatePublicId('user')}@test.com`,
    });
    await createMembership({
      userId: readOnlyMember.id,
      organizationId: organization.id,
      roleId: readOnlyRole.id,
    });
    const readOnlyToken = await generateTestToken({
      userId: readOnlyMember.public_id,
      organizationPublicId: organization.public_id,
    });
    return { organization, plan, subscription, readOnlyToken };
  }

  describe('a member with subscription:read but not subscription:manage', () => {
    it('CAN read the subscription list (the permission it does hold)', async () => {
      // Establishes that the 403s below are about the missing MANAGE permission, not a broken
      // fixture — without this the three refusals would pass even if the member were unable to
      // authenticate at all.
      const { organization, readOnlyToken } = await createReadOnlyMemberContext();

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/subscriptions'),
        token: readOnlyToken,
        organizationPublicId: organization.public_id,
      });

      expect(response.statusCode).toBe(200);
    });

    it('is refused (403) on POST /billing/subscriptions', async () => {
      const { organization, plan, readOnlyToken } = await createReadOnlyMemberContext();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/billing/subscriptions'),
        token: readOnlyToken,
        organizationPublicId: organization.public_id,
        payload: { plan_id: plan.public_id, billing_cycle: 'monthly' },
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(403);
    });

    it('is refused (403) on POST /billing/subscriptions/:subscription_id/change-plan', async () => {
      const { organization, subscription, readOnlyToken } = await createReadOnlyMemberContext();
      const newPlan = await createTestPlan({ name: 'Privilege Escalation Plan' });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/change-plan`),
        token: readOnlyToken,
        organizationPublicId: organization.public_id,
        payload: { plan_id: newPlan.public_id },
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(403);
    });

    it('is refused (403) on POST /billing/subscriptions/:subscription_id/cancel', async () => {
      const { organization, subscription, readOnlyToken } = await createReadOnlyMemberContext();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/cancel`),
        token: readOnlyToken,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(403);
    });

    it('leaves the subscription untouched after the refused mutations', async () => {
      // The refusal must happen before any state change — a 403 emitted *after* a partial write
      // would still be a breach.
      const { organization, subscription, readOnlyToken } = await createReadOnlyMemberContext();

      await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/cancel`),
        token: readOnlyToken,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      const [row] = await database
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.public_id, subscription.public_id));
      expect(row?.cancel_at_period_end).toBe(false);
      expect(row?.status).toBe('ACTIVE');
    });
  });
});
