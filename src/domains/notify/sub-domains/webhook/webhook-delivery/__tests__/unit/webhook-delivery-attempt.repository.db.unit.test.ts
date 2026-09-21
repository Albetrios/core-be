import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { WebhookRepository } from '@/domains/notify/sub-domains/webhook/webhook.repository.js';
import { WebhookDeliveryAttemptRepository } from '@/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery-attempt.repository.js';
import { webhook_delivery_attempts } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe('WebhookDeliveryAttemptRepository (database)', () => {
  const webhookRepository = new WebhookRepository();
  const attemptRepository = new WebhookDeliveryAttemptRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('creates and lists delivery attempts for webhook', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const webhook = await webhookRepository.create({
      organization_id: organization.id,
      url: 'https://example.com/webhooks',
      events: ['subscription.updated'],
      encrypted_secret: 'sample-webhook-secret',
      created_by_user_id: owner.id,
    });

    const webhookId = await attemptRepository.getWebhookId(webhook.public_id, organization.id);
    expect(webhookId).toBe(webhook.id);

    await attemptRepository.create({
      webhook_id: webhook.id,
      event_type: 'subscription.updated',
      payload: { id: 'inv_1' },
      status: 'SENT',
      http_status_code: 200,
      response_body: 'ok',
      sent_at: new Date(),
      attempt_count: 1,
    });

    const listed = await attemptRepository.listByWebhook(webhook.id, { limit: 10 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.status).toBe('SENT');
    expect(listed.total).toBeNull();
    // sec-r4-D6: list projection MUST NOT include payload / response_body.
    // A future single-attempt detail endpoint can expose them on request.
    expect(listed.items[0]).not.toHaveProperty('payload');
    expect(listed.items[0]).not.toHaveProperty('response_body');
  });

  it('getWebhookId returns null for unknown webhook', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const webhookId = await attemptRepository.getWebhookId('missing_webhook', organization.id);
    expect(webhookId).toBeNull();
  });

  describe('listByWebhook (keyset cursor pagination, newest first)', () => {
    async function setupWebhookWithAttempts(attemptCount: number) {
      const owner = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: owner.id });
      const webhook = await webhookRepository.create({
        organization_id: organization.id,
        url: 'https://example.com/webhooks',
        events: ['subscription.updated'],
        encrypted_secret: 'secret',
        created_by_user_id: owner.id,
      });
      const baseCreatedAt = Date.now();
      for (let index = 0; index < attemptCount; index += 1) {
        const attempt = await attemptRepository.create({
          webhook_id: webhook.id,
          event_type: 'subscription.updated',
          payload: { id: `inv_${index}` },
          status: 'SENT',
          http_status_code: 200,
          response_body: `ok-${index}`,
          sent_at: new Date(),
          attempt_count: 1,
        });
        await database
          .update(webhook_delivery_attempts)
          .set({ created_at: new Date(baseCreatedAt + index * 1_000) })
          .where(eq(webhook_delivery_attempts.id, attempt.id));
      }
      return { webhook, organization, owner };
    }

    it('returns has_more=true with an opaque next_cursor when more pages remain (no total by default)', async () => {
      const { webhook } = await setupWebhookWithAttempts(3);

      const result = await attemptRepository.listByWebhook(webhook.id, { limit: 2 });

      expect(result.items).toHaveLength(2);
      expect(result.has_more).toBe(true);
      expect(result.next_cursor).toBeTypeOf('string');
      expect(result.total).toBeNull();
    });

    it('navigates pages with `after` cursor and never repeats the previous page', async () => {
      const { webhook } = await setupWebhookWithAttempts(3);

      const firstPage = await attemptRepository.listByWebhook(webhook.id, { limit: 2 });
      expect(firstPage.has_more).toBe(true);
      expect(firstPage.next_cursor).toBeTypeOf('string');

      const nextPage = await attemptRepository.listByWebhook(webhook.id, {
        limit: 2,
        after: firstPage.next_cursor!,
      });

      const firstPageIds = new Set(firstPage.items.map((item) => item.id));
      for (const item of nextPage.items) {
        expect(firstPageIds.has(item.id)).toBe(false);
      }
      expect(firstPage.items.length + nextPage.items.length).toBe(3);
      expect(nextPage.has_more).toBe(false);
      expect(nextPage.next_cursor).toBeNull();
    });

    it('orders attempts newest first (descending created_at, id)', async () => {
      const { webhook } = await setupWebhookWithAttempts(3);
      const result = await attemptRepository.listByWebhook(webhook.id, { limit: 10 });
      const ids = result.items.map((item) => item.id);
      const sortedDesc = [...ids].sort((leftId, rightId) => rightId - leftId);
      expect(ids).toEqual(sortedDesc);
    });

    it('returns total when include_total=true is requested', async () => {
      const { webhook } = await setupWebhookWithAttempts(3);

      const result = await attemptRepository.listByWebhook(webhook.id, {
        limit: 2,
        include_total: true,
      });

      expect(result.total).toBe(3);
      expect(result.has_more).toBe(true);
    });

    it('returns empty result when the webhook has no delivery attempts', async () => {
      const owner = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: owner.id });
      const webhook = await webhookRepository.create({
        organization_id: organization.id,
        url: 'https://example.com/empty',
        events: ['subscription.updated'],
        encrypted_secret: 'secret',
        created_by_user_id: owner.id,
      });

      const result = await attemptRepository.listByWebhook(webhook.id, { limit: 10 });

      expect(result.items).toEqual([]);
      expect(result.has_more).toBe(false);
      expect(result.next_cursor).toBeNull();
      expect(result.total).toBeNull();
    });
  });
});
