import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

const TENANCY_PERMISSION_CODES = Object.values(TENANCY_PERMISSIONS);

const ME_RETRY_ATTEMPTS = 3;
const ME_RETRY_DELAY_MS = 50;

/**
 * Ensures JWT subject user row is visible before data export (parity with User domain suite).
 */
async function getAuthenticatedUserReady(
  application: FastifyInstance,
  bearerToken: string,
): Promise<void> {
  for (let attempt = 1; attempt <= ME_RETRY_ATTEMPTS; attempt++) {
    const response = await injectAuthenticated(application, {
      url: testApiPath('/users/me'),
      token: bearerToken,
    });
    if (response.statusCode === 200) return;
    if (attempt < ME_RETRY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, ME_RETRY_DELAY_MS * attempt));
    }
  }
}

describe('User Data Export Sub-Domain — Integration', () => {
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
    await seedPermissions(TENANCY_PERMISSION_CODES);
  });

  describe('POST /api/v1/users/me/data-export', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/users/me/data-export'),
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });

    it('should accept export request for authenticated user', async () => {
      const authenticatedUser = await createTestUser();
      const bearerToken = await generateTestToken({ userId: authenticatedUser.public_id });
      await getAuthenticatedUserReady(app, bearerToken);

      const organizationOwner = await createTestUser({
        email: `user-data-export-organization-owner-${authenticatedUser.public_id}@test.com`,
      });
      const organization = await createTestOrganization({ ownerUserId: organizationOwner.id });
      const membershipRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
      });
      await createMembership({
        userId: authenticatedUser.id,
        organizationId: organization.id,
        roleId: membershipRole.id,
      });

      const exportResponse = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/users/me/data-export'),
        token: bearerToken,
        payload: {},
      });
      expect(exportResponse.statusCode).toBe(200);

      const exportBody = exportResponse.json() as { data: Record<string, unknown> };
      const payload = exportBody.data;
      expect(payload).toHaveProperty('id');
      expect(payload).toHaveProperty('status', 'pending');
      expect(payload).toHaveProperty('created_at');

      const statusResponse = await injectAuthenticated(app, {
        url: testApiPath(`/users/me/data-export/${String(payload.id)}`),
        token: bearerToken,
      });
      expect(statusResponse.statusCode).toBe(200);
      const statusBody = statusResponse.json() as { data: Record<string, unknown> };
      expect(statusBody.data).toMatchObject({
        id: payload.id,
        status: 'pending',
      });
    });
  });
});
