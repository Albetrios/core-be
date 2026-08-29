import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { NOTIFY_PERMISSIONS } from '@/domains/notify/notify.permissions.js';
import {
  seedTwoOrganizationsWithSubscriptions,
  seedUploadForOrganization,
} from '@/tests/helpers/test-organization.js';
import { BILLING_PERMISSIONS } from '@/domains/billing/billing.permissions.js';
import { database } from '@/infrastructure/database/connection.js';
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';
import { eq } from 'drizzle-orm';
import { uploads } from '@/domains/upload/upload.schema.js';
import { UPLOAD_PURPOSES, UPLOAD_TARGETS } from '@/domains/upload/upload.constants.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import type { FastifyInstance } from 'fastify';

const SUBSCRIPTION_MUTATION_IDEMPOTENCY_KEY = 'tenant-isolation-subscription-mutation-key';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

const TENANCY_READ_PERMISSIONS = [
  TENANCY_PERMISSIONS.ORGANIZATION_READ,
  TENANCY_PERMISSIONS.MEMBERSHIP_READ,
];

/**
 * Cross-tenant isolation — users must not access another organization's resources.
 */
describe('Security: Tenant isolation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedPermissions([
      ...Object.values(TENANCY_PERMISSIONS),
      ...Object.values(NOTIFY_PERMISSIONS),
    ]);
  });

  async function createOrganizationWithMember(permissionCodes: string[]) {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes,
    });
    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    // Flat tenancy routes resolve the organization from the JWT `org` claim, so
    // every actor's bearer is scoped to its own organization.
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, organization, token };
  }

  it('should return 403 when accessing organization settings without membership', async () => {
    // Flat settings route resolves the organization from the `org` claim. An
    // outsider scoped to organization B (claim = B) but with no membership in B is denied
    // at the permission preHandler — isolation is enforced by membership, not by
    // an organization path segment.
    const organizationB = await createOrganizationWithMember(TENANCY_READ_PERMISSIONS);
    const outsider = await createTestUser({ email: 'no-membership-settings@test.com' });
    const outsiderTokenScopedToB = await generateTestToken({
      userId: outsider.public_id,
      organizationPublicId: organizationB.organization.public_id,
    });

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/settings'),
      token: outsiderTokenScopedToB,
    });

    expect(response.statusCode).toBe(403);
  });

  it('should return 403 when listing memberships without membership', async () => {
    // Same flat-route isolation as settings: an actor scoped to organization B's claim
    // but holding no membership in B cannot list B's memberships.
    const organizationB = await createOrganizationWithMember(TENANCY_READ_PERMISSIONS);
    const outsider = await createTestUser({ email: 'no-membership-memberships@test.com' });
    const outsiderTokenScopedToB = await generateTestToken({
      userId: outsider.public_id,
      organizationPublicId: organizationB.organization.public_id,
    });

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/memberships'),
      token: outsiderTokenScopedToB,
    });

    expect(response.statusCode).toBe(403);
  });

  it('returns 404 when reading a specific webhook in another organization', async () => {
    // Flat webhook routes resolve the organization from the JWT `org` claim, so
    // an actor scoped to organization A can only ever address organization A's webhook collection
    // — there is no path to "list organization B's webhooks". Isolation is therefore a
    // specific-resource concern: organization A's actor (token scoped to A) puts organization B's
    // webhook id in the flat route; the RLS-scoped lookup runs in organization A and B's
    // row is invisible (404).
    const organizationA = await createOrganizationWithMember([NOTIFY_PERMISSIONS.WEBHOOK_READ]);
    const organizationB = await createOrganizationWithMember([NOTIFY_PERMISSIONS.WEBHOOK_READ]);
    const webhookInB = await createTestWebhook({ organizationId: organizationB.organization.id });

    const tokenScopedToA = await generateTestToken({
      userId: organizationA.user.public_id,
      organizationPublicId: organizationA.organization.public_id,
    });

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath(`/notify/webhooks/${webhookInB.public_id}`),
      token: tokenScopedToA,
    });

    expect([403, 404]).toContain(response.statusCode);
    expect(response.statusCode).not.toBe(200);
  });

  it('should allow access to own organization settings with membership', async () => {
    const { token } = await createOrganizationWithMember(TENANCY_READ_PERMISSIONS);

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/settings'),
      token,
    });

    expect([200, 404]).toContain(response.statusCode);
  });

  it('should return 403 for user with no membership on an organization-scoped route', async () => {
    // The outsider carries organization B's claim but no membership in B; the flat
    // settings route resolves to B and the permission preHandler denies it.
    const organizationB = await createOrganizationWithMember(TENANCY_READ_PERMISSIONS);
    const outsider = await createTestUser({ email: 'outsider-cross-tenant@test.com' });
    const outsiderTokenScopedToB = await generateTestToken({
      userId: outsider.public_id,
      organizationPublicId: organizationB.organization.public_id,
    });

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/settings'),
      token: outsiderTokenScopedToB,
    });

    expect(response.statusCode).toBe(403);
  });

  describe('billing subscriptions (HTTP cross-tenant)', () => {
    beforeEach(async () => {
      await seedPermissions([
        BILLING_PERMISSIONS.SUBSCRIPTION_READ,
        BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE,
      ]);
    });

    /**
     * Flat subscription routes resolve the organization from the JWT `org`
     * claim — there is no longer an organization path param. Cross-tenant
     * isolation is therefore expressed as: organization A's actor (token scoped to A)
     * cannot see or mutate organization B's subscription because the RLS-scoped lookup
     * runs in organization A and B's row is invisible (404), not because the path
     * carries B's id.
     */
    async function mintOrganizationAScopedTokenA(
      fixture: Awaited<ReturnType<typeof seedTwoOrganizationsWithSubscriptions>>,
    ): Promise<string> {
      return generateTestToken({
        userId: fixture.userA.public_id,
        organizationPublicId: fixture.organizationA.public_id,
      });
    }

    it("does not expose another organization's subscription when listing", async () => {
      const fixture = await seedTwoOrganizationsWithSubscriptions();
      const tokenScopedToA = await mintOrganizationAScopedTokenA(fixture);

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/billing/subscriptions'),
        token: tokenScopedToA,
      });

      // Org A's actor only ever lists organization A's subscriptions; B's row is invisible.
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data?: Array<{ id?: string }> };
      const visibleIds = (body.data ?? []).map((subscription) => subscription.id);
      expect(visibleIds).toContain(fixture.subscriptionInA.public_id);
      expect(visibleIds).not.toContain(fixture.subscriptionInB.public_id);
    });

    it('returns 404 when reading a subscription in another organization', async () => {
      const fixture = await seedTwoOrganizationsWithSubscriptions();
      const tokenScopedToA = await mintOrganizationAScopedTokenA(fixture);

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/billing/subscriptions/${fixture.subscriptionInB.public_id}`),
        token: tokenScopedToA,
      });

      expect([403, 404]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(200);
    });

    it('returns 404 when patching a subscription in another organization', async () => {
      const fixture = await seedTwoOrganizationsWithSubscriptions();
      const tokenScopedToA = await mintOrganizationAScopedTokenA(fixture);

      // Empty body passes UpdateSubscriptionDto (`.strict()` rejects unknown keys
      // with a 400 before the organization-scoped lookup runs) so the request reaches the
      // isolation boundary and the lookup in organization A cannot find B's row → 404.
      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/billing/subscriptions/${fixture.subscriptionInB.public_id}`),
        token: tokenScopedToA,
        payload: {},
      });

      expect([403, 404]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(200);

      const [row] = await database
        .select({ status: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.id, fixture.subscriptionInB.id));
      expect(row?.status).toBe(fixture.subscriptionInB.status);
    });

    it('returns 404 when canceling a subscription in another organization', async () => {
      const fixture = await seedTwoOrganizationsWithSubscriptions();
      const tokenScopedToA = await mintOrganizationAScopedTokenA(fixture);

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${fixture.subscriptionInB.public_id}/cancel`),
        token: tokenScopedToA,
        headers: { 'x-idempotency-key': SUBSCRIPTION_MUTATION_IDEMPOTENCY_KEY },
        payload: {},
      });

      expect([403, 404]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(200);

      const [row] = await database
        .select({ status: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.id, fixture.subscriptionInB.id));
      expect(row?.status).toBe(fixture.subscriptionInB.status);
    });

    it('returns 404 when changing plan on a subscription in another organization', async () => {
      const fixture = await seedTwoOrganizationsWithSubscriptions();
      const tokenScopedToA = await mintOrganizationAScopedTokenA(fixture);

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${fixture.subscriptionInB.public_id}/change-plan`),
        token: tokenScopedToA,
        headers: { 'x-idempotency-key': SUBSCRIPTION_MUTATION_IDEMPOTENCY_KEY },
        payload: { plan_id: fixture.plan.public_id },
      });

      expect([403, 404]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(200);
    });

    it('returns 404 when resuming a subscription in another organization', async () => {
      const fixture = await seedTwoOrganizationsWithSubscriptions();
      const tokenScopedToA = await mintOrganizationAScopedTokenA(fixture);

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/billing/subscriptions/${fixture.subscriptionInB.public_id}/resume`),
        token: tokenScopedToA,
        headers: { 'x-idempotency-key': SUBSCRIPTION_MUTATION_IDEMPOTENCY_KEY },
        payload: {},
      });

      expect([403, 404]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(200);
    });
  });

  describe('tenancy organization-scoped routes (HTTP cross-tenant)', () => {
    beforeEach(async () => {
      await seedPermissions([
        TENANCY_PERMISSIONS.NOTIFICATION_POLICY_READ,
        TENANCY_PERMISSIONS.API_KEY_READ,
        TENANCY_PERMISSIONS.ROLE_READ,
        NOTIFY_PERMISSIONS.WEBHOOK_READ,
      ]);
    });

    // Flat tenancy routes resolve the organization from the JWT `org` claim, so
    // an actor can only ever address its OWN active organization's collections —
    // there is no path to "list organization B's notification-policies/api-keys/roles".
    // Cross-tenant isolation is therefore: an actor scoped to organization B's claim but
    // holding NO membership in B is denied at the permission preHandler. A member
    // of organization A who tried to reach B would have to carry B's claim, at which point
    // its A-membership grants nothing in B — the same 403.
    it('returns 403 when listing notification policies without membership', async () => {
      const organizationB = await createOrganizationWithMember([
        TENANCY_PERMISSIONS.NOTIFICATION_POLICY_READ,
      ]);
      const outsider = await createTestUser({ email: 'no-membership-policies@test.com' });
      const outsiderTokenScopedToB = await generateTestToken({
        userId: outsider.public_id,
        organizationPublicId: organizationB.organization.public_id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization/notification-policies'),
        token: outsiderTokenScopedToB,
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 403 when listing API keys without membership', async () => {
      const organizationB = await createOrganizationWithMember([TENANCY_PERMISSIONS.API_KEY_READ]);
      const outsider = await createTestUser({ email: 'no-membership-api-keys@test.com' });
      const outsiderTokenScopedToB = await generateTestToken({
        userId: outsider.public_id,
        organizationPublicId: organizationB.organization.public_id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization/api-keys'),
        token: outsiderTokenScopedToB,
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 403 when listing roles without membership', async () => {
      const organizationB = await createOrganizationWithMember([TENANCY_PERMISSIONS.ROLE_READ]);
      const outsider = await createTestUser({ email: 'no-membership-roles@test.com' });
      const outsiderTokenScopedToB = await generateTestToken({
        userId: outsider.public_id,
        organizationPublicId: organizationB.organization.public_id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization/roles'),
        token: outsiderTokenScopedToB,
      });

      expect(response.statusCode).toBe(403);
    });

    it('lists only the claim organization roles, never another organization rows', async () => {
      // Positive cross-tenant list isolation: organization A's member (token scoped to A)
      // lists roles and sees ONLY organization A's roles. Org B's role exists but is
      // invisible because the organization-scoped lookup runs under organization A's RLS context.
      const organizationA = await createOrganizationWithMember([TENANCY_PERMISSIONS.ROLE_READ]);
      const organizationB = await createOrganizationWithMember([TENANCY_PERMISSIONS.ROLE_READ]);
      const roleInB = await createRoleWithPermissions({
        organizationId: organizationB.organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.ROLE_READ],
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization/roles'),
        token: organizationA.token,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { data?: Array<{ id?: string }> };
      const visibleIds = (body.data ?? []).map((role) => role.id);
      expect(visibleIds).not.toContain(roleInB.public_id);
    });

    it('lets an organization actor read the webhook-events catalog (static, not organization data)', async () => {
      // Webhook-events is a flat, static catalog of subscribable event types with
      // no per-organization rows, so a cross-organization variant is meaningless. With the
      // organization resolved from the JWT `org` claim, an actor scoped to organization A
      // simply reads the catalog with WEBHOOK_READ — proving the flattened route is
      // reachable and gated by permission, not by an organization path param.
      const organizationA = await createOrganizationWithMember([NOTIFY_PERMISSIONS.WEBHOOK_READ]);

      const tokenScopedToA = await generateTestToken({
        userId: organizationA.user.public_id,
        organizationPublicId: organizationA.organization.public_id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/notify/webhook-events'),
        token: tokenScopedToA,
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('uploads (HTTP cross-tenant)', () => {
    it('returns 403 when POST organization upload uses another organization id', async () => {
      const fixture = await seedTwoOrganizationsWithSubscriptions();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/uploads'),
        token: fixture.userA.token,
        organizationPublicId: fixture.organizationA.public_id,
        payload: {
          purpose: UPLOAD_PURPOSES.ORGANIZATION_FILE,
          for: UPLOAD_TARGETS.ORGANIZATION,
          organization_id: fixture.organizationB.public_id,
          content_type: 'image/png',
          file_name: 'secret.png',
          file_size: 1024,
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 403 when GET targets an upload in another organization', async () => {
      const fixture = await seedTwoOrganizationsWithSubscriptions();
      const uploadInB = await seedUploadForOrganization({
        userId: fixture.userB.id,
        organizationId: fixture.organizationB.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/uploads/${uploadInB.public_id}`),
        token: fixture.userA.token,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).not.toMatchObject({
        data: expect.objectContaining({ publicId: uploadInB.public_id }),
      });
    });

    it('returns 403 when DELETE targets an upload in another organization and row remains', async () => {
      const fixture = await seedTwoOrganizationsWithSubscriptions();
      const uploadInB = await seedUploadForOrganization({
        userId: fixture.userB.id,
        organizationId: fixture.organizationB.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/uploads/${uploadInB.public_id}`),
        token: fixture.userA.token,
      });

      expect(response.statusCode).toBe(403);

      const [row] = await database
        .select({ deleted_at: uploads.deleted_at })
        .from(uploads)
        .where(eq(uploads.id, uploadInB.id));
      expect(row?.deleted_at).toBeNull();
    });
  });
});
