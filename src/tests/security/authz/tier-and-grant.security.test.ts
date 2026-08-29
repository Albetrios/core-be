import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { database } from '@/infrastructure/database/connection.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';

/**
 * Privilege-boundary attack matrix — models `tier:owner` and `grant` in
 * route-authorization-model.json. Owner-only organization operations (transfer
 * ownership, leave) reject non-owners / block the owner, permission-gated
 * membership management rejects members lacking `membership:manage`, and
 * role-permission grants cannot be used to escalate: a member may only grant
 * permissions they themselves hold, and never reach across organizations.
 * e2e — runs in CI (Postgres + Redis required).
 */
describe('Security: privilege-boundary matrix (tier:owner + grant)', () => {
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

  const OWNER_PERMISSION_CODES = [
    TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE,
    TENANCY_PERMISSIONS.ROLE_MANAGE,
    TENANCY_PERMISSIONS.ROLE_READ,
    TENANCY_PERMISSIONS.MEMBERSHIP_READ,
    TENANCY_PERMISSIONS.ORGANIZATION_READ,
  ];

  // Builds a fully-provisioned organization: an owner (owner_user_id + a broad-permission
  // membership) and one non-owner member whose role carries exactly
  // `memberPermissionCodes`. Tokens carry the organization via the JWT claim, which is how
  // flat tenancy routes resolve the active organization.
  async function setupOrgWithMember(memberPermissionCodes: string[]) {
    await seedPermissions(Object.values(TENANCY_PERMISSIONS));
    const owner = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const ownerRole = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: OWNER_PERMISSION_CODES,
      createdByUserId: owner.id,
    });
    const ownerMembership = await createMembership({
      userId: owner.id,
      organizationId: organization.id,
      roleId: ownerRole.id,
    });
    const memberRole = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: memberPermissionCodes,
      createdByUserId: owner.id,
    });
    const membership = await createMembership({
      userId: member.id,
      organizationId: organization.id,
      roleId: memberRole.id,
    });
    const ownerToken = await generateTestToken({
      userId: owner.public_id,
      organizationPublicId: organization.public_id,
    });
    const memberToken = await generateTestToken({
      userId: member.public_id,
      organizationPublicId: organization.public_id,
    });
    return {
      owner,
      member,
      organization,
      ownerRole,
      memberRole,
      membership,
      ownerMembership,
      ownerToken,
      memberToken,
    };
  }

  describe('model: tier:owner — owner-only organization operations', () => {
    it('non-owner member POST transfer-ownership → 403 and ownership unchanged', async () => {
      // A member with even the highest organization permission is still not the owner.
      const { owner, member, organization, memberToken } = await setupOrgWithMember([
        TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE,
      ]);
      const res = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/transfer-ownership'),
        token: memberToken,
        // transfer-ownership is an idempotency-required write; supply the key so the
        // request reaches the owner-only authorization check rather than the 422 gate.
        extraHeaders: { 'x-idempotency-key': randomUUID() },
        payload: { new_owner_user_id: member.public_id },
      });
      expect(res.statusCode).toBe(403);
      const [organizationRow] = await database
        .select()
        .from(organizations)
        .where(eq(organizations.id, organization.id));
      expect(organizationRow?.owner_user_id).toBe(owner.id);
    });

    it('owner POST leave → 403 (owner cannot abandon the organization)', async () => {
      const { ownerToken } = await setupOrgWithMember([]);
      const res = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/leave'),
        token: ownerToken,
      });
      expect(res.statusCode).toBe(403);
    });

    it('baseline: non-owner member POST leave → 200 (allowed)', async () => {
      const { memberToken } = await setupOrgWithMember([]);
      const res = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/leave'),
        token: memberToken,
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('model: organization permission gate — membership management (BFLA)', () => {
    it('member without membership:manage PATCH a membership → 403', async () => {
      const { membership, memberToken } = await setupOrgWithMember([
        TENANCY_PERMISSIONS.MEMBERSHIP_READ,
      ]);
      const res = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/tenancy/organization/memberships/${membership.public_id}`),
        token: memberToken,
        payload: { status: 'SUSPENDED' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('member without membership:manage DELETE a membership → 403', async () => {
      const { membership, memberToken } = await setupOrgWithMember([
        TENANCY_PERMISSIONS.MEMBERSHIP_READ,
      ]);
      const res = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/tenancy/organization/memberships/${membership.public_id}`),
        token: memberToken,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('model: grant — role-permission escalation (privilege boundary)', () => {
    it('member without role:manage PUT role permissions → 403', async () => {
      const { memberRole, memberToken } = await setupOrgWithMember([TENANCY_PERMISSIONS.ROLE_READ]);
      const res = await injectAuthenticated(app, {
        method: 'PUT',
        url: testApiPath(`/tenancy/organization/roles/${memberRole.public_id}/permissions`),
        token: memberToken,
        payload: { permission_codes: [TENANCY_PERMISSIONS.ROLE_READ] },
      });
      expect(res.statusCode).toBe(403);
    });

    it('member with role:manage cannot grant a permission they do not hold → 403 (no escalation)', async () => {
      // Holds role:manage (passes the route guard) but NOT membership:manage.
      const { organization, member, memberToken } = await setupOrgWithMember([
        TENANCY_PERMISSIONS.ROLE_MANAGE,
      ]);
      const targetRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [],
        createdByUserId: member.id,
      });
      const res = await injectAuthenticated(app, {
        method: 'PUT',
        url: testApiPath(`/tenancy/organization/roles/${targetRole.public_id}/permissions`),
        token: memberToken,
        payload: { permission_codes: [TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE] },
      });
      expect(res.statusCode).toBe(403);
    });

    it('baseline: member with role:manage grants a permission they hold → 200', async () => {
      const { organization, member, memberToken } = await setupOrgWithMember([
        TENANCY_PERMISSIONS.ROLE_MANAGE,
        TENANCY_PERMISSIONS.ROLE_READ,
      ]);
      const targetRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [],
        createdByUserId: member.id,
      });
      const res = await injectAuthenticated(app, {
        method: 'PUT',
        url: testApiPath(`/tenancy/organization/roles/${targetRole.public_id}/permissions`),
        token: memberToken,
        payload: { permission_codes: [TENANCY_PERMISSIONS.ROLE_READ] },
      });
      expect(res.statusCode).toBe(200);
    });

    it('member of organization A PUT organization B role permissions → 404 (cross-organization isolation)', async () => {
      const organizationA = await setupOrgWithMember([TENANCY_PERMISSIONS.ROLE_MANAGE]);
      const organizationB = await setupOrgWithMember([TENANCY_PERMISSIONS.ROLE_MANAGE]);
      const res = await injectAuthenticated(app, {
        method: 'PUT',
        url: testApiPath(
          `/tenancy/organization/roles/${organizationB.memberRole.public_id}/permissions`,
        ),
        token: organizationA.memberToken,
        payload: { permission_codes: [] },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('model: tier:owner — the owner membership is protected (lock-out prevention)', () => {
    it("member with membership:manage PATCH the owner's membership → 403", async () => {
      // Even a full membership:manage grant must not let a member suspend the
      // owner (which would strip the organization of its only owner). The scoped lookup
      // succeeds, then the owner-guard rejects: `errors:ownerMembershipCannotBeModified`.
      const { ownerMembership, memberToken } = await setupOrgWithMember([
        TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE,
      ]);
      const res = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/tenancy/organization/memberships/${ownerMembership.public_id}`),
        token: memberToken,
        payload: { status: 'SUSPENDED' },
      });
      expect(res.statusCode).toBe(403);
    });

    it("member with membership:manage DELETE the owner's membership → 403", async () => {
      // Removing the owner is likewise blocked (`errors:ownerCannotBeRemoved`):
      // ownership must be transferred first, never deleted out from under the organization.
      const { ownerMembership, memberToken } = await setupOrgWithMember([
        TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE,
      ]);
      const res = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/tenancy/organization/memberships/${ownerMembership.public_id}`),
        token: memberToken,
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
