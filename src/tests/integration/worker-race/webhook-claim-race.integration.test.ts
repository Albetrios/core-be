import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { webhook_delivery_attempts } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { WebhookDeliveryAttemptRepository } from '@/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery-attempt.repository.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';

describe('Integration: webhook delivery claim race', () => {
  const repository = new WebhookDeliveryAttemptRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('allows only one PENDING → SENDING claim when ten workers race', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const webhook = await createTestWebhook({
      organizationId: organization.id,
      url: 'https://example.com/webhook-claim-race',
      events: ['webhook.test'],
      createdByUserId: user.id,
    });

    const [pendingAttempt] = await getOperatorDatabase()
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

    const claimResults = await Promise.all(
      // Ten worker jobs, each claiming inside its own JOB scope — the way
      // `webhook-delivery.worker.ts` actually claims. A context-free call would race a path
      // production never takes, and under an RLS-subject role it sees no row at all.
      Array.from({ length: 10 }, () =>
        withAppDatabaseContext(
          PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id }),
          () => repository.tryMarkSending(pendingAttempt!.id, 1),
        ),
      ),
    );

    expect(claimResults.filter((result) => result === 'claimed')).toHaveLength(1);
    expect(claimResults.filter((result) => result === 'in_flight')).toHaveLength(9);

    const rows = await getOperatorDatabase()
      .select({ status: webhook_delivery_attempts.status })
      .from(webhook_delivery_attempts)
      .where(eq(webhook_delivery_attempts.id, pendingAttempt!.id));

    expect(rows[0]?.status).toBe('SENDING');
  });
});
