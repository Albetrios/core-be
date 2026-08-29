import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { database } from '@/infrastructure/database/connection.js';
import { notifications } from '@/domains/notify/sub-domains/notification/notification.schema.js';
import { NotificationRepository } from '@/domains/notify/sub-domains/notification/notification.repository.js';
import { processWebhookDeliveryAttempt } from '@/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-delivery.worker.js';
import { webhook_delivery_attempts } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

vi.mock('@/shared/utils/security/webhook-url.util.js', () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Workers run without the HTTP auth/scope middleware — job payloads must scope repository reads.
 */
describe('Security: Worker tenant isolation', () => {
  it('does not dispatch a notification when organizationPublicId does not match the row', async () => {
    await cleanupDatabase();

    const user = await createTestUser();
    const organizationA = await createTestOrganization({ ownerUserId: user.id });
    const organizationB = await createTestOrganization({ ownerUserId: user.id });

    const [notificationRow] = await database
      .insert(notifications)
      .values({
        public_id: generatePublicId('organization'),
        user_id: user.id,
        organization_id: organizationA.id,
        type: 'security.test',
        title: 'Scoped notification',
        message: 'Tenant isolation check',
        data: { channels: ['in_app'] },
      })
      .returning({ id: notifications.id });

    const repository = new NotificationRepository();
    const dispatchRow = await repository.findByIdForDispatch(
      notificationRow!.id,
      organizationB.public_id,
    );

    expect(dispatchRow).toBeNull();
  });

  it('does not deliver a webhook attempt when organizationPublicId does not match the webhook org', async () => {
    await cleanupDatabase();

    const user = await createTestUser();
    const organizationA = await createTestOrganization({ ownerUserId: user.id });
    const organizationB = await createTestOrganization({ ownerUserId: user.id });
    const webhook = await createTestWebhook({
      organizationId: organizationA.id,
      url: 'https://example.com/worker-tenant-isolation',
      events: ['security.test'],
      createdByUserId: user.id,
    });

    const [pendingAttempt] = await database
      .insert(webhook_delivery_attempts)
      .values({
        public_id: generatePublicId('organization'),
        webhook_id: webhook.id,
        event_type: 'security.test',
        payload: { probe: true },
        status: 'PENDING',
        attempt_count: 0,
      })
      .returning({ id: webhook_delivery_attempts.id });

    await expect(
      processWebhookDeliveryAttempt(
        pendingAttempt!.id,
        organizationB.public_id,
        { id: 'security-test', attemptsMade: 0 },
        vi.fn(),
      ),
    ).rejects.toThrow(/attempt_not_found/);

    const [row] = await database
      .select({ status: webhook_delivery_attempts.status })
      .from(webhook_delivery_attempts)
      .where(eq(webhook_delivery_attempts.id, pendingAttempt!.id));

    expect(row?.status).toBe('PENDING');
  });
});
