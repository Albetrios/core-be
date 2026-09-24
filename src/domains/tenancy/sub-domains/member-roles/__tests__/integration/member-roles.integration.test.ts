import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, count, eq, isNull } from 'drizzle-orm';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectAuthenticatedOrganizationMutation,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedPermissions,
  seedAllPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import {
  provisionPersonalOrganization,
  provisionOrganizationWithOwner,
} from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { role_permissions } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.schema.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import enErrors from '@/shared/locales/en/errors.json' with { type: 'json' };
import type { FastifyInstance } from 'fastify';

const ROLE_PERMISSIONS = [
  TENANCY_PERMISSIONS.ROLE_READ,
  TENANCY_PERMISSIONS.ROLE_MANAGE,
  TENANCY_PERMISSIONS.ORGANIZATION_READ,
];

describe('Member Roles Sub-Domain — Integration', () => {
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
    await seedPermissions(ROLE_PERMISSIONS);
  });

  async function createAuthorizedContext(permissionCodes = ROLE_PERMISSIONS) {
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
    // Flat tenancy routes resolve the organization from the JWT `org` claim.
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { organization, role, token };
  }

  describe('GET /api/v1/tenancy/organization/roles', () => {
    it('should return 403 without role read permission', async () => {
      const { organization } = await createAuthorizedContext([
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
      ]);
      const user = await createTestUser({ email: 'norole@test.com' });
      const token = await generateTestToken({
        userId: user.public_id,
        organizationPublicId: organization.public_id,
      });
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization/roles'),
        token,
      });
      expect(response.statusCode).toBe(403);
    });

    it('should return roles with permission', async () => {
      const { token } = await createAuthorizedContext();
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization/roles'),
        token,
      });
      expect(response.statusCode).toBe(200);
    });

    it('includes member_count per role: Owner counted, an assigned role counted, unassigned roles 0', async () => {
      // TEAM provisioning grants tenancy + billing codes (role_permissions FK → permissions.code),
      // so the full permission catalog must exist first.
      await seedAllPermissions();
      const owner = await createTestUser();
      const team = await provisionOrganizationWithOwner({
        name: 'Member Count Team',
        slug: `mc-${generatePublicId('organization').slice(4, 14)}`,
        type: 'TEAM',
        ownerUserId: owner.id,
      });

      // Provisioning seeds: Owner (with the owner's ACTIVE membership) + Admin/Member/Viewer
      // (no members). Assign a second ACTIVE member to Admin so it also counts 1.
      const [adminRole] = await getOperatorDatabase()
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.organization_id, team.organization.id), eq(roles.name, 'Admin')));
      const member = await createTestUser();
      await createMembership({
        userId: member.id,
        organizationId: team.organization.id,
        roleId: adminRole!.id,
        status: 'ACTIVE',
      });

      const token = await generateTestToken({
        userId: owner.public_id,
        organizationPublicId: team.organization.public_id,
      });
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization/roles'),
        token,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: Array<{ name: string; member_count: number }> };
      const countByRole = new Map(body.data.map((role) => [role.name, role.member_count]));
      expect(countByRole.get('Owner')).toBe(1); // the organization owner's ACTIVE membership
      expect(countByRole.get('Admin')).toBe(1); // the member assigned above
      expect(countByRole.get('Member')).toBe(0); // unassigned system role
      expect(countByRole.get('Viewer')).toBe(0); // unassigned system role
      // Additive + always present: every role object carries a numeric member_count.
      for (const role of body.data) {
        expect(typeof role.member_count).toBe('number');
      }
    });
  });

  describe('boundary 400s — validator wired at the route (route-coverage gap-fill)', () => {
    // Observed-status capture across e2e+integration+security showed no 400 on any of these three
    // routes: every DTO rule was unit-proven, none was proven wired. One refusal each closes that.
    // POST /roles is idempotencyRequired — the organization-mutation helper supplies the key, so the 422
    // cannot fire and the refusal is the validator's own.

    it('POST /roles returns 400 when name is missing', async () => {
      const { organization, token } = await createAuthorizedContext();
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/roles'),
        token,
        organizationPublicId: organization.public_id,
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(400);
    });

    it('PATCH /roles/:role_id returns 400 for an unknown body key (strict DTO)', async () => {
      const { organization, token } = await createAuthorizedContext();
      const targetRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.ROLE_READ],
      });
      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/tenancy/organization/roles/${targetRole.public_id}`),
        token,
        payload: { unexpected_key: 'x' },
      });
      expect(response.statusCode, response.body).toBe(400);
    });

    it('PUT /roles/:role_id/permissions returns 400 when permission_codes is missing', async () => {
      const { organization, token } = await createAuthorizedContext();
      const targetRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.ROLE_READ],
      });
      const response = await injectAuthenticated(app, {
        method: 'PUT',
        url: testApiPath(`/tenancy/organization/roles/${targetRole.public_id}/permissions`),
        token,
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(400);
    });
  });

  describe('PUT /api/v1/tenancy/organization/roles/:role_id/permissions', () => {
    it('should replace role permissions', async () => {
      const { organization, token } = await createAuthorizedContext();
      const targetRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.ROLE_READ],
      });
      const response = await injectAuthenticated(app, {
        method: 'PUT',
        url: testApiPath(`/tenancy/organization/roles/${targetRole.public_id}/permissions`),
        token,
        payload: { permission_codes: [TENANCY_PERMISSIONS.ORGANIZATION_READ] },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/tenancy/organization/roles with permission_codes (atomic create + assign)', () => {
    it('creates the role and assigns its permission set in one call when the caller holds every code', async () => {
      const { organization, token } = await createAuthorizedContext();
      const roleName = `Atomic Role ${randomUUID()}`;

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/roles'),
        token,
        organizationPublicId: organization.public_id,
        payload: { name: roleName, permission_codes: [TENANCY_PERMISSIONS.ORGANIZATION_READ] },
      });

      expect(response.statusCode).toBe(200);

      const [roleRow] = await getOperatorDatabase()
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.organization_id, organization.id), eq(roles.name, roleName)));
      expect(roleRow).toBeDefined();

      const grants = await getOperatorDatabase()
        .select({ code: role_permissions.permission_code })
        .from(role_permissions)
        .where(eq(role_permissions.role_id, roleRow!.id));
      expect(grants.map((grant) => grant.code)).toEqual([TENANCY_PERMISSIONS.ORGANIZATION_READ]);
    });

    it('rejects create with a permission the caller does not hold and writes no role (atomic rollback)', async () => {
      const { organization, token } = await createAuthorizedContext();
      // A real, seeded code the caller's role does NOT include — the grant-guard must refuse it.
      await seedPermissions([TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE]);
      const roleName = `Escalation Role ${randomUUID()}`;

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/roles'),
        token,
        organizationPublicId: organization.public_id,
        payload: { name: roleName, permission_codes: [TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE] },
      });

      expect(response.statusCode).toBe(403);

      // Atomic: the whole create rolled back — no role by that name exists.
      const rows = await getOperatorDatabase()
        .select({ name: roles.name })
        .from(roles)
        .where(and(eq(roles.organization_id, organization.id), eq(roles.name, roleName)));
      expect(rows).toHaveLength(0);
    });
  });

  // A PERSONAL organization is single-member by definition, so custom roles (which exist to
  // grant scoped permissions to OTHER members) are meaningless there. The service rejects role
  // creation with a 409 ConflictError. This is unit-tested in member-role.service.unit.test.ts;
  // these tests prove the rejection survives over real HTTP — the owner holds ROLE_MANAGE (the
  // full tenancy set, via provisioning), so the request passes RBAC and lands on the no-roles
  // guard rather than a 403.
  describe('PERSONAL organization no-custom-roles guard (HTTP-level coverage)', () => {
    // provisionPersonalOrganization / provisionOrganizationWithOwner insert a role_permissions
    // row per granted code (FK → permissions.code, ON DELETE RESTRICT), so every code must exist
    // before provisioning — the suite-level beforeEach only seeds the role subset. Seed the whole
    // catalog: the owner grant spans tenancy, audit and upload.
    async function seedOwnerGrantPermissions() {
      await seedAllPermissions();
    }

    async function countRoles(organizationId: number): Promise<number> {
      const [row] = await getOperatorDatabase()
        .select({ value: count() })
        .from(roles)
        .where(and(eq(roles.organization_id, organizationId), isNull(roles.deleted_at)));
      return row?.value ?? 0;
    }

    it('rejects POST /roles on a PERSONAL organization with 422 (errors:personalOrganizationNoRoles) and creates no role', async () => {
      await seedOwnerGrantPermissions();
      const owner = await createTestUser();
      const provisioned = await provisionPersonalOrganization(owner.id);
      const token = await generateTestToken({
        userId: owner.public_id,
        organizationPublicId: provisioned.organization.public_id,
      });

      const rolesBefore = await countRoles(provisioned.organization.id);
      expect(rolesBefore).toBe(1); // only the system Owner role

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/roles'),
        token,
        organizationPublicId: provisioned.organization.public_id,
        payload: { name: `Personal Custom Role ${randomUUID()}` },
      });

      expect(response.statusCode).toBe(422);
      const body = response.json() as { error?: { code?: string; detail?: string } };
      expect(body.error?.code).toBe('unprocessable_entity');
      // The standard test app does not initialize i18next resources, so the wire `detail` is the
      // raw key; a sibling test that initialized i18next first (same worker) yields the English
      // string. Accept either — 422 + `code: 'unprocessable_entity'` + this key uniquely identify the guard.
      expect([
        'errors:personalOrganizationNoRoles',
        enErrors.personalOrganizationNoRoles,
      ]).toContain(body.error?.detail);

      // No custom role was added — only the provisioned system Owner role remains.
      const rolesAfter = await countRoles(provisioned.organization.id);
      expect(rolesAfter).toBe(1);
    });

    it('positive contrast: the SAME POST /roles succeeds (200) on a TEAM organization — the guard is type-specific, not a blanket block', async () => {
      await seedOwnerGrantPermissions();
      const owner = await createTestUser();
      const team = await provisionOrganizationWithOwner({
        name: 'Role-Guard Contrast Team',
        slug: `rg-contrast-${generatePublicId('organization').slice(4, 14)}`,
        type: 'TEAM',
        ownerUserId: owner.id,
      });
      const token = await generateTestToken({
        userId: owner.public_id,
        organizationPublicId: team.organization.public_id,
      });

      const rolesBefore = await countRoles(team.organization.id);

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/roles'),
        token,
        organizationPublicId: team.organization.public_id,
        payload: { name: `Team Custom Role ${randomUUID()}` },
      });

      expect(response.statusCode).toBe(200);
      const rolesAfter = await countRoles(team.organization.id);
      expect(rolesAfter).toBe(rolesBefore + 1);
    });
  });
});
