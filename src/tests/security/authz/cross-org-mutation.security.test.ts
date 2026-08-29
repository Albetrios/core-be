import { randomUUID, createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestApiKey } from '@/tests/factories/organization-api-key.factory.js';
import { createTestNotificationPolicy } from '@/tests/factories/organization-notification-policy.factory.js';
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { NOTIFY_PERMISSIONS } from '@/domains/notify/notify.permissions.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { seedTwoOrganizationsWithSubscriptions } from '@/tests/helpers/test-organization.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { database } from '@/infrastructure/database/connection.js';
import { member_invitations } from '@/domains/tenancy/sub-domains/membership/member-invitation/member-invitation.schema.js';

/**
 * Cross-organization MUTATION isolation matrix — model `organization` (write side) in
 * route-authorization-model.json. The read-side counterpart lives in
 * cross-organization-resource.security.test.ts; here a member of organization A who holds EVERY
 * manage permission in their own organization still cannot mutate organization B's resources:
 * every cross-organization PATCH / DELETE / POST-action / rotate returns 404 (the scoped
 * lookup resolves the resource by `(public_id, active_org_id)`), so no
 * cross-tenant write is possible — the handler never resolves the row. Minimal
 * valid bodies are sent where a route validates a body (so a denial is the
 * 404 scoping result, not a 422), and an X-Idempotency-Key is supplied so
 * idempotency-required writes reach the scoping check rather than the
 * missing-key 422 gate. e2e — runs in CI (Postgres + Redis required).
 */
