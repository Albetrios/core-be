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
import { createTestNotification } from '@/tests/factories/notification.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

const PERMISSIONS = ['notify:read'];

describe('Notification Sub-Domain — Integration', () => {
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
    await seedPermissions(PERMISSIONS);
  });

  async function createAuthorizedContext() {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: PERMISSIONS,
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
    return { user, organization, token };
  }

  it('returns 401 without authentication', async () => {
    const response = await injectUnauthenticated(app, {
      method: 'GET',
      url: testApiPath('/notify/notifications'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 200 for authorized notification list', async () => {
    const { organization, token } = await createAuthorizedContext();
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/notify/notifications'),
      token,
      organizationPublicId: organization.public_id,
    });
    expect(response.statusCode).toBe(200);
  });

  /**
   * `POST /notify/notifications/mark-all-read` was the worst-covered route in the domain: it
   * declares 200, and the only HTTP case anywhere was a 401. The `updated_count` payload was
   * proven in the controller unit and again in the repository DB unit — but nothing proved the
   * route wiring between the two, which is exactly where a status-policy or serializer
   * regression would land.
   */
  describe('POST /api/v1/notify/notifications/mark-all-read', () => {
    it('returns 200 with updated_count matching the rows marked', async () => {
      const { user, organization, token } = await createAuthorizedContext();
      for (let index = 0; index < 3; index += 1) {
        await createTestNotification({
          userId: user.id,
          organizationId: organization.id,
          title: `Unread ${String(index)}`,
        });
      }

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/notify/notifications/mark-all-read'),
        token,
        organizationPublicId: organization.public_id,
      });

      // 200 is the method→status policy for POST, enforced by the middleware rewrite — this is
      // the only place it is observed for this route.
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { data?: { updated_count?: number } };
      expect(body.data?.updated_count).toBe(3);
    });

    it('returns 200 with updated_count 0 when nothing is unread', async () => {
      const { organization, token } = await createAuthorizedContext();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/notify/notifications/mark-all-read'),
        token,
        organizationPublicId: organization.public_id,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { data?: { updated_count?: number } };
      expect(body.data?.updated_count).toBe(0);
    });

    it('counts only the caller-owned notifications', async () => {
      // markAllReadForUser is user-scoped. A count that leaked another user's rows would be a
      // cross-tenant read surfacing as a number.
      const { user, organization, token } = await createAuthorizedContext();
      const otherUser = await createTestUser({ email: `other-${Date.now()}@test.com` });
      await createTestNotification({ userId: user.id, organizationId: organization.id });
      await createTestNotification({ userId: otherUser.id, organizationId: organization.id });
      await createTestNotification({ userId: otherUser.id, organizationId: organization.id });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/notify/notifications/mark-all-read'),
        token,
        organizationPublicId: organization.public_id,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { data?: { updated_count?: number } };
      expect(body.data?.updated_count).toBe(1);
    });

    it('is effectively idempotent — a second call reports nothing left to mark', async () => {
      const { user, organization, token } = await createAuthorizedContext();
      await createTestNotification({ userId: user.id, organizationId: organization.id });

      const first = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/notify/notifications/mark-all-read'),
        token,
        organizationPublicId: organization.public_id,
      });
      const second = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/notify/notifications/mark-all-read'),
        token,
        organizationPublicId: organization.public_id,
      });

      expect((first.json() as { data?: { updated_count?: number } }).data?.updated_count).toBe(1);
      expect((second.json() as { data?: { updated_count?: number } }).data?.updated_count).toBe(0);
    });

    it('returns 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/notify/notifications/mark-all-read'),
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
