import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { invalidatePermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import type { FastifyInstance } from 'fastify';

/**
 * Privilege escalation security tests — verify that members cannot grant
 * themselves elevated permissions, access resources across organizations,
 * or reach super_admin-only surfaces.
 */
describe('Security: Privilege escalation', () => {
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
    await seedPermissions(Object.values(TENANCY_PERMISSIONS));
  });

  /** Helper: create a user with the given permission codes and return token + organization. */
  async function createMemberWithPermissions(permissionCodes: string[]) {
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
    await invalidatePermissions(user.public_id, organization.public_id);
    // Flat tenancy routes resolve the organization from the JWT `org` claim; the
    // member's bearer is scoped to its own organization.
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, organization, role, token };
  }

  // POSITIVE — user with ROLE_READ can list roles
  it('should allow a member with ROLE_READ to list organization roles', async () => {
    const { token } = await createMemberWithPermissions([TENANCY_PERMISSIONS.ROLE_READ]);

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/roles'),
      token,
    });

    expect(response.statusCode).not.toBe(403);
    expect([200, 404]).toContain(response.statusCode);
  });

  // POSITIVE — user with MEMBERSHIP_READ can list memberships
  it('should allow a member with MEMBERSHIP_READ to list organization memberships', async () => {
    const { token } = await createMemberWithPermissions([TENANCY_PERMISSIONS.MEMBERSHIP_READ]);

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/memberships'),
      token,
    });

    expect(response.statusCode).not.toBe(403);
    expect([200, 404]).toContain(response.statusCode);
  });

  // NEGATIVE — member without ROLE_MANAGE cannot grant admin role to anyone
  it('should return 403 when member without ROLE_MANAGE tries to replace role permissions', async () => {
    const { token, role } = await createMemberWithPermissions([
      TENANCY_PERMISSIONS.ROLE_READ,
      // Intentionally missing ROLE_MANAGE
    ]);

    const response = await injectAuthenticated(app, {
      method: 'PUT',
      url: testApiPath(`/tenancy/organization/roles/${role.public_id}/permissions`),
      token,
      payload: { permission_codes: Object.values(TENANCY_PERMISSIONS) },
    });

    expect(response.statusCode).toBe(403);
  });

  // NEGATIVE — member without ROLE_MANAGE cannot create a role with elevated permissions
  it('should return 403 when member without ROLE_MANAGE tries to create a new role', async () => {
    const { token } = await createMemberWithPermissions([
      TENANCY_PERMISSIONS.ROLE_READ,
      // Intentionally missing ROLE_MANAGE
    ]);

    const response = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/tenancy/organization/roles'),
      token,
      payload: { name: 'Escalated role' },
    });

    expect(response.statusCode).toBe(403);
  });

  // NEGATIVE — user in organization A with valid token cannot access organization B membership list.
  // Flat routes resolve the organization from the `org` claim, so cross-tenant access is
  // expressed by scoping member A's token to organization B's claim: A has no membership
  // in B, so the permission preHandler denies it. A's privileges in A grant
  // nothing in B.
  it("should return 403 when an organization-A user claims organization-B and lists B's memberships", async () => {
    const memberA = await createMemberWithPermissions([TENANCY_PERMISSIONS.MEMBERSHIP_READ]);
    const memberB = await createMemberWithPermissions([TENANCY_PERMISSIONS.MEMBERSHIP_READ]);

    const memberATokenScopedToB = await generateTestToken({
      userId: memberA.user.public_id,
      organizationPublicId: memberB.organization.public_id,
    });

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/memberships'),
      token: memberATokenScopedToB,
    });

    expect(response.statusCode).toBe(403);
  });

  // NEGATIVE — user in organization A cannot update a role in organization B.
  // Member A holds ROLE_MANAGE in A, but a token scoped to organization B's claim grants
  // nothing in B; even addressing B's role id, the permission preHandler denies
  // before any organization-scoped lookup.
  it("should return 403 when an organization-A member claims organization-B and updates B's role", async () => {
    const memberA = await createMemberWithPermissions([TENANCY_PERMISSIONS.ROLE_MANAGE]);
    const memberB = await createMemberWithPermissions([TENANCY_PERMISSIONS.ROLE_MANAGE]);

    const memberATokenScopedToB = await generateTestToken({
      userId: memberA.user.public_id,
      organizationPublicId: memberB.organization.public_id,
    });

    const response = await injectAuthenticated(app, {
      method: 'PATCH',
      url: testApiPath(`/tenancy/organization/roles/${memberB.role.public_id}`),
      token: memberATokenScopedToB,
      payload: { name: 'Hijacked role name' },
    });

    expect(response.statusCode).toBe(403);
  });

  // NEGATIVE — authenticated user with no permission hits a permission-protected route
  it('should return 403 when member with no permissions hits a ROLE_READ-protected route', async () => {
    const { token } = await createMemberWithPermissions([
      // No permissions at all
    ]);

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/roles'),
      token,
    });

    expect(response.statusCode).toBe(403);
  });

  // NEGATIVE — member tries to update their own membership but lacks MEMBERSHIP_MANAGE
  it('should return 403 when member without MEMBERSHIP_MANAGE tries to update a membership', async () => {
    const { token, user } = await createMemberWithPermissions([
      TENANCY_PERMISSIONS.MEMBERSHIP_READ,
      // Intentionally missing MEMBERSHIP_MANAGE
    ]);

    // Fetch a real membership id from the (flat, organization-from-claim) list — the
    // paginated payload is `data: [{ id, user_id, ... }]`. Using a real row
    // makes the 403 meaningful: the request reaches the MEMBERSHIP_MANAGE
    // preHandler and is denied, rather than failing earlier on a bad id.
    const listResponse = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/memberships'),
      token,
    });
    let membershipId = 'mem_000000000000000000000';
    if (listResponse.statusCode === 200) {
      const body = listResponse.json() as { data: { id: string; user_id: string }[] };
      const own = body.data?.find((membership) => membership.user_id === user.public_id);
      if (own) membershipId = own.id;
    }

    // A valid (strict-DTO-passing) body so the request reaches the permission
    // preHandler — `status` is the only updatable field. An unknown key would
    // be rejected at validation (400) before authorization runs.
    const upgradeRoleResponse = await injectAuthenticated(app, {
      method: 'PATCH',
      url: testApiPath(`/tenancy/organization/memberships/${membershipId}`),
      token,
      payload: { status: 'SUSPENDED' },
    });

    expect(upgradeRoleResponse.statusCode).toBe(403);
  });

  // NEGATIVE — member without MEMBERSHIP_MANAGE cannot add another user as a member
  it('should return 403 when member without MEMBERSHIP_MANAGE tries to add a new member', async () => {
    const { token } = await createMemberWithPermissions([TENANCY_PERMISSIONS.MEMBERSHIP_READ]);

    const response = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/tenancy/organization/memberships'),
      token,
      headers: { 'x-idempotency-key': randomUUID() },
      // REQ-1: "Add member" is now invite-by-email. A valid body that passes the strict DTO so the
      // request reaches the MEMBERSHIP_MANAGE permission preHandler (the role/email need not exist —
      // authorization runs before any lookup).
      payload: {
        email: 'escalation-attempt@example.test',
        role_id: 'rol_000000000000000000000',
      },
    });

    expect(response.statusCode).toBe(403);
  });

  // NEGATIVE — member without ORGANIZATION_UPDATE cannot modify organization settings
  it('should return 403 when member without ORGANIZATION_UPDATE tries to update the organization', async () => {
    const { token } = await createMemberWithPermissions([
      TENANCY_PERMISSIONS.ORGANIZATION_READ,
      // Intentionally missing ORGANIZATION_UPDATE
    ]);

    const response = await injectAuthenticated(app, {
      method: 'PATCH',
      url: testApiPath('/tenancy/organization'),
      token,
      payload: { name: 'Escalated organization name' },
    });

    expect(response.statusCode).toBe(403);
  });

  // NEGATIVE — super_admin-only: regular member cannot call a super_admin API key endpoint
  it('should return 401 or 403 when regular user with no super_admin role hits admin-only endpoint', async () => {
    const { token } = await createMemberWithPermissions([TENANCY_PERMISSIONS.ORGANIZATION_READ]);

    // The /admin endpoint surface requires super_admin role in the JWT claim.
    // Try GET /api/v1/admin/users (if it exists) — expect 401/403 not 200.
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/admin/users'),
      token,
    });

    // This route may return 404 if admin routes are not mounted, 401 if no super_admin,
    // or 403 if denied — any of these is acceptable; 200 would be a security failure.
    expect(response.statusCode).not.toBe(200);
    expect([401, 403, 404]).toContain(response.statusCode);
  });
});
