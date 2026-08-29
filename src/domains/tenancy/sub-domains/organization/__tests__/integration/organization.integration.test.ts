import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

const ORGANIZATION_PERMISSIONS = [
  TENANCY_PERMISSIONS.ORGANIZATION_READ,
  TENANCY_PERMISSIONS.ORGANIZATION_UPDATE,
];

describe('Organization Sub-Domain — Integration', () => {
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
    await seedPermissions(ORGANIZATION_PERMISSIONS);
  });

  async function createAuthorizedContext(permissionCodes = ORGANIZATION_PERMISSIONS) {
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
    return { organization, token };
  }

  describe('GET /api/v1/tenancy/organizations', () => {
    it('returns 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organizations'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 200 for authenticated user', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organizations'),
        token,
      });
      expect(response.statusCode).toBe(200);
    });

    it('discovers both owned and member organizations (owner branch + membership subquery)', async () => {
      const user = await createTestUser();
      // Org A: the user is the owner (found via the owner_user_id branch).
      const ownedOrg = await createTestOrganization({ ownerUserId: user.id });
      // Org B: owned by someone else; the user is an ACTIVE non-owner member (found via the
      // membership subquery branch — the path rewritten for the keyset-index Perf fix).
      const otherOwner = await createTestUser();
      const memberOrg = await createTestOrganization({ ownerUserId: otherOwner.id });
      const memberRole = await createRoleWithPermissions({
        organizationId: memberOrg.id,
        permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
      });
      await createMembership({
        userId: user.id,
        organizationId: memberOrg.id,
        roleId: memberRole.id,
      });

      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organizations'),
        token,
      });

      expect(response.statusCode).toBe(200);
      const ids = (response.json() as { data: { id: string }[] }).data.map(
        (organization) => organization.id,
      );
      expect(ids).toContain(ownedOrg.public_id);
      expect(ids).toContain(memberOrg.public_id);
    });
  });

  describe('PATCH /api/v1/tenancy/organization', () => {
    it('returns 403 without organization update permission', async () => {
      const { organization } = await createAuthorizedContext([
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
      ]);
      const user = await createTestUser({ email: 'no-update@test.com' });
      const token = await generateTestToken({
        userId: user.public_id,
        organizationPublicId: organization.public_id,
      });
      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath('/tenancy/organization'),
        token,
        payload: { name: 'Renamed' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 400 or 422 for invalid body', async () => {
      const { token } = await createAuthorizedContext();
      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath('/tenancy/organization'),
        token,
        payload: { unknown_field: true },
      });
      expect(response.statusCode).toBe(400);
    });

    it('concurrent slug updates to the same new slug resolve to one 200 + one 409 (no 5xx)', async () => {
      // One admin who owns two organizations races both to the SAME previously-unused slug.
      // With flat routes each request targets the active organization carried in its token
      // claim, so we mint a per-organization token for the same user. Both requests pass the
      // findBySlug pre-check (neither organization holds it yet), so the loser hits the
      // idx_organizations_slug unique index — which must map to 409, never a 500.
      const user = await createTestUser();
      const [organizationA, organizationB] = await Promise.all([
        createTestOrganization({ ownerUserId: user.id }),
        createTestOrganization({ ownerUserId: user.id }),
      ]);
      const [roleA, roleB] = await Promise.all([
        createRoleWithPermissions({
          organizationId: organizationA.id,
          permissionCodes: ORGANIZATION_PERMISSIONS,
        }),
        createRoleWithPermissions({
          organizationId: organizationB.id,
          permissionCodes: ORGANIZATION_PERMISSIONS,
        }),
      ]);
      await Promise.all([
        createMembership({ userId: user.id, organizationId: organizationA.id, roleId: roleA.id }),
        createMembership({ userId: user.id, organizationId: organizationB.id, roleId: roleB.id }),
      ]);
      const [tokenA, tokenB] = await Promise.all([
        generateTestToken({
          userId: user.public_id,
          organizationPublicId: organizationA.public_id,
        }),
        generateTestToken({
          userId: user.public_id,
          organizationPublicId: organizationB.public_id,
        }),
      ]);

      const sharedSlug = 'race-shared-organization-slug';
      const patchSlug = (token: string) =>
        injectAuthenticated(app, {
          method: 'PATCH',
          url: testApiPath('/tenancy/organization'),
          token,
          payload: { slug: sharedSlug },
        });

      const statuses = (await Promise.all([patchSlug(tokenA), patchSlug(tokenB)])).map(
        (response) => response.statusCode,
      );

      expect(statuses.filter((status) => status >= 500)).toHaveLength(0);
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(1);
    });
  });
});