describe('Security: cross-organization mutation isolation (model: organization — writes)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const created = await createTestApp();
    app = created.app;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  // Every tenancy + notify permission, so the acting member clears each route's
  // MANAGE gate in their OWN organization — a cross-organization 404 therefore proves tenant
  // scoping, not a missing permission (which would surface as 403).
  const ALL_PERMISSION_CODES = [
    ...Object.values(TENANCY_PERMISSIONS),
    ...Object.values(NOTIFY_PERMISSIONS),
  ];

  async function organizationWithResources() {
    await seedPermissions(ALL_PERMISSION_CODES);
    const owner = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ALL_PERMISSION_CODES,
      createdByUserId: owner.id,
    });
    const membership = await createMembership({
      userId: member.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    const apiKey = await createTestApiKey({
      organizationId: organization.id,
      createdByUserId: owner.id,
    });
    const policy = await createTestNotificationPolicy({
      organizationId: organization.id,
      createdByUserId: owner.id,
    });
    const webhook = await createTestWebhook({
      organizationId: organization.id,
      createdByUserId: owner.id,
    });
    // A pending invitation (tied to an INVITED membership) so the invitation
    // DELETE / resend routes have a real organization-scoped target to attack.
    const invitee = await createTestUser();
    const inviteeMembership = await createMembership({
      userId: invitee.id,
      organizationId: organization.id,
      roleId: role.id,
      status: 'INVITED',
    });
    const [invitation] = await database
      .insert(member_invitations)
      .values({
        public_id: generatePublicId('memberInvitation'),
        membership_id: inviteeMembership.id,
        email: invitee.email,
        token_hash: createHash('sha256').update(randomUUID()).digest('hex'),
        invited_by_user_id: owner.id,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        created_by_user_id: owner.id,
      })
      .returning();
    const memberToken = await generateTestToken({
      userId: member.public_id,
      organizationPublicId: organization.public_id,
    });
    return {
      organization,
      member,
      memberToken,
      role,
      membership,
      apiKey,
      policy,
      webhook,
      invitation: invitation!,
    };
  }

  type OrgFixture = Awaited<ReturnType<typeof organizationWithResources>>;

  const mutationCases: ReadonlyArray<{
    label: string;
    method: 'PATCH' | 'DELETE' | 'POST';
    target: (organization: OrgFixture) => string;
    body?: Record<string, unknown>;
  }> = [
    {
      label: 'webhook PATCH',
      method: 'PATCH',
      target: (organization) => `/notify/webhooks/${organization.webhook.public_id}`,
      body: {},
    },
    {
      label: 'webhook DELETE',
      method: 'DELETE',
      target: (organization) => `/notify/webhooks/${organization.webhook.public_id}`,
    },
    {
      label: 'webhook test',
      method: 'POST',
      target: (organization) => `/notify/webhooks/${organization.webhook.public_id}/test`,
    },
    {
      label: 'API key PATCH',
      method: 'PATCH',
      target: (organization) => `/tenancy/organization/api-keys/${organization.apiKey.public_id}`,
      body: {},
    },
    {
      label: 'API key DELETE',
      method: 'DELETE',
      target: (organization) => `/tenancy/organization/api-keys/${organization.apiKey.public_id}`,
    },
    {
      label: 'API key rotate',
      method: 'POST',
      target: (organization) =>
        `/tenancy/organization/api-keys/${organization.apiKey.public_id}/rotate`,
    },
    {
      label: 'role PATCH',
      method: 'PATCH',
      target: (organization) => `/tenancy/organization/roles/${organization.role.public_id}`,
      body: {},
    },
    {
      label: 'role DELETE',
      method: 'DELETE',
      target: (organization) => `/tenancy/organization/roles/${organization.role.public_id}`,
    },
    {
      label: 'notification policy PATCH',
      method: 'PATCH',
      target: (organization) =>
        `/tenancy/organization/notification-policies/${organization.policy.public_id}`,
      body: {},
    },
    {
      label: 'notification policy DELETE',
      method: 'DELETE',
      target: (organization) =>
        `/tenancy/organization/notification-policies/${organization.policy.public_id}`,
    },
    {
      label: 'membership PATCH',
      method: 'PATCH',
      target: (organization) =>
        `/tenancy/organization/memberships/${organization.membership.public_id}`,
      // membership update requires at least one mutable field (status/role_id);
      // an empty body 400s at validation before the cross-organization 404 check, so send
      // a valid body to exercise tenant isolation rather than body validation.
      body: { status: 'ACTIVE' },
    },
    {
      label: 'membership DELETE',
      method: 'DELETE',
      target: (organization) =>
        `/tenancy/organization/memberships/${organization.membership.public_id}`,
    },
    {
      label: 'invitation DELETE',
      method: 'DELETE',
      target: (organization) =>
        `/tenancy/organization/invitations/${organization.invitation.public_id}`,
    },
    {
      label: 'invitation resend',
      method: 'POST',
      target: (organization) =>
        `/tenancy/organization/invitations/${organization.invitation.public_id}/resend`,
      body: {},
    },
  ];

  it.each(mutationCases)(
    'member of organization A $label on an organization B resource → 404 (no cross-organization write)',
    async ({ method, target, body }) => {
      const organizationA = await organizationWithResources();
      const organizationB = await organizationWithResources();
      const res = await injectAuthenticated(app, {
        method,
        url: testApiPath(target(organizationB)),
        token: organizationA.memberToken,
        extraHeaders: { 'x-idempotency-key': randomUUID() },
        ...(body ? { payload: body } : {}),
      });
      expect(res.statusCode).toBe(404);
    },
  );

  // Subscriptions live in the billing domain and need a real (active) plan for
  // change-plan; they use the dedicated two-organization-with-subscriptions fixture. The
  // acting member is organization A's owner (who holds subscription:manage); the target
  // is organization B's subscription. cancel/resume/change-plan are idempotency-required.
  const subscriptionCases: ReadonlyArray<{
    label: string;
    method: 'PATCH' | 'POST';
    suffix: string;
    usesPlan?: boolean;
  }> = [
    { label: 'PATCH', method: 'PATCH', suffix: '' },
    { label: 'cancel', method: 'POST', suffix: '/cancel' },
    { label: 'resume', method: 'POST', suffix: '/resume' },
    { label: 'change-plan', method: 'POST', suffix: '/change-plan', usesPlan: true },
  ];

  it.each(subscriptionCases)(
    "member of organization A $label organization B's subscription → 404 (no cross-organization write)",
    async ({ method, suffix, usesPlan }) => {
      const fixture = await seedTwoOrganizationsWithSubscriptions();
      const tokenScopedToOrgA = await generateTestToken({
        userId: fixture.userA.public_id,
        organizationPublicId: fixture.organizationA.public_id,
      });
      // change-plan resolves the (real, active) plan before the subscription, so
      // pass the fixture's real plan id — the resulting 404 is then the
      // subscription scoped-lookup miss, proving cross-organization isolation.
      const payload = usesPlan ? { plan_id: fixture.plan.public_id } : {};
      const res = await injectAuthenticated(app, {
        method,
        url: testApiPath(`/billing/subscriptions/${fixture.subscriptionInB.public_id}${suffix}`),
        token: tokenScopedToOrgA,
        organizationPublicId: fixture.organizationA.public_id,
        extraHeaders: { 'x-idempotency-key': randomUUID() },
        payload,
      });
      expect(res.statusCode).toBe(404);
    },
  );
});
