import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  invalidatePermissions,
  invalidateOrganizationPermissions,
} from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import { resolveUserOrganizationPermissions } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import type { FastifyInstance } from 'fastify';

const ALL_PERMISSION_CODES = Object.values(TENANCY_PERMISSIONS) as string[];

describe('Permission System Validation', () => {
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
  });

  // ─── Case 1: DB seed — seed permissions and verify they exist ──────────

  it('should seed permission codes into the database', async () => {
    await seedPermissions(ALL_PERMISSION_CODES);

    const user = await createTestUser();
    const token = await generateTestToken({ userId: user.public_id });
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/permissions'),
      token,
    });
    expect(response.statusCode).toBe(200);

    const permissionsBody = response.json() as { data: Array<{ code: string }> };
    expect(permissionsBody.data).toBeDefined();
    expect(permissionsBody.data.length).toBeGreaterThanOrEqual(ALL_PERMISSION_CODES.length);

    const returnedCodes = permissionsBody.data.map((permission) => permission.code);
    for (const code of ALL_PERMISSION_CODES) {
      expect(returnedCodes).toContain(code);
    }
  });

  // ─── Case 2: Role assignment — assign permissions to a role ────────────

  it('should create a role and assign permissions to it', async () => {
    await seedPermissions(ALL_PERMISSION_CODES);
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const targetCodes = [
      TENANCY_PERMISSIONS.ORGANIZATION_READ,
      TENANCY_PERMISSIONS.MEMBERSHIP_READ,
    ];

    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      name: 'Viewer',
      permissionCodes: targetCodes,
    });

    expect(role).toBeDefined();
    expect(role.name).toBe('Viewer');

    // Verify via the permission resolution service
    const resolved =
      await app.tenancyDomain.authorizationService.resolveUserOrganizationPermissions(
        user.public_id,
        organization.public_id,
      );
    // User has no membership yet, so permissions should be empty
    expect(resolved).toEqual([]);

    // Now create membership and re-resolve
    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: role.id,
    });

    // Invalidate cache since we just resolved above (empty set cached)
    await invalidatePermissions(user.public_id, organization.public_id);

    const resolvedWithMembership =
      await app.tenancyDomain.authorizationService.resolveUserOrganizationPermissions(
        user.public_id,
        organization.public_id,
      );
    expect(resolvedWithMembership.sort()).toEqual(targetCodes.sort());
  });

  // ─── Case 3: 403 — user without required permission gets 403 ──────────

  it('should return 403 when user lacks required permission', async () => {
    await seedPermissions(ALL_PERMISSION_CODES);
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });

    // Create role with only ORGANIZATION_READ (not ROLE_READ)
    const readOnlyRole = await createRoleWithPermissions({
      organizationId: organization.id,
      name: 'ReadOnly',
      permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
    });

    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: readOnlyRole.id,
    });

    // Flat tenancy routes resolve the organization from the JWT `org` claim.
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });

    // Attempt to access roles endpoint (requires ROLE_READ)
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/roles'),
      token,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toBeDefined();
  });

  // ─── Case 4: 200 — user with required permission gets 200 ─────────────

  it('should return 200 when user has required permission', async () => {
    await seedPermissions(ALL_PERMISSION_CODES);
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });

    // Create role with ROLE_READ permission
    const roleReadRole = await createRoleWithPermissions({
      organizationId: organization.id,
      name: 'RoleViewer',
      permissionCodes: [TENANCY_PERMISSIONS.ROLE_READ],
    });

    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: roleReadRole.id,
    });

    // Flat tenancy routes resolve the organization from the JWT `org` claim.
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });

    // Access roles endpoint (requires ROLE_READ) — should succeed
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/roles'),
      token,
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: Record<string, unknown> }).data).toBeDefined();
  });

  // ─── Case 5: Cache invalidation — single user ─────────────────────────

  it('should invalidate cached permissions when user permissions change', async () => {
    await seedPermissions(ALL_PERMISSION_CODES);
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });

    // Create role with limited permissions
    const limitedRole = await createRoleWithPermissions({
      organizationId: organization.id,
      name: 'Limited',
      permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
    });

    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: limitedRole.id,
    });

    // First resolution — should cache
    const first = await app.tenancyDomain.authorizationService.resolveUserOrganizationPermissions(
      user.public_id,
      organization.public_id,
    );
    expect(first).toEqual([TENANCY_PERMISSIONS.ORGANIZATION_READ]);

    // Invalidate the cache
    await invalidatePermissions(user.public_id, organization.public_id);

    // Second resolution after invalidation — should hit DB again
    const second = await app.tenancyDomain.authorizationService.resolveUserOrganizationPermissions(
      user.public_id,
      organization.public_id,
    );
    expect(second).toEqual([TENANCY_PERMISSIONS.ORGANIZATION_READ]);
  });

  // ─── Case 6: Permission resolution — correct 5-table join ─────────────

  it('should correctly resolve permissions via the 5-table join', async () => {
    await seedPermissions(ALL_PERMISSION_CODES);
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });

    const fullRole = await createRoleWithPermissions({
      organizationId: organization.id,
      name: 'Admin',
      permissionCodes: ALL_PERMISSION_CODES,
    });

    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: fullRole.id,
    });

    const resolved =
      await app.tenancyDomain.authorizationService.resolveUserOrganizationPermissions(
        user.public_id,
        organization.public_id,
      );

    expect(resolved.sort()).toEqual([...ALL_PERMISSION_CODES].sort());
  });

  // ─── Case 6b: the module-level export resolves identically ────────────

  it('resolves the same set through the module-level export used by the route guard', async () => {
    // There are two entry points into permission resolution and they must not drift:
    //
    //   * `app.tenancyDomain.authorizationService.resolveUserOrganizationPermissions` — the
    //     container-wired instance, used by `auth-me-context.service` and `upload.service`.
    //   * the module-level `resolveUserOrganizationPermissions` export — used by
    //     `shared/utils/auth/authorization.util.ts`, which is what `requireOrganizationPermission`
    //     calls on *every* permission-gated request.
    //
    // The second is the hotter and more security-critical path. It was previously covered only by a
    // whole-file duplicate of this suite living in the e2e project; that file has been folded into
    // this single equivalence assertion, which is the only thing the duplicate actually proved.
    await seedPermissions(ALL_PERMISSION_CODES);
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      name: 'Admin',
      permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ, TENANCY_PERMISSIONS.MEMBERSHIP_READ],
    });
    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: role.id,
    });

    const viaContainer =
      await app.tenancyDomain.authorizationService.resolveUserOrganizationPermissions(
        user.public_id,
        organization.public_id,
      );
    const viaModuleExport = await resolveUserOrganizationPermissions(
      user.public_id,
      organization.public_id,
    );

    expect([...viaModuleExport].sort()).toEqual([...viaContainer].sort());
    expect([...viaModuleExport].sort()).toEqual(
      [TENANCY_PERMISSIONS.MEMBERSHIP_READ, TENANCY_PERMISSIONS.ORGANIZATION_READ].sort(),
    );

    // And a revocation is observed through the module export too — a stale cache on this path
    // would leave `requireOrganizationPermission` granting a permission that no longer exists.
    await invalidatePermissions(user.public_id, organization.public_id);
    const afterInvalidation = await resolveUserOrganizationPermissions(
      user.public_id,
      organization.public_id,
    );
    expect([...afterInvalidation].sort()).toEqual([...viaContainer].sort());
  });

  // ─── Case 7: Organization-level cache invalidation ─────────────────────

  it('should invalidate all cached permissions for an organization', async () => {
    await seedPermissions(ALL_PERMISSION_CODES);
    const owner = await createTestUser({ email: 'user1@test.com' });
    const member = await createTestUser({ email: 'user2@test.com' });
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      name: 'Shared',
      permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
    });

    await createMembership({
      userId: owner.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    await createMembership({
      userId: member.id,
      organizationId: organization.id,
      roleId: role.id,
    });

    // Resolve for both users — caches both
    const ownerPermissions =
      await app.tenancyDomain.authorizationService.resolveUserOrganizationPermissions(
        owner.public_id,
        organization.public_id,
      );
    const memberPermissions =
      await app.tenancyDomain.authorizationService.resolveUserOrganizationPermissions(
        member.public_id,
        organization.public_id,
      );

    expect(ownerPermissions).toEqual([TENANCY_PERMISSIONS.ORGANIZATION_READ]);
    expect(memberPermissions).toEqual([TENANCY_PERMISSIONS.ORGANIZATION_READ]);

    // Invalidate all permissions for the organization
    await invalidateOrganizationPermissions(organization.public_id);

    // Re-resolve — should hit DB again (cache cleared)
    const ownerPermissionsAfterInvalidation =
      await app.tenancyDomain.authorizationService.resolveUserOrganizationPermissions(
        owner.public_id,
        organization.public_id,
      );
    const memberPermissionsAfterInvalidation =
      await app.tenancyDomain.authorizationService.resolveUserOrganizationPermissions(
        member.public_id,
        organization.public_id,
      );

    expect(ownerPermissionsAfterInvalidation).toEqual([TENANCY_PERMISSIONS.ORGANIZATION_READ]);
    expect(memberPermissionsAfterInvalidation).toEqual([TENANCY_PERMISSIONS.ORGANIZATION_READ]);
  });
});
