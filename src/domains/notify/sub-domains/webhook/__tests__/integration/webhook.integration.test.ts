import { randomUUID } from 'node:crypto';
import {
  type RequestScopedPostgresDatabase,
  runWithPinnedDatabaseHandle,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { buildIdempotencyCacheKey } from '@/shared/utils/idempotency/idempotency-key.util.js';
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
import { NOTIFY_PERMISSIONS } from '@/domains/notify/notify.permissions.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import {
  webhook_delivery_attempts,
  webhooks,
} from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import { WebhookDeliveryAttemptRepository } from '@/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery-attempt.repository.js';

const WEBHOOK_PERMISSIONS = [NOTIFY_PERMISSIONS.WEBHOOK_READ, NOTIFY_PERMISSIONS.WEBHOOK_MANAGE];

/** Well-formed but nonexistent public id — passes `webhookIdParamsDto`, misses every row. */
const UNKNOWN_WEBHOOK_ID = 'whk_aaaaaaaaaaaaaaaaaaaaa';

describe('Webhook Sub-Domain — Integration', () => {
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

  async function createAuthorizedContext(permissionCodes = WEBHOOK_PERMISSIONS) {
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
    // webhook permission preHandler and the organization-scoped controller.
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, organization, token };
  }

  describe('GET /api/v1/notify/webhooks', () => {
    it('returns 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath('/notify/webhooks'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 without webhook read permission', async () => {
      const owner = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: owner.id });
      const user = await createTestUser({ email: 'no-webhook@test.com' });
      // Scope the bearer to the organization via the `org` claim so the request reaches
      // the webhook permission check; the user has no membership → 403.
      const token = await generateTestToken({
        userId: user.public_id,
        organizationPublicId: organization.public_id,
      });
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/notify/webhooks'),
        token,
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 200 with webhook read permission', async () => {
      const { token } = await createAuthorizedContext([NOTIFY_PERMISSIONS.WEBHOOK_READ]);
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/notify/webhooks'),
        token,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        meta?: { pagination?: { has_more?: boolean; next?: string | null } };
      };
      expect(body.meta?.pagination).toMatchObject({ has_more: false, next: null });
    });

    it('paginates webhooks with after cursor and include_total', { timeout: 30_000 }, async () => {
      const { organization, token } = await createAuthorizedContext([
        NOTIFY_PERMISSIONS.WEBHOOK_READ,
      ]);
      const owner = await createTestUser({ email: `webhook-cursor-owner-${Date.now()}@test.com` });
      const baseCreatedAt = Date.now();
      for (let index = 0; index < 3; index += 1) {
        const webhook = await createTestWebhook({
          organizationId: organization.id,
          url: `https://example.com/cursor-${index}-${baseCreatedAt}`,
          createdByUserId: owner.id,
        });
        const orderedCreatedAt = new Date(baseCreatedAt + index * 1_000);
        await getOperatorDatabase()
          .update(webhooks)
          .set({ created_at: orderedCreatedAt, updated_at: orderedCreatedAt })
          .where(eq(webhooks.id, webhook.id));
      }

      const page1Response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/notify/webhooks'),
        token,
        query: { limit: '2', include_total: 'true' },
      });
      expect(page1Response.statusCode).toBe(200);
      const page1Body = page1Response.json() as {
        data: Array<{ id: string }>;
        meta?: {
          pagination?: {
            has_more?: boolean;
            next?: string | null;
            estimated_total?: number;
            per_page?: number;
          };
        };
      };
      expect(page1Body.data).toHaveLength(2);
      expect(page1Body.meta?.pagination).toMatchObject({
        has_more: true,
        per_page: 2,
        estimated_total: 3,
      });
      expect(page1Body.meta?.pagination?.next).toBeTypeOf('string');

      const page2Response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/notify/webhooks'),
        token,
        query: { limit: '2', after: page1Body.meta!.pagination!.next! },
      });
      expect(page2Response.statusCode).toBe(200);
      const page2Body = page2Response.json() as {
        data: Array<{ id: string }>;
        meta?: { pagination?: { has_more?: boolean; next?: string | null } };
      };
      const page1Ids = new Set(page1Body.data.map((row) => row.id));
      for (const row of page2Body.data) {
        expect(page1Ids.has(row.id)).toBe(false);
      }
      expect(page1Body.data.length + page2Body.data.length).toBe(3);
      expect(page2Body.meta?.pagination).toMatchObject({ has_more: false, next: null });
    });
  });

  describe('GET /api/v1/notify/webhooks/:webhook_id/delivery-attempts', () => {
    it('paginates delivery attempts with after cursor (newest first)', {
      timeout: 30_000,
    }, async () => {
      const { organization, token } = await createAuthorizedContext([
        NOTIFY_PERMISSIONS.WEBHOOK_READ,
      ]);
      const owner = await createTestUser({
        email: `attempt-cursor-owner-${Date.now()}@test.com`,
      });
      const webhook = await createTestWebhook({
        organizationId: organization.id,
        url: `https://example.com/attempts-${Date.now()}`,
        createdByUserId: owner.id,
      });
      const attemptRepository = new WebhookDeliveryAttemptRepository();
      const baseCreatedAt = Date.now();
      for (let index = 0; index < 3; index += 1) {
        const attempt = await runWithPinnedDatabaseHandle(
          // Seeded on the operator connection: a fixture, not the behaviour under test.
          getOperatorDatabase() as unknown as RequestScopedPostgresDatabase,
          () =>
            attemptRepository.create({
              webhook_id: webhook.id,
              event_type: 'subscription.updated',
              payload: { id: `evt_${index}` },
              status: 'SENT',
              http_status_code: 200,
              response_body: 'ok',
              sent_at: new Date(),
              attempt_count: 1,
            }),
        );
        await getOperatorDatabase()
          .update(webhook_delivery_attempts)
          .set({ created_at: new Date(baseCreatedAt + index * 1_000) })
          .where(eq(webhook_delivery_attempts.id, attempt.id));
      }

      const page1Response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/notify/webhooks/${webhook.public_id}/delivery-attempts`),
        token,
        query: { limit: '2' },
      });
      expect(page1Response.statusCode).toBe(200);
      const page1Body = page1Response.json() as {
        data: unknown[];
        meta?: { pagination?: { has_more?: boolean; next?: string | null } };
      };
      expect(page1Body.data).toHaveLength(2);
      expect(page1Body.meta?.pagination).toMatchObject({ has_more: true });
      expect(page1Body.meta?.pagination?.next).toBeTypeOf('string');

      const page2Response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/notify/webhooks/${webhook.public_id}/delivery-attempts`),
        token,
        query: { limit: '2', after: page1Body.meta!.pagination!.next! },
      });
      expect(page2Response.statusCode).toBe(200);
      const page2Body = page2Response.json() as {
        data: unknown[];
        meta?: { pagination?: { has_more?: boolean; next?: string | null } };
      };
      expect(page1Body.data.length + page2Body.data.length).toBe(3);
      expect(page2Body.meta?.pagination).toMatchObject({ has_more: false, next: null });
    });
  });

  describe('DELETE /api/v1/notify/webhooks/:webhook_id', () => {
    it('returns 204 with webhook manage permission', async () => {
      const { user, organization, token } = await createAuthorizedContext();
      const webhook = await createTestWebhook({
        organizationId: organization.id,
        url: 'https://example.com/delete-happy-path',
        createdByUserId: user.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/notify/webhooks/${webhook.public_id}`),
        token,
      });
      expect(response.statusCode, response.body).toBe(204);
    });

    it('returns 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/notify/webhooks/${UNKNOWN_WEBHOOK_ID}`),
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 without webhook manage permission', async () => {
      const { user, organization, token } = await createAuthorizedContext([
        NOTIFY_PERMISSIONS.WEBHOOK_READ,
      ]);
      const webhook = await createTestWebhook({
        organizationId: organization.id,
        url: 'https://example.com/delete-denied',
        createdByUserId: user.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/notify/webhooks/${webhook.public_id}`),
        token,
      });
      expect(response.statusCode, response.body).toBe(403);
    });
  });

  /**
   * Before this block, `GET /notify/webhooks/:webhook_id`'s only 200 came from the owner baseline
   * inside the platform BOLA suite — a file whose purpose is to test something else and which
   * `VITEST_DOMAIN_FILTER=notify` never runs.
   */
  describe('GET /api/v1/notify/webhooks/:webhook_id', () => {
    it('returns 200 with webhook read permission', async () => {
      const { user, organization, token } = await createAuthorizedContext([
        NOTIFY_PERMISSIONS.WEBHOOK_READ,
      ]);
      const webhook = await createTestWebhook({
        organizationId: organization.id,
        url: 'https://example.com/get-happy-path',
        createdByUserId: user.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/notify/webhooks/${webhook.public_id}`),
        token,
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { data?: { id?: string; url?: string } };
      expect(body.data?.id).toBe(webhook.public_id);
      expect(body.data?.url).toBe('https://example.com/get-happy-path');
    });

    it('never exposes the signing secret on the single-webhook read', async () => {
      // `webhook.serializer.no-secret.unit.test.ts` proves the serializer strips the secret;
      // nothing proved the ROUTE actually goes through that serializer.
      const { user, organization, token } = await createAuthorizedContext([
        NOTIFY_PERMISSIONS.WEBHOOK_READ,
      ]);
      const webhook = await createTestWebhook({
        organizationId: organization.id,
        url: 'https://example.com/get-no-secret',
        createdByUserId: user.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/notify/webhooks/${webhook.public_id}`),
        token,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { data?: Record<string, unknown> };
      expect(body.data).not.toHaveProperty('secret');
      expect(body.data).not.toHaveProperty('encrypted_secret');
      expect(body.data).not.toHaveProperty('encrypted_secret_previous');
      // Belt and braces: the ciphertext must not appear anywhere in the payload under any name.
      expect(response.body).not.toContain(webhook.encrypted_secret);
    });

    it('returns 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath(`/notify/webhooks/${UNKNOWN_WEBHOOK_ID}`),
      });
      expect(response.statusCode).toBe(401);
    });
  });

  /**
   * `PATCH /notify/webhooks/:webhook_id` was the domain's most-exposed untested route: it mutates
   * a customer's delivery URL and rotates their signing secret, and its declared 200 had no
   * notify-scoped assertion at all.
   */
  describe('PATCH /api/v1/notify/webhooks/:webhook_id', () => {
    it('returns 200 and applies the update', async () => {
      const { user, organization, token } = await createAuthorizedContext();
      const webhook = await createTestWebhook({
        organizationId: organization.id,
        url: 'https://example.com/patch-happy-path',
        createdByUserId: user.id,
      });

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: testApiPath(`/notify/webhooks/${webhook.public_id}`),
        token,
        payload: { events: ['subscription.updated'], is_enabled: false },
      });

      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as {
        data?: { id?: string; events?: string[]; is_enabled?: boolean };
      };
      expect(body.data?.id).toBe(webhook.public_id);
      expect(body.data?.events).toEqual(['subscription.updated']);
      expect(body.data?.is_enabled).toBe(false);
    });

    it('returns 400 for a rejected body', async () => {
      const { user, organization, token } = await createAuthorizedContext();
      const webhook = await createTestWebhook({
        organizationId: organization.id,
        url: 'https://example.com/patch-invalid-body',
        createdByUserId: user.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/notify/webhooks/${webhook.public_id}`),
        token,
        // `events` is `.min(1)` and the DTO is `.strict()` — an empty array is a hard reject.
        payload: { events: [] },
      });

      expect(response.statusCode, response.body).toBe(400);
    });

    it('returns 403 without webhook manage permission', async () => {
      const { user, organization, token } = await createAuthorizedContext([
        NOTIFY_PERMISSIONS.WEBHOOK_READ,
      ]);
      const webhook = await createTestWebhook({
        organizationId: organization.id,
        url: 'https://example.com/patch-denied',
        createdByUserId: user.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/notify/webhooks/${webhook.public_id}`),
        token,
        payload: { is_enabled: false },
      });

      expect(response.statusCode, response.body).toBe(403);
    });

    it('returns 409 when re-rotating the secret inside the overlap window', async () => {
      // Proven at the repository DB layer and in the shared unique-violation suite, but never
      // in-domain over HTTP. Re-rotating would overwrite the single `encrypted_secret_previous`
      // slot and evict a still-valid old secret, breaking zero-downtime rotation.
      const { user, organization, token } = await createAuthorizedContext();
      const webhook = await createTestWebhook({
        organizationId: organization.id,
        url: 'https://example.com/patch-rotate',
        createdByUserId: user.id,
      });

      const firstRotation = await injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: testApiPath(`/notify/webhooks/${webhook.public_id}`),
        token,
        payload: { secret: 'first-rotation-secret-value' },
      });
      expect(firstRotation.statusCode, firstRotation.body).toBe(200);

      const secondRotation = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/notify/webhooks/${webhook.public_id}`),
        token,
        payload: { secret: 'second-rotation-secret-value' },
      });

      expect(secondRotation.statusCode, secondRotation.body).toBe(409);
    });
  });

  /**
   * `POST /notify/webhooks` is the domain's only `idempotencyRequired` write (the `I` column in
   * docs/routes.txt). Every existing test supplies a key purely to clear the gate; the contract
   * the gate exists to enforce was never exercised.
   */
  describe('POST /api/v1/notify/webhooks — idempotency contract', () => {
    it('returns 422 when X-Idempotency-Key is missing', async () => {
      const { token } = await createAuthorizedContext();

      // `injectRoute` auto-supplies a key for this exact path, so the missing-key case has to
      // go through `app.inject` directly — that auto-supply is the reason this was never covered.
      const response = await app.inject({
        method: 'POST',
        url: testApiPath('/notify/webhooks'),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: { url: 'https://example.com/idem-missing-key', events: ['subscription.updated'] },
      });

      expect(response.statusCode, response.body).toBe(422);
    });

    it('returns 409 when the same key is still in flight', async () => {
      const { user, organization, token } = await createAuthorizedContext();
      const idempotencyKey = `notify-webhook-in-flight-${randomUUID()}`;

      // Seeding the in-flight placeholder is the deterministic way to drive this branch —
      // racing two real requests would be inherently flaky. Same approach as
      // `src/tests/integration/runtime/idempotency-in-flight-409.integration.test.ts`.
      // The cache key is scoped by the active organization (the signed `org` JWT claim), not just the user.
      const cacheKey = buildIdempotencyCacheKey(idempotencyKey, {
        userId: user.public_id,
        organizationId: organization.public_id,
      });
      await redisConnection.set(
        cacheKey,
        JSON.stringify({ state: 'in_flight', claimedAt: Date.now() }),
        'EX',
        60,
      );

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/notify/webhooks'),
        token,
        headers: { 'x-idempotency-key': idempotencyKey },
        payload: { url: 'https://example.com/idem-in-flight', events: ['subscription.updated'] },
      });

      expect(response.statusCode, response.body).toBe(409);

      await redisConnection.del(cacheKey);
    });

    it('returns 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/notify/webhooks'),
        payload: {
          url: 'https://example.com/idem-unauthenticated',
          events: ['subscription.updated'],
        },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/notify/webhooks — validation', () => {
    it('rejects an invalid create payload', async () => {
      // Consolidated here from the retired `notify.integration.test.ts`, which was a
      // case-for-case duplicate of the bundled `notify.test.ts` except for this one assertion.
      const { token } = await createAuthorizedContext();

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/notify/webhooks'),
        token,
        payload: { url: 'not-a-url', events: [] },
      });

      expect(response.statusCode, response.body).toBe(400);
    });
  });

  describe('GET /api/v1/notify/webhooks/:webhook_id/delivery-attempts — denials', () => {
    it('returns 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath(`/notify/webhooks/${UNKNOWN_WEBHOOK_ID}/delivery-attempts`),
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 without webhook read permission', async () => {
      const { user, organization, token } = await createAuthorizedContext([
        NOTIFY_PERMISSIONS.WEBHOOK_MANAGE,
      ]);
      const webhook = await createTestWebhook({
        organizationId: organization.id,
        url: 'https://example.com/attempts-denied',
        createdByUserId: user.id,
      });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/notify/webhooks/${webhook.public_id}/delivery-attempts`),
        token,
      });
      expect(response.statusCode, response.body).toBe(403);
    });

    it('returns 404 for an unknown webhook', async () => {
      const { token } = await createAuthorizedContext([NOTIFY_PERMISSIONS.WEBHOOK_READ]);

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/notify/webhooks/${UNKNOWN_WEBHOOK_ID}/delivery-attempts`),
        token,
      });
      expect(response.statusCode, response.body).toBe(404);
    });
  });

  describe('GET /api/v1/notify/webhook-events', () => {
    it('returns 403 without webhook read permission', async () => {
      const { token } = await createAuthorizedContext([NOTIFY_PERMISSIONS.WEBHOOK_MANAGE]);

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/notify/webhook-events'),
        token,
      });
      expect(response.statusCode, response.body).toBe(403);
    });
  });
});
