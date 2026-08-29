import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectAuthenticatedOrganizationMutation,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { database } from '@/infrastructure/database/connection.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * Billing permissions imported inline to avoid cross-domain coupling in test setup.
 */
const BILLING_PERMISSIONS = {
  SUBSCRIPTION_READ: 'subscription:read',
  SUBSCRIPTION_MANAGE: 'subscription:manage',
} as const;

const ALL_BILLING_PERMISSIONS = Object.values(BILLING_PERMISSIONS);

/**
 * Integration tests for subscription mutation endpoints:
 * - POST /billing/subscriptions/:subscription_id/change-plan
 * - POST /billing/subscriptions/:subscription_id/cancel
 * - POST /billing/subscriptions/:subscription_id/resume
 *
 * Covers positive paths, negative auth/permission/404 paths, idempotency enforcement,
 * and a full cancel → resume lifecycle.
 */
describe('Billing Subscription Mutations — Integration', () => {
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

  /**
   * Creates a user, organization, plan, subscription, role with subscription:manage
   * permission, and a membership — returns everything needed to drive a mutation test.
   *
   * @remarks
   * Subscriptions default to **local-only** (`providerSubscriptionId: null`) so the
   * fail-closed subscription service skips the external Stripe call on
   * cancel/resume/change-plan and the endpoints exercise the database transition
   * logic deterministically (200). Pass `providerSubscriptionId` to create a
   * Stripe-backed subscription that drives the fail-closed 503 path (Stripe is
   * unconfigured in CI and local test runs).
   */
  async function createBillingMutationContext(
    options: { status?: string; providerSubscriptionId?: string | null } = {},
  ) {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const plan = await createTestPlan();
    const subscription = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      status: options.status ?? 'ACTIVE',
      providerSubscriptionId:
        options.providerSubscriptionId !== undefined ? options.providerSubscriptionId : null,
    });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ALL_BILLING_PERMISSIONS,
    });
    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, organization, plan, subscription, role, token };
  }

  /**
   * Same shape as {@link createBillingMutationContext} but on a **PERSONAL** organization, which
   * `assertTeamOrganization(organization, 'BILLING')` rejects with 422. Every branch of that
   * guard was covered at the service layer (`subscription.service.billing-guard.unit.test.ts`)
   * with a stubbed organization service; nothing confirmed the guard is still *wired* behind the
   * HTTP routes. A refactor that moved billing reads off the guarded `resolveStripeCustomerId`
   * path, or dropped the assert from one mutation, would have shipped green.
   */
  async function createPersonalOrganizationContext() {
    const user = await createTestUser();
    const organization = await createTestOrganization({
      ownerUserId: user.id,
      type: 'PERSONAL',
    });
    const plan = await createTestPlan();
    const subscription = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      status: 'ACTIVE',
      providerSubscriptionId: null,
      providerCustomerId: 'cus_test_personal_guard',
    });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ALL_BILLING_PERMISSIONS,
    });
    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, organization, plan, subscription, token };
  }

  // ─── POST change-plan ──────────────────────────────────────────────────────

  describe('POST /api/v1/billing/subscriptions/:subscription_id/change-plan', () => {
    it('should return 400 when plan_id is missing (validator wired at the boundary)', async () => {
      // ChangePlanDto's refusal was unit-proven only — no 400 was ever observed on this route.
      // Key supplied → the idempotency 422 cannot fire; the body validator runs before the
      // subscription lookup, so the refusal is the validator's own.
      const { organization, subscription, token } = await createBillingMutationContext();

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/change-plan`),
        token,
        organizationPublicId: organization.public_id,
        payload: {},
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });
      expect(response.statusCode, response.body).toBe(400);
    });

    it('should change the plan and return 200 with a valid X-Idempotency-Key', async () => {
      const { organization, subscription, token } = await createBillingMutationContext();
      const newPlan = await createTestPlan({ name: 'New Plan' });

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/change-plan`),
        token,
        organizationPublicId: organization.public_id,
        payload: { plan_id: newPlan.public_id },
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { data?: { plan_id?: number } };
      expect(body.data).toBeDefined();
    });

    it('auto-suspends the most-recently-joined excess members on an over-cap downgrade, keeping the owner (F2)', async () => {
      // Owner + 2 active members = 3 seats used. Downgrade to a 1-seat plan: the 2 non-owner members
      // are suspended (longest-tenured-kept ordering, owner never suspended), so the change succeeds.
      const {
        user: owner,
        organization,
        subscription,
        token,
      } = await createBillingMutationContext();
      const memberRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: ALL_BILLING_PERMISSIONS,
      });
      const memberA = await createTestUser({
        email: `member-a-${generatePublicId('user')}@test.com`,
      });
      const memberB = await createTestUser({
        email: `member-b-${generatePublicId('user')}@test.com`,
      });
      await createMembership({
        userId: memberA.id,
        organizationId: organization.id,
        roleId: memberRole.id,
      });
      await createMembership({
        userId: memberB.id,
        organizationId: organization.id,
        roleId: memberRole.id,
      });

      const oneSeatPlan = await createTestPlan({ name: 'Solo Plan', includedSeats: 1 });
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/change-plan`),
        token,
        organizationPublicId: organization.public_id,
        payload: { plan_id: oneSeatPlan.public_id },
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(200);
      // The two non-owner members are now SUSPENDED; the owner stays ACTIVE.
      const statusOf = async (userId: number) =>
        (
          await database
            .select({ status: memberships.status })
            .from(memberships)
            .where(
              and(
                eq(memberships.organization_id, organization.id),
                eq(memberships.user_id, userId),
              ),
            )
        )[0]?.status;
      expect(await statusOf(memberA.id)).toBe('SUSPENDED');
      expect(await statusOf(memberB.id)).toBe('SUSPENDED');
      expect(await statusOf(owner.id)).toBe('ACTIVE');
    });

    it('downgrade of an owner-only organization to a 0-seat plan succeeds without suspending the owner (F2)', async () => {
      // Only the owner holds a seat; the owner is never suspended, so an over-cap downgrade still
      // succeeds (the organization simply remains at its owner-only floor).
      const {
        user: owner,
        organization,
        subscription,
        token,
      } = await createBillingMutationContext();
      const zeroSeatPlan = await createTestPlan({ name: 'Tiny Plan', includedSeats: 0 });

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/change-plan`),
        token,
        organizationPublicId: organization.public_id,
        payload: { plan_id: zeroSeatPlan.public_id },
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(200);
      const ownerStatus = (
        await database
          .select({ status: memberships.status })
          .from(memberships)
          .where(
            and(
              eq(memberships.organization_id, organization.id),
              eq(memberships.user_id, owner.id),
            ),
          )
      )[0]?.status;
      expect(ownerStatus).toBe('ACTIVE');
    });

    it('allows the downgrade when the new plan still has enough seats for the active members (F2)', async () => {
      const { organization, subscription, token } = await createBillingMutationContext();
      const fittingPlan = await createTestPlan({ name: 'Roomy Plan', includedSeats: 5 });

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/change-plan`),
        token,
        organizationPublicId: organization.public_id,
        payload: { plan_id: fittingPlan.public_id },
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should return 401 when no auth header is provided', async () => {
      const { subscription } = await createBillingMutationContext();
      const newPlan = await createTestPlan();

      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/change-plan`),
        payload: { plan_id: newPlan.public_id },
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 403 when the user lacks subscription:manage permission', async () => {
      const { organization, subscription } = await createBillingMutationContext();
      const newPlan = await createTestPlan();

      // New user with no role in this organization.
      const unprivilegedUser = await createTestUser();
      const unprivilegedToken = await generateTestToken({
        userId: unprivilegedUser.public_id,
        organizationPublicId: organization.public_id,
      });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/change-plan`),
        token: unprivilegedToken,
        organizationPublicId: organization.public_id,
        payload: { plan_id: newPlan.public_id },
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should return 404 for a non-existent subscriptionId', async () => {
      const { organization, token } = await createBillingMutationContext();
      const newPlan = await createTestPlan();
      const nonExistentSubscriptionId = generatePublicId('subscription');

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${nonExistentSubscriptionId}/change-plan`),
        token,
        organizationPublicId: organization.public_id,
        payload: { plan_id: newPlan.public_id },
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 422 when the X-Idempotency-Key header is missing', async () => {
      const { organization, subscription, token } = await createBillingMutationContext();
      const newPlan = await createTestPlan();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/change-plan`),
        token,
        organizationPublicId: organization.public_id,
        payload: { plan_id: newPlan.public_id },
      });

      expect(response.statusCode).toBe(422);
    });
  });

  // ─── POST cancel ──────────────────────────────────────────────────────────

  describe('POST /api/v1/billing/subscriptions/:subscription_id/cancel', () => {
    it('should cancel an active subscription and return 200 with a valid X-Idempotency-Key', async () => {
      const { organization, subscription, token } = await createBillingMutationContext({
        status: 'ACTIVE',
      });

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/cancel`),
        token,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { data?: { cancel_at_period_end?: boolean } };
      expect(body.data?.cancel_at_period_end).toBe(true);
    });

    it('should return 401 when no auth header is provided', async () => {
      const { subscription } = await createBillingMutationContext();

      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/cancel`),
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 403 when the user lacks subscription:manage permission', async () => {
      const { organization, subscription } = await createBillingMutationContext();
      const unprivilegedUser = await createTestUser();
      const unprivilegedToken = await generateTestToken({
        userId: unprivilegedUser.public_id,
        organizationPublicId: organization.public_id,
      });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/cancel`),
        token: unprivilegedToken,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should return 404 for a non-existent subscriptionId', async () => {
      const { organization, token } = await createBillingMutationContext();
      const nonExistentSubscriptionId = generatePublicId('subscription');

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${nonExistentSubscriptionId}/cancel`),
        token,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 422 when the X-Idempotency-Key header is missing', async () => {
      const { organization, subscription, token } = await createBillingMutationContext();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/cancel`),
        token,
        organizationPublicId: organization.public_id,
      });

      expect(response.statusCode).toBe(422);
    });

    it('should return 200 when cancelling a subscription that is already scheduled to cancel (cancel_at_period_end=true)', async () => {
      // The service sets cancel_at_period_end=true but does NOT change status to CANCELED.
      // A subscription with cancel_at_period_end=true is still ACTIVE — cancel is idempotent
      // from the perspective of the service (it sets the same flag again).
      const { organization, subscription, token } = await createBillingMutationContext({
        status: 'ACTIVE',
      });

      // First cancel — sets cancel_at_period_end=true
      await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/cancel`),
        token,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      // Second cancel — subscription is still ACTIVE in the DB (just cancel_at_period_end=true),
      // so the service can fetch it and set cancel_at_period_end=true again → 200.
      const secondCancelResponse = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/cancel`),
        token,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(secondCancelResponse.statusCode).toBe(200);
    });
  });

  // ─── POST resume ──────────────────────────────────────────────────────────

  describe('POST /api/v1/billing/subscriptions/:subscription_id/resume', () => {
    it('should resume a cancelled (cancel_at_period_end) subscription and return 200 with a valid X-Idempotency-Key', async () => {
      const { organization, subscription, token } = await createBillingMutationContext({
        status: 'ACTIVE',
      });

      // First cancel to set cancel_at_period_end=true
      await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/cancel`),
        token,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/resume`),
        token,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data?: { cancel_at_period_end?: boolean; status?: string };
      };
      expect(body.data?.cancel_at_period_end).toBe(false);
      expect(body.data?.status).toBe('ACTIVE');
    });

    it('should return 401 when no auth header is provided', async () => {
      const { subscription } = await createBillingMutationContext();

      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/resume`),
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 403 when the user lacks subscription:manage permission', async () => {
      const { organization, subscription } = await createBillingMutationContext();
      const unprivilegedUser = await createTestUser();
      const unprivilegedToken = await generateTestToken({
        userId: unprivilegedUser.public_id,
        organizationPublicId: organization.public_id,
      });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/resume`),
        token: unprivilegedToken,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should return 404 for a non-existent subscriptionId', async () => {
      const { organization, token } = await createBillingMutationContext();
      const nonExistentSubscriptionId = generatePublicId('subscription');

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${nonExistentSubscriptionId}/resume`),
        token,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 422 when the X-Idempotency-Key header is missing', async () => {
      const { organization, subscription, token } = await createBillingMutationContext();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/resume`),
        token,
        organizationPublicId: organization.public_id,
      });

      expect(response.statusCode).toBe(422);
    });

    it('should return 200 when resuming an already-active subscription (idempotent resume)', async () => {
      // The service's resume() does: find subscription (throws 404 if missing),
      // optionally call Stripe, then set cancel_at_period_end=false + status=ACTIVE.
      // An already-ACTIVE subscription with cancel_at_period_end=false satisfies
      // findByPublicId, so the update succeeds and returns 200.
      const { organization, subscription, token } = await createBillingMutationContext({
        status: 'ACTIVE',
      });

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/resume`),
        token,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data?: { cancel_at_period_end?: boolean; status?: string };
      };
      expect(body.data?.status).toBe('ACTIVE');
    });
  });

  // ─── Full lifecycle: ACTIVE → cancel → resume ─────────────────────────────

  describe('Full lifecycle: create ACTIVE → cancel → resume', () => {
    it('should transition cancel_at_period_end from false → true → false across cancel and resume', async () => {
      const { organization, subscription, token } = await createBillingMutationContext({
        status: 'ACTIVE',
      });
      const organizationId = organization.public_id;
      const subscriptionId = subscription.public_id;

      // 1. Confirm initial state via GET.
      const getResponse = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/billing/subscriptions/${subscriptionId}`),
        token,
        organizationPublicId: organizationId,
      });
      expect(getResponse.statusCode).toBe(200);
      const initialBody = getResponse.json() as {
        data?: { status?: string; cancel_at_period_end?: boolean };
      };
      expect(initialBody.data?.status).toBe('ACTIVE');
      expect(initialBody.data?.cancel_at_period_end).toBe(false);

      // 2. Cancel — sets cancel_at_period_end=true.
      const cancelResponse = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscriptionId}/cancel`),
        token,
        organizationPublicId: organizationId,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });
      expect(cancelResponse.statusCode).toBe(200);
      const cancelBody = cancelResponse.json() as {
        data?: { cancel_at_period_end?: boolean };
      };
      expect(cancelBody.data?.cancel_at_period_end).toBe(true);

      // 3. Verify cancelled state via GET.
      const getAfterCancelResponse = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/billing/subscriptions/${subscriptionId}`),
        token,
        organizationPublicId: organizationId,
      });
      expect(getAfterCancelResponse.statusCode).toBe(200);
      const afterCancelBody = getAfterCancelResponse.json() as {
        data?: { cancel_at_period_end?: boolean };
      };
      expect(afterCancelBody.data?.cancel_at_period_end).toBe(true);

      // 4. Resume — sets cancel_at_period_end=false and status=ACTIVE.
      const resumeResponse = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscriptionId}/resume`),
        token,
        organizationPublicId: organizationId,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });
      expect(resumeResponse.statusCode).toBe(200);
      const resumeBody = resumeResponse.json() as {
        data?: { cancel_at_period_end?: boolean; status?: string };
      };
      expect(resumeBody.data?.cancel_at_period_end).toBe(false);
      expect(resumeBody.data?.status).toBe('ACTIVE');

      // 5. Verify final state via GET.
      const getAfterResumeResponse = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/billing/subscriptions/${subscriptionId}`),
        token,
        organizationPublicId: organizationId,
      });
      expect(getAfterResumeResponse.statusCode).toBe(200);
      const afterResumeBody = getAfterResumeResponse.json() as {
        data?: { cancel_at_period_end?: boolean; status?: string };
      };
      expect(afterResumeBody.data?.cancel_at_period_end).toBe(false);
      expect(afterResumeBody.data?.status).toBe('ACTIVE');
    });
  });

  // ─── POST /payment-methods/setup — full matrix ─────────────────────────────
  //
  // This route had exactly one assertion in the whole repo (a 200 in
  // `billing-payment-methods.e2e.test.ts`) despite being BOTH `idempotencyRequired` AND
  // team-only — the two properties most likely to regress silently, because neither is visible
  // in the handler body: one comes from a `config` flag read by a global hook, the other from a
  // guard buried in the service's `resolveStripeCustomerId`.
  describe('POST /api/v1/billing/payment-methods/setup', () => {
    it('should return 401 when no auth header is provided', async () => {
      await createBillingMutationContext();

      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/billing/payment-methods/setup'),
        payload: {},
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 403 when the member lacks subscription:manage permission', async () => {
      // A read-only member: the route requires SUBSCRIPTION_MANAGE, so `subscription:read`
      // alone must not open a card-collection SetupIntent.
      const { organization } = await createBillingMutationContext();
      const readOnlyUser = await createTestUser();
      const readOnlyRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [BILLING_PERMISSIONS.SUBSCRIPTION_READ],
      });
      await createMembership({
        userId: readOnlyUser.id,
        organizationId: organization.id,
        roleId: readOnlyRole.id,
      });
      const readOnlyToken = await generateTestToken({
        userId: readOnlyUser.public_id,
        organizationPublicId: organization.public_id,
      });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/billing/payment-methods/setup'),
        token: readOnlyToken,
        organizationPublicId: organization.public_id,
        payload: {},
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should return 422 when the X-Idempotency-Key header is missing', async () => {
      const { organization, token } = await createBillingMutationContext();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/billing/payment-methods/setup'),
        token,
        organizationPublicId: organization.public_id,
        payload: {},
      });

      expect(response.statusCode).toBe(422);
    });

    it('should return 422 for a PERSONAL organization (team-only route)', async () => {
      const { organization, token } = await createPersonalOrganizationContext();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/billing/payment-methods/setup'),
        token,
        organizationPublicId: organization.public_id,
        payload: {},
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(422);
    });
  });

  // ─── Team-only 422 at the HTTP boundary ────────────────────────────────────
  //
  // One case per `team`-scoped route in `route-organization-scope.json`. Proven at the service layer
  // only until now; these confirm the guard survives the trip through routing, auth, permission
  // resolution, and the organization RLS context.
  describe('PERSONAL organization is refused on every team-scoped billing mutation', () => {
    it('POST /billing/subscriptions returns 422', async () => {
      const { organization, plan, token } = await createPersonalOrganizationContext();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/billing/subscriptions'),
        token,
        organizationPublicId: organization.public_id,
        payload: { plan_id: plan.public_id, billing_cycle: 'monthly' },
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(422);
    });

    it('POST /billing/subscriptions/:subscription_id/change-plan returns 422', async () => {
      const { organization, subscription, token } = await createPersonalOrganizationContext();
      const newPlan = await createTestPlan({ name: 'Personal Guard Plan' });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/change-plan`),
        token,
        organizationPublicId: organization.public_id,
        payload: { plan_id: newPlan.public_id },
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(422);
    });

    it('POST /billing/subscriptions/:subscription_id/cancel returns 422', async () => {
      const { organization, subscription, token } = await createPersonalOrganizationContext();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/cancel`),
        token,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(422);
    });

    it('POST /billing/subscriptions/:subscription_id/resume returns 422', async () => {
      const { organization, subscription, token } = await createPersonalOrganizationContext();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/resume`),
        token,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(422);
    });

    it('the same PERSONAL organization is NOT refused on a subscription READ', async () => {
      // Makes the four cases above non-vacuous: they must fail on the billing guard, not on
      // something incidental to how the personal-organization fixture is built (a missing membership, an
      // unresolvable permission, a bad token claim). `GET /billing/subscriptions` is declared
      // `both` in route-organization-scope.json and carries no team guard, so it must still be 200.
      const { organization, token } = await createPersonalOrganizationContext();

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/subscriptions'),
        token,
        organizationPublicId: organization.public_id,
      });

      expect(response.statusCode).toBe(200);
    });
  });

  // ─── NEGATIVE: Stripe-backed subscription, fail-closed (503) ───────────────
  //
  // When a subscription carries a `provider_subscription_id`, the service performs
  // an external Stripe call before mutating local state and is fail-closed: a
  // provider failure surfaces as ServiceUnavailableError (503) and the local row
  // is NOT mutated. Stripe is unconfigured in CI and local test runs, so a
  // Stripe-backed cancel/resume deterministically returns 503 here.
  describe('Stripe-backed subscription — fail-closed when the provider is unreachable', () => {
    it('should return 503 when cancelling a Stripe-backed subscription with Stripe unconfigured', async () => {
      const { organization, subscription, token } = await createBillingMutationContext({
        status: 'ACTIVE',
        providerSubscriptionId: `sub_test_${generatePublicId('subscription')}`,
      });

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/cancel`),
        token,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(503);
    });

    it('should return 503 when resuming a Stripe-backed subscription with Stripe unconfigured', async () => {
      const { organization, subscription, token } = await createBillingMutationContext({
        status: 'ACTIVE',
        providerSubscriptionId: `sub_test_${generatePublicId('subscription')}`,
      });

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/resume`),
        token,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });

      expect(response.statusCode).toBe(503);
    });

    it('should NOT mutate the local row when the Stripe cancel call fails (fail-closed)', async () => {
      const { organization, subscription, token } = await createBillingMutationContext({
        status: 'ACTIVE',
        providerSubscriptionId: `sub_test_${generatePublicId('subscription')}`,
      });

      // Stripe-backed cancel fails closed → 503.
      const cancelResponse = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}/cancel`),
        token,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': generatePublicId('subscription') },
      });
      expect(cancelResponse.statusCode).toBe(503);

      // The local subscription row must remain unchanged: cancel_at_period_end=false.
      const getResponse = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/billing/subscriptions/${subscription.public_id}`),
        token,
        organizationPublicId: organization.public_id,
      });
      expect(getResponse.statusCode).toBe(200);
      const body = getResponse.json() as { data?: { cancel_at_period_end?: boolean } };
      expect(body.data?.cancel_at_period_end).toBe(false);
    });
  });
});
