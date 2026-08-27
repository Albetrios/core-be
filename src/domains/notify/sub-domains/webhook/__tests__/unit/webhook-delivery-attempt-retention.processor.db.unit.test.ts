import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { eq } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { WebhookRepository } from '@/domains/notify/sub-domains/webhook/webhook.repository.js';
import { WebhookDeliveryAttemptRepository } from '@/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery-attempt.repository.js';
import { webhook_delivery_attempts } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import { runWebhookDeliveryAttemptRetentionJob } from '@/domains/notify/sub-domains/webhook/workers/webhook-delivery-attempt-retention.processor.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe('runWebhookDeliveryAttemptRetentionJob (database, audit-#3)', () => {
  const webhookRepository = new WebhookRepository();
  const attemptRepository = new WebhookDeliveryAttemptRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('purges delivery attempts older than the retention window and keeps recent ones', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const webhook = await webhookRepository.create({
      organization_id: organization.id,
      url: 'https://example.com/webhooks',
      events: ['subscription.updated'],
      encrypted_secret: 'secret',
      created_by_user_id: owner.id,
    });

    const recent = await attemptRepository.create({
      webhook_id: webhook.id,
      event_type: 'subscription.updated',
      payload: { id: 'recent' },
      status: 'SENT',
      http_status_code: 200,
      response_body: 'ok',
      sent_at: new Date(),
      attempt_count: 1,
    });
    const old = await attemptRepository.create({
      webhook_id: webhook.id,
      event_type: 'subscription.updated',
      payload: { id: 'old' },
      status: 'SENT',
      http_status_code: 200,
      response_body: 'ok',
      sent_at: new Date(),
      attempt_count: 1,
    });

    // Backdate the "old" attempt well past the default 30-day retention window.
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await database
      .update(webhook_delivery_attempts)
      .set({ created_at: fortyDaysAgo })
      .where(eq(webhook_delivery_attempts.id, old.id));

    const result = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.global_retention_cleanup,
      (databaseHandle) => runWebhookDeliveryAttemptRetentionJob(databaseHandle),
    );

    expect(result.deletedCount).toBe(1);

    const remaining = await database
      .select({ id: webhook_delivery_attempts.id })
      .from(webhook_delivery_attempts);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(recent.id);
  });
});
