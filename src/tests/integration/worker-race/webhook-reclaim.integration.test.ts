import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { database } from '@/infrastructure/database/connection.js';
import { webhook_delivery_attempts } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import { WebhookDeliveryAttemptRepository } from '@/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery-attempt.repository.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';

describe('Integration: webhook delivery sending reclaim', () => {
  const repository = new WebhookDeliveryAttemptRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('reclaims stale SENDING rows to PENDING on the next tryMarkSending', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const webhook = await createTestWebhook({
      organizationId: organization.id,
      url: 'https://example.com/webhook-reclaim',
      events: ['webhook.test'],
      createdByUserId: user.id,
    });

    const [pendingAttempt] = await database
      .insert(webhook_delivery_attempts)
      .values({
        public_id: generatePublicId('webhook'),
        webhook_id: webhook.id,
        event_type: 'webhook.test',
        payload: { reclaim: true },
        status: 'PENDING',
        attempt_count: 0,
      })
      .returning({ id: webhook_delivery_attempts.id });

    expect(await repository.tryMarkSending(pendingAttempt!.id, 1)).toBe('claimed');

    await database
      .update(webhook_delivery_attempts)
      .set({ sent_at: new Date(Date.now() - 60 * 60_000) })
      .where(eq(webhook_delivery_attempts.id, pendingAttempt!.id));

    expect(await repository.tryMarkSending(pendingAttempt!.id, 2)).toBe('claimed');

    const rows = await database
      .select({
        status: webhook_delivery_attempts.status,
        attempt_count: webhook_delivery_attempts.attempt_count,
      })
      .from(webhook_delivery_attempts)
      .where(eq(webhook_delivery_attempts.id, pendingAttempt!.id));

    expect(rows[0]?.status).toBe('SENDING');
    expect(rows[0]?.attempt_count).toBe(2);
  });
});
