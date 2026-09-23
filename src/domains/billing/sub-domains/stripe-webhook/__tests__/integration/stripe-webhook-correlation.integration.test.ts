import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Queue, QueueEvents } from 'bullmq';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import type * as StripeClientModule from '@/infrastructure/payment/stripe.client.js';

const retrieveStripeEventMock = vi.hoisted(() => vi.fn());

vi.mock('@/infrastructure/payment/stripe.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof StripeClientModule>();
  return {
    ...actual,
    retrieveStripeEvent: (...arguments_: unknown[]) => retrieveStripeEventMock(...arguments_),
  };
});

import { database } from '@/infrastructure/database/connection.js';
import { stripe_webhook_events } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook.schema.js';
import { createStripeWebhookWorker } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook.worker.js';
import { createWorkerContainers } from '@/worker-containers.js';
import { STRIPE_WEBHOOK_QUEUE_NAME } from '@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js';
import type { StripeWebhookJobData } from '@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';

const correlationRequestId = 'req-stripe-correlation-e2e';

describe('stripe-webhook — enqueue correlation id', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('includes requestId in the BullMQ job payload when enqueuing', async () => {
    const addMock = vi.fn().mockResolvedValue({ id: 'job-1' });
    vi.doMock('bullmq', () => ({
      Queue: class MockQueue {
        add = addMock;
        close = vi.fn();
      },
    }));
    vi.doMock('@/infrastructure/queue/connection.js', () => ({
      getBullMQConnectionOptions: () => ({}),
      getBullMQProducerConnectionOptions: () => ({ enableOfflineQueue: false }),
    }));

    const { enqueueStripeWebhook } = await import(
      '@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js'
    );
    const event = {
      id: 'evt_enqueue_test',
      type: 'account.updated',
      created: Math.floor(Date.now() / 1000),
      data: { object: {} },
    } as Stripe.Event;

    await enqueueStripeWebhook(event, 'req-stripe-enqueue-correlation');

    expect(addMock).toHaveBeenCalledWith(
      'process-stripe-webhook',
      expect.objectContaining({
        stripeEventId: 'evt_enqueue_test',
        requestId: 'req-stripe-enqueue-correlation',
      }),
      expect.any(Object),
    );
    const jobPayload = addMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(jobPayload).sort()).toEqual(['requestId', 'stripeEventId']);
  });
});

/**
 * End-to-end: request id on the Stripe webhook job payload is persisted on the event ledger.
 */
describe('stripe-webhook — worker correlation id propagation', () => {
  let workerHandle: WorkerHandle | null = null;
  let queue: Queue<StripeWebhookJobData> | null = null;
  let queueEvents: QueueEvents | null = null;

  beforeAll(async () => {
    workerHandle = createStripeWebhookWorker(createWorkerContainers().billingDomain);
    queue = new Queue<StripeWebhookJobData>(STRIPE_WEBHOOK_QUEUE_NAME, {
      connection: getBullMQConnectionOptions(),
      defaultJobOptions: {
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 20 },
      },
    });
    queueEvents = new QueueEvents(STRIPE_WEBHOOK_QUEUE_NAME, {
      connection: getBullMQConnectionOptions(),
    });
    await queueEvents.waitUntilReady();
    await workerHandle.worker?.waitUntilReady();
  });

  afterAll(async () => {
    await workerHandle?.close();
    await queue?.close();
    await queueEvents?.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    retrieveStripeEventMock.mockReset();
  });

  it('persists requestId from the job through the worker into stripe_webhook_events', async () => {
    const stripeEventId = `evt_correlation_${randomUUID()}`;
    const eventPayload = {
      id: stripeEventId,
      type: 'account.updated',
      created: Math.floor(Date.now() / 1000),
      data: { object: {} },
    } as Stripe.Event;

    const jobId = `stripe-correlation-${randomUUID()}`;
    const completion = waitForJobCompletion(queueEvents!, jobId);

    retrieveStripeEventMock.mockResolvedValue(eventPayload);

    await queue!.add(
      'process-stripe-webhook',
      {
        stripeEventId,
        requestId: correlationRequestId,
      },
      { jobId, attempts: 1 },
    );

    await completion;

    const rows = await database
      .select()
      .from(stripe_webhook_events)
      .where(eq(stripe_webhook_events.stripe_event_id, stripeEventId))
      .limit(1);

    expect(rows[0]?.request_id).toBe(correlationRequestId);
  });
});

function waitForJobCompletion(queueEvents: QueueEvents, expectedJobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onCompleted = (payload: { jobId: string }) => {
      if (payload.jobId !== expectedJobId) return;
      queueEvents.off('completed', onCompleted);
      resolve();
    };
    const onFailed = (payload: { jobId: string; failedReason: string }) => {
      if (payload.jobId !== expectedJobId) return;
      queueEvents.off('failed', onFailed);
      reject(new Error(payload.failedReason));
    };
    queueEvents.on('completed', onCompleted);
    queueEvents.on('failed', onFailed);
    setTimeout(() => reject(new Error(`timeout waiting for job ${expectedJobId}`)), 30_000);
  });
}
