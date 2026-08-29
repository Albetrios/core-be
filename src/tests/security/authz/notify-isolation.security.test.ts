import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { database } from '@/infrastructure/database/connection.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';
import { createTestNotification } from '@/tests/factories/notification.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { NOTIFY_PERMISSIONS } from '@/domains/notify/notify.permissions.js';
import { notifications } from '@/domains/notify/sub-domains/notification/notification.schema.js';
import { webhooks } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

const WEBHOOK_PERMISSIONS = [NOTIFY_PERMISSIONS.WEBHOOK_READ, NOTIFY_PERMISSIONS.WEBHOOK_MANAGE];

/**
 * Notify had exactly one domain-owned security file (`webhook-ssrf.security`). All of its
 * cross-tenant and object-ownership coverage lived inside three *multi-domain* platform suites
 * (`object-ownership`, `cross-organization-resource`, `cross-organization-mutation`) as parameterized rows in
 * shared matrices.
 *
 * That works only while someone remembers to add a row. A new notify route, or a resolver that
 * stops scoping by organization, is caught by nothing that a notify-domain change would run —
 * `VITEST_DOMAIN_FILTER=notify` never touches those files.
 *
 * This file gives notify its own isolation guard. The invariant throughout: a cross-boundary
 * reference is **404, never 403** — a 403 confirms the row exists and turns the endpoint into an
 * existence oracle.
 */
