import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp } from '@/tests/helpers/test-app.js';
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
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/**
 * Concurrent requests whose JWT `org` claims resolve different tenants must not
 * leak tenant context across the per-request RLS organization binding.
 */
describe('Security: Tenant RLS concurrency', () => {
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

  async function createMemberOrganization() {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ, TENANCY_PERMISSIONS.MEMBERSHIP_READ],
    });
    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    // Flat organization route resolves the active organization from the JWT `org` claim;
    // each tenant's bearer is pinned to its own organization so concurrent
    // requests cannot cross-bind the RLS GUC.
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { organization, token };
  }

  it('should return correct organization data under parallel mixed tenant requests', async () => {
    const tenantA = await createMemberOrganization();
    const tenantB = await createMemberOrganization();

    const responses = [];
    for (let index = 0; index < 20; index += 1) {
      const useTenantA = index % 2 === 0;
      const tenant = useTenantA ? tenantA : tenantB;
      responses.push(
        await injectAuthenticated(app, {
          method: 'GET',
          url: testApiPath('/tenancy/organization'),
          token: tenant.token,
        }),
      );
    }

    for (let index = 0; index < responses.length; index++) {
      const response = responses[index]!;
      const useTenantA = index % 2 === 0;
      const expectedPublicId = useTenantA
        ? tenantA.organization.public_id
        : tenantB.organization.public_id;

      expect(response.statusCode).toBe(200);
      const body = response.json() as { data?: { id?: string; public_id?: string } };
      const responseId = body.data?.id ?? body.data?.public_id;
      expect(responseId).toBe(expectedPublicId);
    }
  });
});
