import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import type { FastifyInstance } from 'fastify';
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
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';

describe('Pagination caps — integration', () => {
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
    await seedPermissions([TENANCY_PERMISSIONS.MEMBERSHIP_READ]);
  });

  it('GET /notifications rejects limit above 100', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/notify/notifications'),
      token,
      query: { limit: '101' },
    });
    expect(response.statusCode).toBe(400);
  });

  // The admin invitations list route was removed in REQ-1 (adding a member now issues the invitation
  // via POST /organization/memberships). Retargeted to the remaining organization-scoped cursor-paginated list
  // route so the organization-scoped pagination cap stays covered.
  it('GET /organization/memberships rejects limit above 100', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [TENANCY_PERMISSIONS.MEMBERSHIP_READ],
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
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/memberships'),
      token,
      organizationPublicId: organization.public_id,
      query: { limit: '101' },
    });
    expect(response.statusCode).toBe(400);
  });
});
