import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Queue, QueueEvents } from 'bullmq';
import { desc, eq } from 'drizzle-orm';

import { database } from '@/infrastructure/database/connection.js';
import { webhook_delivery_attempts } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import {
  createWebhookDeliveryWorker,
  processWebhookDeliveryAttempt,
} from '@/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-delivery.worker.js';
import {
  WEBHOOK_DELIVERY_QUEUE_NAME,
  type WebhookDeliveryJobData,
} from '@/domains/notify/sub-domains/webhook/webhook-delivery/queues/webhook-delivery.queue.js';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

vi.mock('@/shared/utils/security/webhook-url.util.js', () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue(undefined),
}));

/**
 * End-to-end check for the webhook delivery worker. Without this, a CHECK
 * constraint mismatch (allowed statuses vs. statuses written by the worker)
 * went undetected and surfaced only in production / chaos runs.
 */
describe('webhook-delivery.worker — status transitions', () => {
  let workerHandle: WorkerHandle | null = null;
  let queue: Queue<WebhookDeliveryJobData> | null = null;
  let queueEvents: QueueEvents | null = null;

  beforeAll(async () => {
    workerHandle = createWebhookDeliveryWorker();
    queue = new Queue<WebhookDeliveryJobData>(WEBHOOK_DELIVERY_QUEUE_NAME, {
      connection: getBullMQConnectionOptions(),
      defaultJobOptions: {
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 20 },
      },
    });
    queueEvents = new QueueEvents(WEBHOOK_DELIVERY_QUEUE_NAME, {
      connection: getBullMQConnectionOptions(),
    });
    await queueEvents.waitUntilReady();
    await workerHandle.worker?.waitUntilReady();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await workerHandle?.close();
    await queue?.close();
    await queueEvents?.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('records SENT after a successful delivery', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const webhook = await createTestWebhook({
      organizationId: organization.id,
      url: 'https://example.com/webhook-delivery-success',
      events: ['webhook.test'],
      createdByUserId: user.id,
    });

    const [pendingAttempt] = await database
      .insert(webhook_delivery_attempts)
      .values({
        public_id: generatePublicId('webhook'),
        webhook_id: webhook.id,
        event_type: 'webhook.test',
        payload: { hello: 'world' },
        status: 'PENDING',
        attempt_count: 0,
      })
      .returning({ id: webhook_delivery_attempts.id });

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await processWebhookDeliveryAttempt(
      pendingAttempt!.id,
      organization.public_id,
      { id: 'unit-test', attemptsMade: 0 },
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledOnce();

    const rows = await database
      .select()
      .from(webhook_delivery_attempts)
      .where(eq(webhook_delivery_attempts.webhook_id, webhook.id))
      .orderBy(desc(webhook_delivery_attempts.created_at));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.status).toBe('SENT');
    expect(rows[0]?.http_status_code).toBe(200);
  });

  it('records FAILED when the destination returns a non-2xx response', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const webhook = await createTestWebhook({
      organizationId: organization.id,
      url: 'https://example.com/webhook-delivery-failure',
      events: ['webhook.test'],
      createdByUserId: user.id,
    });

    const [pendingAttempt] = await database
      .insert(webhook_delivery_attempts)
      .values({
        public_id: generatePublicId('webhook'),
        webhook_id: webhook.id,
        event_type: 'webhook.test',
        payload: { hello: 'world' },
        status: 'PENDING',
        attempt_count: 0,
      })
      .returning({ id: webhook_delivery_attempts.id });

    const fetchMock = vi.fn(async () => new Response('upstream rejected', { status: 500 }));

    await expect(
      processWebhookDeliveryAttempt(
        pendingAttempt!.id,
        organization.public_id,
        { id: `wh-test-failure-${randomUUID()}`, attemptsMade: 0 },
        fetchMock,
      ),
    ).rejects.toThrow(/HTTP 500/);

    expect(fetchMock).toHaveBeenCalledOnce();

    const rows = await database
      .select()
      .from(webhook_delivery_attempts)
      .where(eq(webhook_delivery_attempts.id, pendingAttempt!.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('FAILED');
  });

  it('emits a failed queue event when BullMQ delivery exhausts attempts', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const webhook = await createTestWebhook({
      organizationId: organization.id,
      url: 'https://example.com/webhook-delivery-failure-queue',
      events: ['webhook.test'],
      createdByUserId: user.id,
    });

    const [pendingAttempt] = await database
      .insert(webhook_delivery_attempts)
      .values({
        public_id: generatePublicId('webhook'),
        webhook_id: webhook.id,
        event_type: 'webhook.test',
        payload: { hello: 'world' },
        status: 'PENDING',
        attempt_count: 0,
      })
      .returning({ id: webhook_delivery_attempts.id });

    const queueReference = queue;
    const queueEventsReference = queueEvents;
    if (!(queueReference && queueEventsReference)) {
      throw new Error('queue or queueEvents was not initialized');
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream rejected', { status: 500 })),
    );
    const jobId = `wh-test-failure-${randomUUID()}`;
    const failure = waitForJobFailure(queueEventsReference, jobId);

    await queueReference.add(
      'deliver-webhook',
      { deliveryAttemptId: pendingAttempt!.id, organizationPublicId: organization.public_id },
      { jobId, attempts: 1 },
    );

    await failure;
    vi.unstubAllGlobals();
  });

  it('does not load a delivery attempt under another organization context', async () => {
    const user = await createTestUser();
    const organizationA = await createTestOrganization({
      ownerUserId: user.id,
      slug: `org-a-${randomUUID().slice(0, 8)}`,
    });
    const organizationB = await createTestOrganization({
      ownerUserId: user.id,
      slug: `org-b-${randomUUID().slice(0, 8)}`,
    });
    const webhook = await createTestWebhook({
      organizationId: organizationA.id,
      url: 'https://example.com/webhook-tenant-isolation',
      events: ['webhook.test'],
      createdByUserId: user.id,
    });

    const [pendingAttempt] = await database
      .insert(webhook_delivery_attempts)
      .values({
        public_id: generatePublicId('webhook'),
        webhook_id: webhook.id,
        event_type: 'webhook.test',
        payload: { tenant: 'isolation' },
        status: 'PENDING',
        attempt_count: 0,
      })
      .returning({ id: webhook_delivery_attempts.id });

    await expect(
      processWebhookDeliveryAttempt(
        pendingAttempt!.id,
        organizationB.public_id,
        { id: 'tenant-isolation', attemptsMade: 0 },
        vi.fn(async () => new Response('ok', { status: 200 })),
      ),
    ).rejects.toThrow(/attempt_not_found/);
  });
});

function waitForJobFailure(queueEvents: QueueEvents, expectedJobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onFailed = (payload: { jobId: string }) => {
      if (payload.jobId !== expectedJobId) return;
      queueEvents.off('failed', onFailed);
      resolve();
    };
    queueEvents.on('failed', onFailed);
    setTimeout(() => reject(new Error(`timeout waiting for job ${expectedJobId}`)), 15_000);
  });
}
