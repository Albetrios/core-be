import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectAuthenticatedOrganizationMutation,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

vi.mock('@/shared/utils/security/webhook-outbound-fetch.util.js', () => ({
  createPinnedWebhookFetch: vi.fn(async () => {
    return async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
  }),
}));

const NOTIFY_PERMISSIONS = {
  WEBHOOK_READ: 'webhook:read',
  WEBHOOK_MANAGE: 'webhook:manage',
} as const;

const ALL_NOTIFY_PERMISSIONS = Object.values(NOTIFY_PERMISSIONS);
const mockedLookup = vi.mocked(lookup);

function mockWebhookDnsLookup(): void {
  mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<
    ReturnType<typeof lookup>
  >);
}

describe('Notify Domain — Integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    mockedLookup.mockReset();
    mockWebhookDnsLookup();
    await cleanupDatabase();
    await seedPermissions(ALL_NOTIFY_PERMISSIONS);
  });

  async function createAuthorizedNotifyContext(permissionCodes = ALL_NOTIFY_PERMISSIONS) {
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
    // Flat webhook routes resolve the organization from the JWT `org` claim, so
    // the bearer must embed `organizationPublicId` to reach (and pass) the
    // webhook permission preHandler and the org-scoped controller.
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, organization, role, token };
  }

  // ─── Notifications ────────────────────────────────────────────

  describe('GET /api/v1/notify/notifications', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        url: testApiPath('/notify/notifications'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return notifications for authenticated user', async () => {
      // Personal/team-organization invariant: every real bearer carries an `org`
      // claim, and the principal scope minter rejects org-less (stale) tokens.
      const { user, token } = await createAuthorizedNotifyContext();
      void user;
      const response = await injectAuthenticated(app, {
        url: testApiPath('/notify/notifications'),
        token,
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/notify/notifications/:id', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        url: testApiPath('/notify/notifications/test-id'),
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('PATCH /api/v1/notify/notifications/:id/read', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'PATCH',
        url: testApiPath('/notify/notifications/test-id/read'),
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/notify/notifications/mark-all-read', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/notify/notifications/mark-all-read'),
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/notify/notifications/unread-count', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        url: testApiPath('/notify/notifications/unread-count'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return unread count for authenticated user', async () => {
      const { token } = await createAuthorizedNotifyContext();
      const response = await injectAuthenticated(app, {
        url: testApiPath('/notify/notifications/unread-count'),
        token,
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('DELETE /api/v1/notify/notifications/:notification_id', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'DELETE',
        url: testApiPath('/notify/notifications/test-id'),
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ─── Webhooks ─────────────────────────────────────────────────

  describe('GET /api/v1/notify/webhooks', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        url: testApiPath('/notify/webhooks'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return 403 without webhook read permission', async () => {
      const { organization } = await createAuthorizedNotifyContext();
      const user = await createTestUser({ email: 'noperm@test.com' });
      // Scope the bearer to the org via the `org` claim so the request reaches
      // the webhook permission check; the user has no membership → 403.
      const token = await generateTestToken({
        userId: user.public_id,
        organizationPublicId: organization.public_id,
      });
      const response = await injectAuthenticated(app, {
        url: testApiPath('/notify/webhooks'),
        token,
      });
      expect(response.statusCode).toBe(403);
    });

    it('should return webhooks with permission', async () => {
      const { token } = await createAuthorizedNotifyContext();
      const response = await injectAuthenticated(app, {
        url: testApiPath('/notify/webhooks'),
        token,
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/notify/webhooks', () => {
    it('should return 403 without manage permission', async () => {
      const { organization } = await createAuthorizedNotifyContext([
        NOTIFY_PERMISSIONS.WEBHOOK_READ,
      ]);
      const user = await createTestUser({ email: 'readonly@test.com' });
      const readRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [NOTIFY_PERMISSIONS.WEBHOOK_READ],
      });
      await createMembership({
        userId: user.id,
        organizationId: organization.id,
        roleId: readRole.id,
      });
      const token = await generateTestToken({
        userId: user.public_id,
        organizationPublicId: organization.public_id,
      });
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/notify/webhooks'),
        token,
        // Valid body so request passes schema validation and reaches the permission preHandler (403),
        // and a key so it clears the idempotencyRequired onRequest gate first.
        payload: { url: 'https://example.com/hook', events: ['notification.created'] },
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  // ─── Webhook Test Delivery ──────────────────────────────────

  describe('POST /api/v1/notify/webhooks/:webhook_id/test', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/notify/webhooks/some-webhook-id/test'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return 403 without webhook:manage permission', async () => {
      const { organization, user } = await createAuthorizedNotifyContext();
      // Create a second user with only READ permission
      const readUser = await createTestUser({ email: 'readonlywebhook@test.com' });
      const readRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [NOTIFY_PERMISSIONS.WEBHOOK_READ],
      });
      await createMembership({
        userId: readUser.id,
        organizationId: organization.id,
        roleId: readRole.id,
      });
      const readToken = await generateTestToken({
        userId: readUser.public_id,
        organizationPublicId: organization.public_id,
      });

      const webhook = await createTestWebhook({
        organizationId: organization.id,
        createdByUserId: user.id,
      });

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/notify/webhooks/${webhook.public_id}/test`),
        token: readToken,
      });
      expect(response.statusCode).toBe(403);
    });

    it('should send test delivery and return result with manage permission', {
      timeout: 15_000,
    }, async () => {
      const { organization, user, token } = await createAuthorizedNotifyContext();
      const webhook = await createTestWebhook({
        organizationId: organization.id,
        url: 'https://httpbin.org/post',
        createdByUserId: user.id,
      });

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath(`/notify/webhooks/${webhook.public_id}/test`),
        token,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: { success: boolean; delivered_at: string };
      };
      expect(body.data).toHaveProperty('success');
      expect(body.data).toHaveProperty('delivered_at');
      expect(typeof body.data.success).toBe('boolean');
    });

    it('should return 404 for non-existent webhook', async () => {
      const { token } = await createAuthorizedNotifyContext();
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/notify/webhooks/whk_wwwwwwwwwwwwwwwwwwwww/test'),
        token,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  // ─── Webhook Events ───────────────────────────────────────────

  describe('GET /api/v1/notify/webhook-events', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        url: testApiPath('/notify/webhook-events'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return webhook events with permission', async () => {
      const { token } = await createAuthorizedNotifyContext();
      const response = await injectAuthenticated(app, {
        url: testApiPath('/notify/webhook-events'),
        token,
      });
      expect(response.statusCode).toBe(200);
    });
  });
});