describe('Security: notify tenant and owner isolation', () => {
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
    await seedPermissions(WEBHOOK_PERMISSIONS);
  });

  /** A fully permissioned member of a brand-new organization. */
  async function createOrganizationContext(emailSeed: string) {
    const user = await createTestUser({ email: `${emailSeed}-${Date.now()}@test.com` });
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: WEBHOOK_PERMISSIONS,
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

  describe('webhooks are scoped to the active organization', () => {
    it('a webhook owned by another organization reads as 404, not 403', async () => {
      const victim = await createOrganizationContext('victim');
      const attacker = await createOrganizationContext('attacker');
      const victimWebhook = await createTestWebhook({
        organizationId: victim.organization.id,
        url: 'https://example.com/victim-webhook',
        createdByUserId: victim.user.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/notify/webhooks/${victimWebhook.public_id}`),
        token: attacker.token,
      });

      // 403 would confirm the id exists. 404 is the only answer that leaks nothing.
      expect(response.statusCode, response.body).toBe(404);
    });

    it("another organization's webhook cannot be updated, and the row is unchanged", async () => {
      const victim = await createOrganizationContext('victim-patch');
      const attacker = await createOrganizationContext('attacker-patch');
      const victimWebhook = await createTestWebhook({
        organizationId: victim.organization.id,
        url: 'https://example.com/victim-patch-target',
        createdByUserId: victim.user.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/notify/webhooks/${victimWebhook.public_id}`),
        token: attacker.token,
        // Deliberately a resolvable public host: the SSRF guard validates the URL *before* the
        // row is looked up, so an unresolvable attacker domain would short-circuit to 400 and
        // this case would never reach the ownership check it exists to prove.
        payload: { url: 'https://example.com/exfiltrate' },
      });

      expect(response.statusCode, response.body).toBe(404);

      // The real damage from a cross-tenant PATCH is a redirected delivery URL, so assert the
      // stored row rather than trusting the status alone.
      const [stored] = await database
        .select({ url: webhooks.url })
        .from(webhooks)
        .where(eq(webhooks.id, victimWebhook.id));
      expect(stored?.url).toBe('https://example.com/victim-patch-target');
    });

    it("another organization's webhook cannot be deleted", async () => {
      const victim = await createOrganizationContext('victim-delete');
      const attacker = await createOrganizationContext('attacker-delete');
      const victimWebhook = await createTestWebhook({
        organizationId: victim.organization.id,
        url: 'https://example.com/victim-delete-target',
        createdByUserId: victim.user.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/notify/webhooks/${victimWebhook.public_id}`),
        token: attacker.token,
      });

      expect(response.statusCode, response.body).toBe(404);

      const [stored] = await database
        .select({ deleted_at: webhooks.deleted_at })
        .from(webhooks)
        .where(eq(webhooks.id, victimWebhook.id));
      expect(stored?.deleted_at).toBeNull();
    });

    it("another organization's delivery attempts are not listable", async () => {
      const victim = await createOrganizationContext('victim-attempts');
      const attacker = await createOrganizationContext('attacker-attempts');
      const victimWebhook = await createTestWebhook({
        organizationId: victim.organization.id,
        url: 'https://example.com/victim-attempts',
        createdByUserId: victim.user.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/notify/webhooks/${victimWebhook.public_id}/delivery-attempts`),
        token: attacker.token,
      });

      expect(response.statusCode, response.body).toBe(404);
    });

    it("another organization's webhook cannot be driven to send a test delivery", async () => {
      // The test-send route makes an outbound HTTP request. Cross-tenant access here would let an
      // attacker use a victim's endpoint (and their signing secret) as a traffic source.
      const victim = await createOrganizationContext('victim-test-send');
      const attacker = await createOrganizationContext('attacker-test-send');
      const victimWebhook = await createTestWebhook({
        organizationId: victim.organization.id,
        url: 'https://example.com/victim-test-send',
        createdByUserId: victim.user.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/notify/webhooks/${victimWebhook.public_id}/test`),
        token: attacker.token,
      });

      expect(response.statusCode, response.body).toBe(404);
    });

    it('the webhook list never contains another organization rows', async () => {
      const victim = await createOrganizationContext('victim-list');
      const attacker = await createOrganizationContext('attacker-list');
      await createTestWebhook({
        organizationId: victim.organization.id,
        url: 'https://example.com/victim-list-row',
        createdByUserId: victim.user.id,
      });
      const attackerWebhook = await createTestWebhook({
        organizationId: attacker.organization.id,
        url: 'https://example.com/attacker-list-row',
        createdByUserId: attacker.user.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/notify/webhooks'),
        token: attacker.token,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { data?: Array<{ id?: string; url?: string }> };
      expect(body.data?.map((row) => row.id)).toEqual([attackerWebhook.public_id]);
      expect(response.body).not.toContain('victim-list-row');
    });
  });

  describe('notifications are scoped to the owning user', () => {
    it("another user's notification reads as 404", async () => {
      const victim = await createOrganizationContext('victim-notification');
      const attacker = await createOrganizationContext('attacker-notification');
      const victimNotification = await createTestNotification({
        userId: victim.user.id,
        organizationId: victim.organization.id,
        title: 'victim-only',
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/notify/notifications/${victimNotification.public_id}`),
        token: attacker.token,
      });

      expect(response.statusCode, response.body).toBe(404);
      expect(response.body).not.toContain('victim-only');
    });

    it("another user's notification cannot be marked read, and read_at stays null", async () => {
      const victim = await createOrganizationContext('victim-mark-read');
      const attacker = await createOrganizationContext('attacker-mark-read');
      const victimNotification = await createTestNotification({
        userId: victim.user.id,
        organizationId: victim.organization.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/notify/notifications/${victimNotification.public_id}/read`),
        token: attacker.token,
      });

      expect(response.statusCode, response.body).toBe(404);

      const [stored] = await database
        .select({ read_at: notifications.read_at })
        .from(notifications)
        .where(eq(notifications.id, victimNotification.id));
      expect(stored?.read_at).toBeNull();
    });

    it("another user's notification cannot be deleted, and the row survives", async () => {
      const victim = await createOrganizationContext('victim-delete-notification');
      const attacker = await createOrganizationContext('attacker-delete-notification');
      const victimNotification = await createTestNotification({
        userId: victim.user.id,
        organizationId: victim.organization.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/notify/notifications/${victimNotification.public_id}`),
        token: attacker.token,
      });

      expect(response.statusCode, response.body).toBe(404);

      const surviving = await database
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.id, victimNotification.id));
      expect(surviving).toHaveLength(1);
    });

    it("mark-all-read never touches another user's rows", async () => {
      // markAllReadForUser is a bulk UPDATE — the highest-blast-radius notification write, and
      // the one where a dropped user predicate would be least visible.
      const victim = await createOrganizationContext('victim-mark-all');
      const attacker = await createOrganizationContext('attacker-mark-all');
      const victimNotification = await createTestNotification({
        userId: victim.user.id,
        organizationId: victim.organization.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/notify/notifications/mark-all-read'),
        token: attacker.token,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { data?: { updated_count?: number } };
      expect(body.data?.updated_count).toBe(0);

      const [stored] = await database
        .select({ read_at: notifications.read_at })
        .from(notifications)
        .where(eq(notifications.id, victimNotification.id));
      expect(stored?.read_at).toBeNull();
    });

    it("the unread count never counts another user's notifications", async () => {
      const victim = await createOrganizationContext('victim-unread');
      const attacker = await createOrganizationContext('attacker-unread');
      await createTestNotification({
        userId: victim.user.id,
        organizationId: victim.organization.id,
      });
      await createTestNotification({
        userId: victim.user.id,
        organizationId: victim.organization.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/notify/notifications/unread-count'),
        token: attacker.token,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { data?: { count?: number } };
      expect(body.data?.count).toBe(0);
    });
  });
});
