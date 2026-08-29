import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
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
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { FastifyInstance } from 'fastify';

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
      method: 'GET',
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

      const payload = (exportResponse.json() as { data: Record<string, unknown> }).data;
      expect(payload).toMatchObject({
        status: 'pending',
      });
      expect(payload).toHaveProperty('export_id');
    });

    /**
     * `auth.user_data_exports` carries the partial unique index
     * `idx_user_data_exports_user_pending` — at most one pending export per user. The service
     * treats a repeat request as idempotent: it returns the in-flight export rather than
     * erroring, and catches the unique violation on the concurrent path
     * (`user-data-export.concurrent_pending_returned`). Neither branch had a test, so a
     * regression would surface to a double-clicking user as a 500.
     */
    it('returns the in-flight export instead of creating a second one', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      await getAuthenticatedUserReady(app, token);

      const first = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/users/me/data-export'),
        token,
        payload: {},
      });
      expect(first.statusCode, first.body).toBe(200);
      const firstId = (first.json() as { data: { export_id: string } }).data.export_id;

      const second = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/users/me/data-export'),
        token,
        payload: {},
      });
      expect(second.statusCode, second.body).toBe(200);
      expect((second.json() as { data: { export_id: string } }).data.export_id).toBe(firstId);
    });

    it('survives concurrent export requests without a unique-violation 500', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      await getAuthenticatedUserReady(app, token);

      // Fired together so both can pass the pending-check before either insert lands — the
      // race the service's isPostgresUniqueViolation branch exists to absorb.
      const responses = await Promise.all(
        [0, 1].map(() =>
          injectAuthenticated(app, {
            method: 'POST',
            url: testApiPath('/users/me/data-export'),
            token,
            payload: {},
          }),
        ),
      );

      for (const response of responses) {
        expect(response.statusCode, response.body).toBe(200);
      }
      const [a, b] = responses.map(
        (response) => (response.json() as { data: { export_id: string } }).data.export_id,
      );
      expect(a).toBe(b);
    });
  });

  describe('GET /api/v1/users/me/data-export/:data_export_id', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath(`/users/me/data-export/${generatePublicId('userDataExport')}`),
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return 404 for an unknown export id', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      await getAuthenticatedUserReady(app, token);

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/users/me/data-export/${generatePublicId('userDataExport')}`),
        token,
      });
      expect(response.statusCode, response.body).toBe(404);
    });

    // The ownership property that actually matters: the repository scopes every read by
    // (public_id, user_id), so a real, valid export id belonging to somebody else must read as
    // absent rather than leaking another user's export status or download URL.
    it('should return 404 for an export id owned by a different user', async () => {
      const owner = await createTestUser();
      const ownerToken = await generateTestToken({ userId: owner.public_id });
      await getAuthenticatedUserReady(app, ownerToken);

      const created = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/users/me/data-export'),
        token: ownerToken,
        payload: {},
      });
      expect(created.statusCode, created.body).toBe(200);
      const exportId = (created.json() as { data: { export_id: string } }).data.export_id;

      const stranger = await createTestUser({ email: `stranger-${owner.public_id}@test.com` });
      const strangerToken = await generateTestToken({ userId: stranger.public_id });
      await getAuthenticatedUserReady(app, strangerToken);

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/users/me/data-export/${exportId}`),
        token: strangerToken,
      });
      expect(response.statusCode, response.body).toBe(404);
    });
  });
});
