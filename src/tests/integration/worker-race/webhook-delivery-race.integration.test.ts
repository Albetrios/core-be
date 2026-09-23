import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { database } from '@/infrastructure/database/connection.js';
import { webhook_delivery_attempts } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import { processWebhookDeliveryAttempt } from '@/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-delivery.worker.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';

vi.mock('@/shared/utils/security/webhook-url.util.js', () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue(undefined),
}));

const PARALLEL_WORKER_COUNT = 10;

describe('Integration: webhook-delivery worker concurrency race', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('issues a single outbound HTTP delivery when parallel workers race the same attempt', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const webhook = await createTestWebhook({
      organizationId: organization.id,
      url: 'https://example.com/webhook-delivery-race',
      events: ['webhook.test'],
      createdByUserId: user.id,
    });

    const [pendingAttempt] = await database
      .insert(webhook_delivery_attempts)
      .values({
        public_id: generatePublicId('webhook'),
        webhook_id: webhook.id,
        event_type: 'webhook.test',
        payload: { race: true },
        status: 'PENDING',
        attempt_count: 0,
      })
      .returning({ id: webhook_delivery_attempts.id });

    let fetchInvocationCount = 0;
    const fetchMock = vi.fn(async () => {
      fetchInvocationCount += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL_WORKER_COUNT }, (_, index) =>
        processWebhookDeliveryAttempt(
          pendingAttempt!.id,
          organization.public_id,
          { id: `job-race-${String(index)}`, attemptsMade: 0 },
          fetchMock,
        ),
      ),
    );

    const deliveredOnce = results.some(
      (result) =>
        result.status === 'fulfilled' && 'httpStatus' in (result.value as { httpStatus?: number }),
    );

    expect(fetchInvocationCount).toBe(1);
    expect(deliveredOnce).toBe(true);

    const rows = await database
      .select()
      .from(webhook_delivery_attempts)
      .where(eq(webhook_delivery_attempts.id, pendingAttempt!.id));

    expect(rows[0]?.status).toBe('SENT');
    expect(rows[0]?.http_status_code).toBe(200);
  });
});
