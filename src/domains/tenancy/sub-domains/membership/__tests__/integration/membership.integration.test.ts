import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, count, eq, isNull } from 'drizzle-orm';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectAuthenticatedOrganizationMutation,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import {
  generateTestToken,
  generateTestTokenWithActiveSession,
} from '@/tests/helpers/test-auth.js';
import {
  seedPermissions,
  seedAllPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { MemberInvitationRepository } from '@/domains/tenancy/sub-domains/membership/member-invitation/member-invitation.repository.js';
import { member_invitations } from '@/domains/tenancy/sub-domains/membership/member-invitation/member-invitation.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { hashInvitationToken } from '@/domains/tenancy/sub-domains/membership/member-invitation/member-invitation.token.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import {
  provisionPersonalOrganization,
  provisionOrganizationWithOwner,
} from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import enErrors from '@/shared/locales/en/errors.json' with { type: 'json' };
import type { FastifyInstance } from 'fastify';

const MEMBERSHIP_PERMISSIONS = [
  TENANCY_PERMISSIONS.MEMBERSHIP_READ,
  TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE,
  TENANCY_PERMISSIONS.INVITATION_MANAGE,
  TENANCY_PERMISSIONS.ORGANIZATION_READ,
  TENANCY_PERMISSIONS.ORGANIZATION_UPDATE,
];

describe('Membership Sub-Domain — Integration', () => {
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
    await seedPermissions(MEMBERSHIP_PERMISSIONS);
  });

  async function createAuthorizedContext() {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: MEMBERSHIP_PERMISSIONS,
    });
    const membership = await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    // Flat tenancy routes resolve the organization from the JWT `org` claim.
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { organization, token, membership, user };
  }

  describe('GET /api/v1/tenancy/organization/memberships', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization/memberships'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return memberships with permission, emitting public ids (not internal sequential ids)', async () => {
      const { organization, token } = await createAuthorizedContext();
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/tenancy/organization/memberships`),
        token,
        organizationPublicId: organization.public_id,
      });
      expect(response.statusCode).toBe(200);

      const body = response.json() as {
        data?: { user_id: string; role_id: string }[];
      };
      const items = body.data ?? [];
      expect(items.length).toBeGreaterThan(0);
      const member = items[0]!;
      // Prefixed public ids, never the internal bigserial ids ("1", "42", ...).
      expect(member.user_id).toMatch(/^usr_[a-z0-9]{21}$/);
      expect(member.role_id).toMatch(/^rol_[a-z0-9]{21}$/);
      expect(member.user_id).not.toMatch(/^\d+$/);
      expect(member.role_id).not.toMatch(/^\d+$/);
    });
  });

  describe('POST /api/v1/tenancy/organization/memberships', () => {
    it('seeds new member user settings from organization default_locale', async () => {
      const admin = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: admin.id });
      const adminRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: MEMBERSHIP_PERMISSIONS,
      });
      await createMembership({
        userId: admin.id,
        organizationId: organization.id,
        roleId: adminRole.id,
      });
      const { token: adminToken } = await generateTestTokenWithActiveSession(app, admin.public_id, {
        organizationPublicId: organization.public_id,
      });

      const settingsPatch = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/tenancy/organization/settings`),
        token: adminToken,
        organizationPublicId: organization.public_id,
        payload: { default_locale: 'es' },
      });
      expect(settingsPatch.statusCode).toBe(200);

      const newMember = await createTestUser({ email: 'org-locale-member@test.com' });
      const memberRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.MEMBERSHIP_READ],
      });

      // REQ-1: add-member-by-email. findOrCreateInvitedByEmail resolves the existing user; the organization
      // default locale is applied on create regardless of the INVITED status.
      const createMembershipResponse = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/organization/memberships`),
        token: adminToken,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: {
          email: newMember.email,
          role_id: memberRole.public_id,
        },
      });
      expect(createMembershipResponse.statusCode).toBe(200);

      const { token: memberToken } = await generateTestTokenWithActiveSession(
        app,
        newMember.public_id,
      );
      const settingsResponse = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/users/me/settings'),
        token: memberToken,
      });
      expect(settingsResponse.statusCode).toBe(200);
      const settingsData = (settingsResponse.json() as { data: Record<string, unknown> }).data;
      expect(settingsData.language).toBe('es');
      expect(settingsData.preferred_locales).toEqual(['es']);
    });

    it('creates an INVITED membership (never directly ACTIVE) via add-member-by-email', async () => {
      const admin = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: admin.id });
      const adminRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: MEMBERSHIP_PERMISSIONS,
      });
      await createMembership({
        userId: admin.id,
        organizationId: organization.id,
        roleId: adminRole.id,
      });
      const { token: adminToken } = await generateTestTokenWithActiveSession(app, admin.public_id, {
        organizationPublicId: organization.public_id,
      });
      const memberRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.MEMBERSHIP_READ],
      });

      // REQ-1: add-member-by-email always creates an INVITED membership (status is no longer an
      // accepted input). Initial activation must come from invitation acceptance — a manager cannot
      // mint an already-active member. The new INVITED row keeps joined_at null.
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/organization/memberships`),
        token: adminToken,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: {
          email: `invited-only-${randomUUID()}@test.com`,
          role_id: memberRole.public_id,
        },
      });
      expect(response.statusCode).toBe(200);
      const created = (response.json() as { data: { id: string; status: string } }).data;
      expect(created.status).toBe('INVITED');

      const [row] = await getOperatorDatabase()
        .select()
        .from(memberships)
        .where(eq(memberships.public_id, created.id));
      expect(row!.status).toBe('INVITED');
      expect(row!.joined_at).toBeNull();
    });
  });

  describe('POST /api/v1/tenancy/organization/memberships — REQ-4 seat enforcement', () => {
    // Builds an organization whose owner+admin already holds a seat, optionally with an active subscription on
    // a plan that grants `includedSeats` seats. Returns the admin token + a grantable member role.
    async function createSeatLimitedContext(
      includedSeats: number | null,
      withSubscription: boolean,
    ) {
      const admin = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: admin.id });
      const adminRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: MEMBERSHIP_PERMISSIONS,
      });
      // The owner's membership occupies one seat (ACTIVE).
      await createMembership({
        userId: admin.id,
        organizationId: organization.id,
        roleId: adminRole.id,
      });
      if (withSubscription) {
        const plan = await createTestPlan({ includedSeats });
        // Local-only subscription so the seat check never touches Stripe.
        await createTestSubscription({
          organizationId: organization.id,
          planId: plan.id,
          status: 'ACTIVE',
          provider: null,
          providerSubscriptionId: null,
        });
      }
      const { token: adminToken } = await generateTestTokenWithActiveSession(app, admin.public_id, {
        organizationPublicId: organization.public_id,
      });
      // A member role carrying a subset of the admin's permissions (passes the escalation guard).
      const memberRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.MEMBERSHIP_READ],
      });
      return { organization, adminToken, memberRole };
    }

    async function inviteMember(
      organizationPublicId: string,
      adminToken: string,
      memberRolePublicId: string,
    ) {
      return injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/memberships'),
        token: adminToken,
        organizationPublicId,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { email: `seat-${randomUUID()}@test.com`, role_id: memberRolePublicId },
      });
    }

    it('returns 409 seat_limit_reached when the plan seat limit is already filled', async () => {
      // Plan grants 1 seat; the owner already occupies it, so the next add must be rejected.
      const { organization, adminToken, memberRole } = await createSeatLimitedContext(1, true);
      const response = await inviteMember(organization.public_id, adminToken, memberRole.public_id);
      expect(response.statusCode).toBe(409);
      const body = response.json() as { error: { reason?: string } };
      expect(body.error.reason).toBe('seat_limit_reached');
    });

    it('allows the add when the plan still has free seats', async () => {
      // Plan grants 5 seats; only the owner is using one, so adding a member succeeds.
      const { organization, adminToken, memberRole } = await createSeatLimitedContext(5, true);
      const response = await inviteMember(organization.public_id, adminToken, memberRole.public_id);
      expect(response.statusCode).toBe(200);
    });

    it('allows the add when no billing is configured at all (empty plan catalog → unlimited)', async () => {
      // No subscription AND no plan catalog → the Free-tier ceiling resolves to null (unlimited), so
      // a deployment with no plans seeded imposes no cap. F3 only bites once a catalog exists.
      const { organization, adminToken, memberRole } = await createSeatLimitedContext(null, false);
      const response = await inviteMember(organization.public_id, adminToken, memberRole.public_id);
      expect(response.statusCode).toBe(200);
    });

    it('caps an unsubscribed organization at the Free-tier ceiling when a plan catalog exists (F3)', async () => {
      // A plan catalog exists (cheapest active plan grants 1 seat) but the organization has NO subscription.
      // Its entitlement falls to the Free-tier ceiling, so the owner's seat fills it and the next add
      // is rejected — "no members until you subscribe".
      const { organization, adminToken, memberRole } = await createSeatLimitedContext(null, false);
      await createTestPlan({ includedSeats: 1 });
      const response = await inviteMember(organization.public_id, adminToken, memberRole.public_id);
      expect(response.statusCode).toBe(409);
      expect((response.json() as { error: { reason?: string } }).error.reason).toBe(
        'seat_limit_reached',
      );
    });

    it('counts an outstanding INVITED membership against the seat limit', async () => {
      // Plan grants 2 seats: owner (1) + one invite (1) = full; a second invite must 409.
      const { organization, adminToken, memberRole } = await createSeatLimitedContext(2, true);
      const first = await inviteMember(organization.public_id, adminToken, memberRole.public_id);
      expect(first.statusCode).toBe(200);
      const second = await inviteMember(organization.public_id, adminToken, memberRole.public_id);
      expect(second.statusCode).toBe(409);
      expect((second.json() as { error: { reason?: string } }).error.reason).toBe(
        'seat_limit_reached',
      );
    });

    // F1: a SUSPENDED membership is not counted toward the seat cap, so reactivating it
    // (SUSPENDED -> ACTIVE via PATCH) re-consumes a seat and must pass the same seat check as add.
    async function reactivateSuspendedMember(
      organizationPublicId: string,
      organizationId: number,
      adminToken: string,
      memberRoleId: number,
    ) {
      const member = await createTestUser();
      const suspended = await createMembership({
        userId: member.id,
        organizationId,
        roleId: memberRoleId,
        status: 'SUSPENDED',
      });
      return injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: testApiPath(`/tenancy/organization/memberships/${suspended.public_id}`),
        token: adminToken,
        organizationPublicId,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { status: 'ACTIVE' },
      });
    }

    it('returns 409 seat_limit_reached when reactivating a SUSPENDED member would exceed the cap (F1)', async () => {
      // Plan grants 1 seat; the owner occupies it. The SUSPENDED member does not count, but
      // reactivating it would make 2 ACTIVE on a 1-seat plan — must be rejected.
      const { organization, adminToken, memberRole } = await createSeatLimitedContext(1, true);
      const response = await reactivateSuspendedMember(
        organization.public_id,
        organization.id,
        adminToken,
        memberRole.id,
      );
      expect(response.statusCode).toBe(409);
      expect((response.json() as { error: { reason?: string } }).error.reason).toBe(
        'seat_limit_reached',
      );
    });

    it('allows reactivating a SUSPENDED member when the plan still has a free seat (F1)', async () => {
      // Plan grants 5 seats; only the owner is active, so reactivation fits under the cap.
      const { organization, adminToken, memberRole } = await createSeatLimitedContext(5, true);
      const response = await reactivateSuspendedMember(
        organization.public_id,
        organization.id,
        adminToken,
        memberRole.id,
      );
      expect(response.statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/invitations/:invitation_id/accept (membership activation)', () => {
    async function createPendingInvitation() {
      const { organization, token, user: admin } = await createAuthorizedContext();
      // The invitee must have a verified email to accept (they onboard via magic-link / OAuth /
      // email-verified signup first); the accept route rejects an unverified caller (sec-T4 follow-up).
      const invitee = await createTestUser({
        email: `invitee-${randomUUID()}@test.com`,
        isEmailVerified: true,
      });
      const memberRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.MEMBERSHIP_READ],
      });
      const [inviteeMembership] = await getOperatorDatabase()
        .insert(memberships)
        .values({
          public_id: generatePublicId('membership'),
          user_id: invitee.id,
          organization_id: organization.id,
          role_id: memberRole.id,
          status: 'INVITED',
        })
        .returning();
      const rawToken = `accept-token-${randomUUID()}`;
      const invitationRepository = new MemberInvitationRepository();
      const invitation = await withAppDatabaseContext(
        // Mirrors `MemberInvitationService`, which always calls this repository inside the
        // organization context: `tenancy.member_invitations` is FORCE RLS with WITH CHECK
        // pinned to the active organization, so a context-free create is rejected the moment
        // the pool under test is RLS-subject.
        PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id }),
        () =>
          invitationRepository.create({
            membership_id: inviteeMembership!.id,
            email: invitee.email,
            token_hash: hashInvitationToken(rawToken),
            invited_by_user_id: admin.id,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1_000),
            created_by_user_id: admin.id,
          }),
      );
      return {
        organization,
        token,
        invitation,
        invitee,
        inviteeMembership: inviteeMembership!,
        rawToken,
      };
    }

    it('atomically activates the linked membership when the invitation is accepted', async () => {
      const { organization, invitation, invitee, inviteeMembership, rawToken } =
        await createPendingInvitation();
      const inviteeToken = await generateTestToken({ userId: invitee.public_id });

      const acceptResponse = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/invitations/${invitation.public_id}/accept`),
        token: inviteeToken,
        payload: { token: rawToken },
      });
      expect(acceptResponse.statusCode).toBe(200);
      // The accept response carries the joined org's public id so the client can
      // POST /auth/switch-to-organization into it without a separate lookup (gate reduction).
      expect(
        (acceptResponse.json() as { data: { organization_id: string } }).data.organization_id,
      ).toBe(organization.public_id);

      const [updated] = await getOperatorDatabase()
        .select()
        .from(memberships)
        .where(eq(memberships.id, inviteeMembership.id));
      expect(updated!.status).toBe('ACTIVE');
      expect(updated!.joined_at).not.toBeNull();
    });

    it('notifies the organization membership-managers when the invitation is accepted (item #10)', async () => {
      const {
        organization,
        invitation,
        invitee,
        rawToken,
        token: adminToken,
      } = await createPendingInvitation();
      const inviteeToken = await generateTestToken({ userId: invitee.public_id });

      const acceptResponse = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/invitations/${invitation.public_id}/accept`),
        token: inviteeToken,
        payload: { token: rawToken },
      });
      expect(acceptResponse.statusCode).toBe(200);

      // Regression for item #10: the inviter (a membership:manage holder) previously saw an EMPTY
      // inbox after an invitee accepted. Now an in-app `membership.invite_accepted` row is created.
      const notificationsResponse = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/notify/notifications'),
        token: adminToken,
        organizationPublicId: organization.public_id,
      });
      expect(notificationsResponse.statusCode).toBe(200);
      const rows =
        (notificationsResponse.json() as { data?: Array<{ type?: string; action_url?: string }> })
          .data ?? [];
      const inviteAccepted = rows.filter((row) => row.type === 'membership.invite_accepted');
      expect(inviteAccepted).toHaveLength(1);
      expect(inviteAccepted[0]?.action_url).toBe('/settings/members');
    });

    it('rejects a manager PATCH that tries to activate a never-joined membership', async () => {
      const { organization, token, inviteeMembership } = await createPendingInvitation();

      const patchResponse = await injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: testApiPath(`/tenancy/organization/memberships/${inviteeMembership.public_id}`),
        token,
        organizationPublicId: organization.public_id,
        payload: { status: 'ACTIVE' },
      });
      expect(patchResponse.statusCode).toBe(403);

      const [stillInvited] = await getOperatorDatabase()
        .select()
        .from(memberships)
        .where(eq(memberships.id, inviteeMembership.id));
      expect(stillInvited!.status).toBe('INVITED');
      expect(stillInvited!.joined_at).toBeNull();
    });
  });

  describe('PATCH /api/v1/tenancy/organization/memberships/:membership_id (role change, REQ-3)', () => {
    it("changes an active member's role and persists the new role_id", async () => {
      const { organization, token } = await createAuthorizedContext();
      const member = await createTestUser({ email: `rerole-${randomUUID()}@test.com` });
      const fromRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.MEMBERSHIP_READ],
      });
      // Target role with no permissions, so the privilege-escalation guard trivially passes
      // (the caller can always grant the empty set) — isolates the role-change behavior.
      const toRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [],
      });
      const [membership] = await getOperatorDatabase()
        .insert(memberships)
        .values({
          public_id: generatePublicId('membership'),
          user_id: member.id,
          organization_id: organization.id,
          role_id: fromRole.id,
          status: 'ACTIVE',
          joined_at: new Date(),
        })
        .returning();

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: testApiPath(`/tenancy/organization/memberships/${membership!.public_id}`),
        token,
        organizationPublicId: organization.public_id,
        payload: { role_id: toRole.public_id },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: { role_id: string; role: { id: string } };
      };
      // Flat + embedded role public id both reflect the new role (REQ-2 embed).
      expect(body.data.role_id).toBe(toRole.public_id);
      expect(body.data.role.id).toBe(toRole.public_id);

      const [row] = await getOperatorDatabase()
        .select()
        .from(memberships)
        .where(eq(memberships.id, membership!.id));
      expect(row!.role_id).toBe(toRole.id);
    });
  });

  describe('DELETE /api/v1/tenancy/organization/invitations/:invitation_id (route-coverage gap-fill)', () => {
    async function createPendingInvitationForAdminRevoke() {
      const { organization, token: adminToken, user: admin } = await createAuthorizedContext();
      const invitee = await createTestUser({ email: `admin-revoke-${randomUUID()}@test.com` });
      const memberRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.MEMBERSHIP_READ],
      });
      const [inviteeMembership] = await getOperatorDatabase()
        .insert(memberships)
        .values({
          public_id: generatePublicId('membership'),
          user_id: invitee.id,
          organization_id: organization.id,
          role_id: memberRole.id,
          status: 'INVITED',
        })
        .returning();
      const invitationRepository = new MemberInvitationRepository();
      const invitation = await withAppDatabaseContext(
        // Mirrors `MemberInvitationService`, which always calls this repository inside the
        // organization context: `tenancy.member_invitations` is FORCE RLS with WITH CHECK
        // pinned to the active organization, so a context-free create is rejected the moment
        // the pool under test is RLS-subject.
        PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id }),
        () =>
          invitationRepository.create({
            membership_id: inviteeMembership!.id,
            email: invitee.email,
            token_hash: hashInvitationToken(`admin-revoke-token-${randomUUID()}`),
            invited_by_user_id: admin.id,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1_000),
            created_by_user_id: admin.id,
          }),
      );
      return { organization, adminToken, invitation, inviteeMembership: inviteeMembership! };
    }

    it('admin revokes a pending invitation (204 + revoked_at set, auto-created INVITED membership soft-deleted)', async () => {
      const { organization, adminToken, invitation, inviteeMembership } =
        await createPendingInvitationForAdminRevoke();
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'DELETE',
        url: testApiPath(`/tenancy/organization/invitations/${invitation.public_id}`),
        token: adminToken,
        organizationPublicId: organization.public_id,
      });
      expect(response.statusCode).toBe(204);

      const [revoked] = await getOperatorDatabase()
        .select()
        .from(member_invitations)
        .where(eq(member_invitations.id, invitation.id));
      expect(revoked!.revoked_at).not.toBeNull();
      expect(revoked!.accepted_at).toBeNull();

      // REQ-1/REQ-3: the membership was auto-created by the invite, so revoking removes the invitee
      // entirely (no ghost INVITED row left in the members table).
      const [softDeleted] = await getOperatorDatabase()
        .select()
        .from(memberships)
        .where(eq(memberships.id, inviteeMembership.id));
      expect(softDeleted!.deleted_at).not.toBeNull();
    });

    it('refuses cross-organization revoke attempts with 404 (tenant isolation)', async () => {
      const { organization: organizationA, invitation } =
        await createPendingInvitationForAdminRevoke();
      const { organization: organizationB, token: organizationBAdminToken } =
        await createAuthorizedContext();
      expect(organizationA.id).not.toBe(organizationB.id);

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/tenancy/organization/invitations/${invitation.public_id}`),
        token: organizationBAdminToken,
        organizationPublicId: organizationB.public_id,
      });
      expect(response.statusCode).toBe(404);

      const [untouched] = await getOperatorDatabase()
        .select()
        .from(member_invitations)
        .where(eq(member_invitations.id, invitation.id));
      expect(untouched!.revoked_at).toBeNull();
    });

    it('rejects non-admin (no invitation:manage permission) with 403', async () => {
      const { organization, invitation } = await createPendingInvitationForAdminRevoke();
      const readOnlyUser = await createTestUser({ email: `read-only-${randomUUID()}@test.com` });
      const readOnlyRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.MEMBERSHIP_READ],
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
        method: 'DELETE',
        url: testApiPath(`/tenancy/organization/invitations/${invitation.public_id}`),
        token: readOnlyToken,
        organizationPublicId: organization.public_id,
      });
      expect(response.statusCode).toBe(403);

      const [stillPending] = await getOperatorDatabase()
        .select()
        .from(member_invitations)
        .where(eq(member_invitations.id, invitation.id));
      expect(stillPending!.revoked_at).toBeNull();
    });
  });

  describe('POST /api/v1/tenancy/organization/invitations/:invitation_id/resend (route-coverage gap-fill)', () => {
    async function createPendingInvitationForResend() {
      const { organization, token: adminToken, user: admin } = await createAuthorizedContext();
      const invitee = await createTestUser({ email: `resend-${randomUUID()}@test.com` });
      const memberRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.MEMBERSHIP_READ],
      });
      const [inviteeMembership] = await getOperatorDatabase()
        .insert(memberships)
        .values({
          public_id: generatePublicId('membership'),
          user_id: invitee.id,
          organization_id: organization.id,
          role_id: memberRole.id,
          status: 'INVITED',
        })
        .returning();
      const invitationRepository = new MemberInvitationRepository();
      const originalTokenHash = hashInvitationToken(`original-token-${randomUUID()}`);
      const invitation = await withAppDatabaseContext(
        // Mirrors `MemberInvitationService`, which always calls this repository inside the
        // organization context: `tenancy.member_invitations` is FORCE RLS with WITH CHECK
        // pinned to the active organization, so a context-free create is rejected the moment
        // the pool under test is RLS-subject.
        PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id }),
        () =>
          invitationRepository.create({
            membership_id: inviteeMembership!.id,
            email: invitee.email,
            token_hash: originalTokenHash,
            invited_by_user_id: admin.id,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1_000),
            created_by_user_id: admin.id,
          }),
      );
      return { organization, adminToken, invitation, originalTokenHash };
    }

    it('rotates the token_hash and extends expires_at on resend (200)', async () => {
      const { organization, adminToken, invitation, originalTokenHash } =
        await createPendingInvitationForResend();
      const originalExpiresAt = invitation.expires_at.getTime();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/organization/invitations/${invitation.public_id}/resend`),
        token: adminToken,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { expires_in_days: 10 },
      });
      expect(response.statusCode).toBe(200);

      const [rotated] = await getOperatorDatabase()
        .select()
        .from(member_invitations)
        .where(eq(member_invitations.id, invitation.id));
      expect(rotated!.token_hash).not.toBe(originalTokenHash);
      expect(rotated!.expires_at.getTime()).toBeGreaterThan(originalExpiresAt);
      expect(rotated!.revoked_at).toBeNull();
      expect(rotated!.accepted_at).toBeNull();
    });

    it('rejects resend on a revoked invitation (400)', async () => {
      const { organization, adminToken, invitation } = await createPendingInvitationForResend();
      await getOperatorDatabase()
        .update(member_invitations)
        .set({ revoked_at: new Date() })
        .where(eq(member_invitations.id, invitation.id));

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/organization/invitations/${invitation.public_id}/resend`),
        token: adminToken,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { expires_in_days: 10 },
      });
      expect(response.statusCode).toBe(400);
    });

    it('refuses cross-tenant resend with 404 (tenant isolation)', async () => {
      const { invitation } = await createPendingInvitationForResend();
      const { organization: organizationB, token: organizationBAdminToken } =
        await createAuthorizedContext();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/organization/invitations/${invitation.public_id}/resend`),
        token: organizationBAdminToken,
        organizationPublicId: organizationB.public_id,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { expires_in_days: 10 },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /api/v1/tenancy/organization/leave (route-coverage gap-fill)', () => {
    it('soft-deletes the membership when a non-owner leaves (200)', async () => {
      const owner = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: owner.id });
      const memberRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.MEMBERSHIP_READ],
      });
      const member = await createTestUser({ email: `leaver-${randomUUID()}@test.com` });
      const memberMembership = await createMembership({
        userId: member.id,
        organizationId: organization.id,
        roleId: memberRole.id,
      });
      const memberToken = await generateTestToken({
        userId: member.public_id,
        organizationPublicId: organization.public_id,
      });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/organization/leave`),
        token: memberToken,
        organizationPublicId: organization.public_id,
      });
      expect(response.statusCode).toBe(200);

      const [softDeleted] = await getOperatorDatabase()
        .select()
        .from(memberships)
        .where(eq(memberships.id, memberMembership.id));
      expect(softDeleted!.deleted_at).not.toBeNull();
    });

    it('refuses to let the organization owner leave (403)', async () => {
      const owner = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: owner.id });
      const ownerRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: MEMBERSHIP_PERMISSIONS,
      });
      const ownerMembership = await createMembership({
        userId: owner.id,
        organizationId: organization.id,
        roleId: ownerRole.id,
      });
      const ownerToken = await generateTestToken({
        userId: owner.public_id,
        organizationPublicId: organization.public_id,
      });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/organization/leave`),
        token: ownerToken,
        organizationPublicId: organization.public_id,
      });
      expect(response.statusCode).toBe(403);

      const [stillActive] = await getOperatorDatabase()
        .select()
        .from(memberships)
        .where(eq(memberships.id, ownerMembership.id));
      expect(stillActive!.deleted_at).toBeNull();
    });
  });

  describe('Organization logo routes (route-coverage gap-fill)', () => {
    describe('PUT /api/v1/tenancy/organization/logo', () => {
      it('rejects callers without organization:update permission (403)', async () => {
        const admin = await createTestUser();
        const organization = await createTestOrganization({ ownerUserId: admin.id });
        const readOnlyUser = await createTestUser({
          email: `logo-read-only-${randomUUID()}@test.com`,
        });
        const readOnlyRole = await createRoleWithPermissions({
          organizationId: organization.id,
          permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
        });
        await createMembership({
          userId: readOnlyUser.id,
          organizationId: organization.id,
          roleId: readOnlyRole.id,
        });
        const token = await generateTestToken({
          userId: readOnlyUser.public_id,
          organizationPublicId: organization.public_id,
        });

        const response = await injectAuthenticated(app, {
          method: 'PUT',
          url: testApiPath(`/tenancy/organization/logo`),
          token,
          organizationPublicId: organization.public_id,
          payload: { key: `organization-logos/${organization.public_id}/logo.png` },
        });
        expect(response.statusCode).toBe(403);
      });

      it('rejects a key that does not belong to this organization (400)', async () => {
        const { organization, token } = await createAuthorizedContext();
        const response = await injectAuthenticated(app, {
          method: 'PUT',
          url: testApiPath(`/tenancy/organization/logo`),
          token,
          organizationPublicId: organization.public_id,
          payload: { key: 'organization-logos/some-other-organization/logo.png' },
        });
        expect(response.statusCode).toBe(400);
      });
    });

    describe('DELETE /api/v1/tenancy/organization/logo', () => {
      it('rejects callers without organization:update permission (403)', async () => {
        const admin = await createTestUser();
        const organization = await createTestOrganization({ ownerUserId: admin.id });
        const readOnlyUser = await createTestUser({
          email: `logo-del-read-only-${randomUUID()}@test.com`,
        });
        const readOnlyRole = await createRoleWithPermissions({
          organizationId: organization.id,
          permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
        });
        await createMembership({
          userId: readOnlyUser.id,
          organizationId: organization.id,
          roleId: readOnlyRole.id,
        });
        const token = await generateTestToken({
          userId: readOnlyUser.public_id,
          organizationPublicId: organization.public_id,
        });

        const response = await injectAuthenticated(app, {
          method: 'DELETE',
          url: testApiPath(`/tenancy/organization/logo`),
          token,
          organizationPublicId: organization.public_id,
        });
        expect(response.statusCode).toBe(403);
      });

      it('is a no-op (204) when no logo is set — does not touch S3', async () => {
        const { organization, token } = await createAuthorizedContext();

        const response = await injectAuthenticated(app, {
          method: 'DELETE',
          url: testApiPath(`/tenancy/organization/logo`),
          token,
          organizationPublicId: organization.public_id,
        });
        expect(response.statusCode).toBe(204);
      });
    });
  });

  describe('GET /api/v1/tenancy/organization/memberships/:membership_id/permissions (route-coverage gap-fill)', () => {
    it('returns the resolved permission codes for a membership (200)', async () => {
      const { organization, token, membership } = await createAuthorizedContext();

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/tenancy/organization/memberships/${membership.public_id}/permissions`),
        token,
        organizationPublicId: organization.public_id,
      });
      expect(response.statusCode).toBe(200);

      const body = response.json() as { data?: { permissions?: string[] } };
      const permissions = body.data?.permissions ?? [];
      expect(permissions).toEqual(expect.arrayContaining(MEMBERSHIP_PERMISSIONS));
    });

    it('refuses cross-organization lookups with 404 (tenant isolation)', async () => {
      const { membership: organizationAMembership } = await createAuthorizedContext();
      const { organization: organizationB, token: organizationBToken } =
        await createAuthorizedContext();

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(
          `/tenancy/organization/memberships/${organizationAMembership.public_id}/permissions`,
        ),
        token: organizationBToken,
        organizationPublicId: organizationB.public_id,
      });
      expect(response.statusCode).toBe(404);
    });

    it('rejects callers without membership:read permission (403)', async () => {
      const admin = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: admin.id });
      const adminRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: MEMBERSHIP_PERMISSIONS,
      });
      const adminMembership = await createMembership({
        userId: admin.id,
        organizationId: organization.id,
        roleId: adminRole.id,
      });
      const limitedUser = await createTestUser({
        email: `mem-perm-limited-${randomUUID()}@test.com`,
      });
      const limitedRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
      });
      await createMembership({
        userId: limitedUser.id,
        organizationId: organization.id,
        roleId: limitedRole.id,
      });
      const limitedToken = await generateTestToken({
        userId: limitedUser.public_id,
        organizationPublicId: organization.public_id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(
          `/tenancy/organization/memberships/${adminMembership.public_id}/permissions`,
        ),
        token: limitedToken,
        organizationPublicId: organization.public_id,
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('PATCH /api/v1/tenancy/organization/memberships/:membership_id (route-coverage gap-fill)', () => {
    it('returns 400 for an out-of-enum status (validator wired at the boundary)', async () => {
      // updateMembershipDto's enum rule was unit-proven; no 400 was ever observed on this route.
      // The refusal must come from the validator, not the lookup, so the target membership is real.
      const { organization, token: ownerToken } = await createAuthorizedContext();
      const member = await createTestUser({ email: `patch-400-${randomUUID()}@test.com` });
      const memberRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.MEMBERSHIP_READ],
      });
      const membership = await createMembership({
        userId: member.id,
        organizationId: organization.id,
        roleId: memberRole.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/tenancy/organization/memberships/${membership.public_id}`),
        token: ownerToken,
        organizationPublicId: organization.public_id,
        payload: { status: 'NOT_A_STATUS' },
      });
      expect(response.statusCode, response.body).toBe(400);
    });
  });

  describe('POST /api/v1/tenancy/organization/transfer-ownership (route-coverage gap-fill)', () => {
    it('returns 400 when new_owner_user_id is missing (validator wired at the boundary)', async () => {
      // The DTO rule is unit-proven; no 400 was ever observed on this route, so a validator that
      // stopped being wired in would pass every existing case. Key supplied → the idempotency 422
      // cannot fire; what remains is the validator's own refusal.
      const { organization, token: ownerToken } = await createAuthorizedContext();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/organization/transfer-ownership`),
        token: ownerToken,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(400);
    });

    it('transfers ownership: organizations.owner_user_id updated (200)', async () => {
      const { organization, token: ownerToken, user: owner } = await createAuthorizedContext();
      const newOwner = await createTestUser({ email: `new-owner-${randomUUID()}@test.com` });
      const memberRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: MEMBERSHIP_PERMISSIONS,
      });
      await createMembership({
        userId: newOwner.id,
        organizationId: organization.id,
        roleId: memberRole.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/organization/transfer-ownership`),
        token: ownerToken,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { new_owner_user_id: newOwner.public_id },
      });
      expect(response.statusCode).toBe(200);

      const [updatedOrg] = await getOperatorDatabase()
        .select()
        .from(organizations)
        .where(eq(organizations.id, organization.id));
      expect(updatedOrg!.owner_user_id).toBe(newOwner.id);
      expect(updatedOrg!.owner_user_id).not.toBe(owner.id);
    });

    it('rejects non-owner callers with 403 (errors:onlyOwnerCanTransfer)', async () => {
      const { organization } = await createAuthorizedContext();
      const nonOwner = await createTestUser({ email: `non-owner-${randomUUID()}@test.com` });
      const role = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: MEMBERSHIP_PERMISSIONS,
      });
      await createMembership({
        userId: nonOwner.id,
        organizationId: organization.id,
        roleId: role.id,
      });
      const nonOwnerToken = await generateTestToken({
        userId: nonOwner.public_id,
        organizationPublicId: organization.public_id,
      });
      const target = await createTestUser({ email: `target-${randomUUID()}@test.com` });
      await createMembership({
        userId: target.id,
        organizationId: organization.id,
        roleId: role.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/organization/transfer-ownership`),
        token: nonOwnerToken,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { new_owner_user_id: target.public_id },
      });
      expect(response.statusCode).toBe(403);

      const [organizationUnchanged] = await getOperatorDatabase()
        .select()
        .from(organizations)
        .where(eq(organizations.id, organization.id));
      expect(organizationUnchanged!.owner_user_id).not.toBe(target.id);
    });

    it('rejects transfer to a user who is not an active member (404)', async () => {
      const { organization, token: ownerToken } = await createAuthorizedContext();
      const outsider = await createTestUser({ email: `outsider-${randomUUID()}@test.com` });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/tenancy/organization/transfer-ownership`),
        token: ownerToken,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { new_owner_user_id: outsider.public_id },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/v1/tenancy/organization/memberships/:membership_id', () => {
    it('refuses to remove the organization owner (403, no orphaned organization)', async () => {
      const owner = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: owner.id });
      const adminRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: MEMBERSHIP_PERMISSIONS,
      });
      const ownerMembership = await createMembership({
        userId: owner.id,
        organizationId: organization.id,
        roleId: adminRole.id,
      });
      const { token } = await generateTestTokenWithActiveSession(app, owner.public_id, {
        organizationPublicId: organization.public_id,
      });

      // Even an admin (here, the owner) cannot remove the owner's membership — ownership must be
      // transferred first, or the organization would be left without an owner.
      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/tenancy/organization/memberships/${ownerMembership.public_id}`),
        token,
        organizationPublicId: organization.public_id,
      });
      expect(response.statusCode).toBe(403);

      const [stillActive] = await getOperatorDatabase()
        .select()
        .from(memberships)
        .where(eq(memberships.id, ownerMembership.id));
      expect(stillActive!.deleted_at).toBeNull();
    });
  });

  // A PERSONAL organization is single-member by definition. The service-layer guard rejects
  // every people-sharing entry point with a 409 ConflictError. This is unit-tested in
  // membership.service.unit.test.ts; these tests prove the rejection survives over real HTTP —
  // i.e. the guard is reached (not short-circuited by a route-level 400/403) and the wire
  // payload carries the documented conflict. The owner provisioned below holds the full tenancy
  // permission set (MEMBERSHIP_MANAGE + INVITATION_MANAGE included), so the request passes RBAC
  // and lands squarely on the single-member guard rather than a 403.
  describe('PERSONAL organization single-member guard (HTTP-level coverage)', () => {
    // provisionPersonalOrganization / provisionOrganizationWithOwner insert a role_permissions
    // row per granted code (FK → permissions.code, ON DELETE RESTRICT), so every code must exist
    // before provisioning — the suite-level beforeEach only seeds the membership subset. Seed the
    // whole catalog: the owner grant spans tenancy, audit and upload.
    async function seedOwnerGrantPermissions() {
      await seedAllPermissions();
    }

    // The error handler translates `error.messageKey` via `request.t`. The standard test app does
    // not initialize i18next resources, so the wire `detail` is the raw key; but if a sibling
    // integration test initialized i18next first (same worker), it is the English string. Accept
    // either form so the assertion is robust to test-ordering — the 422 + `code: 'unprocessable_entity'`
    // are the load-bearing contract, and either detail value uniquely identifies this guard.
    function expectPersonalNoMembersUnprocessableEntity(response: {
      statusCode: number;
      json: () => unknown;
    }) {
      expect(response.statusCode).toBe(422);
      const body = response.json() as { error?: { code?: string; detail?: string } };
      expect(body.error?.code).toBe('unprocessable_entity');
      expect([
        'errors:personalOrganizationNoMembers',
        enErrors.personalOrganizationNoMembers,
      ]).toContain(body.error?.detail);
    }

    async function rolePublicId(roleInternalId: number): Promise<string> {
      const [role] = await getOperatorDatabase()
        .select()
        .from(roles)
        .where(eq(roles.id, roleInternalId))
        .limit(1);
      expect(role).toBeDefined();
      return role!.public_id;
    }

    async function setupPersonalOrganizationOwner() {
      await seedOwnerGrantPermissions();
      const owner = await createTestUser();
      const provisioned = await provisionPersonalOrganization(owner.id);
      const token = await generateTestToken({
        userId: owner.public_id,
        organizationPublicId: provisioned.organization.public_id,
      });
      return {
        owner,
        organization: provisioned.organization,
        ownerRoleId: provisioned.roleId,
        token,
      };
    }

    async function countMemberships(organizationId: number): Promise<number> {
      const [row] = await getOperatorDatabase()
        .select({ value: count() })
        .from(memberships)
        .where(
          and(eq(memberships.organization_id, organizationId), isNull(memberships.deleted_at)),
        );
      return row?.value ?? 0;
    }

    it('rejects POST /memberships on a PERSONAL organization with 422 (errors:personalOrganizationNoMembers) and creates no row', async () => {
      const { owner, organization, ownerRoleId, token } = await setupPersonalOrganizationOwner();
      // A valid body that PASSES validation and reaches the guard: an invitee email + the real owner
      // role's public id. The single-member guard runs before role resolution, so the 422 is the
      // guard, not a 400/404 over the body.
      const newMemberEmail = `personal-member-${randomUUID()}@test.com`;
      const ownerRolePublicId = await rolePublicId(ownerRoleId);

      const membershipsBefore = await countMemberships(organization.id);
      expect(membershipsBefore).toBe(1); // only the owner

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/memberships'),
        token,
        organizationPublicId: organization.public_id,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: {
          email: newMemberEmail,
          role_id: ownerRolePublicId,
        },
      });

      expectPersonalNoMembersUnprocessableEntity(response);

      // No second membership was created — the personal organization is still single-member.
      const membershipsAfter = await countMemberships(organization.id);
      expect(membershipsAfter).toBe(1);
      // Sanity: the owner provisioned with the full set is unaffected.
      expect(owner.id).toBeDefined();
    });

    it('positive contrast: the SAME POST /memberships succeeds (200) on a TEAM organization — the guard is type-specific, not a blanket block', async () => {
      await seedOwnerGrantPermissions();
      const owner = await createTestUser();
      const team = await provisionOrganizationWithOwner({
        name: 'Personal-Guard Contrast Team',
        slug: `pg-contrast-${generatePublicId('organization').slice(4, 14)}`,
        type: 'TEAM',
        ownerUserId: owner.id,
      });
      const token = await generateTestToken({
        userId: owner.public_id,
        organizationPublicId: team.organization.public_id,
      });
      const newMemberEmail = `team-member-${randomUUID()}@test.com`;
      // Reuse the owner role (full permission set) so the privilege-escalation guard also passes.
      const ownerRolePublicId = await rolePublicId(team.roleId);

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/memberships'),
        token,
        organizationPublicId: team.organization.public_id,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: {
          email: newMemberEmail,
          role_id: ownerRolePublicId,
        },
      });

      expect(response.statusCode).toBe(200);
      const membershipsAfter = await countMemberships(team.organization.id);
      expect(membershipsAfter).toBe(2); // owner + the newly-invited (INVITED) member
    });
  });
});
