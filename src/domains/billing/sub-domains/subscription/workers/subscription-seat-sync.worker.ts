import { Worker } from 'bullmq';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import { getDefaultWorkerOptions } from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { getWorkerConcurrencyStripe } from '@/shared/config/worker-concurrency.util.js';
import type { BillingContainer } from '@/domains/billing/billing.container.js';
import { parseJobDataOrDeadLetter } from '@/infrastructure/queue/dlq/poison-job.util.js';
import { runWithPropagatedTraceContext } from '@/infrastructure/observability/tracing/trace-context.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  SUBSCRIPTION_SEAT_SYNC_QUEUE_NAME,
  type SubscriptionSeatSyncJobData,
} from '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.queue.js';
import { subscriptionSeatSyncJobDataSchema } from '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.job.schema.js';
import { processSubscriptionSeatSyncJob } from '@/domains/billing/sub-domains/subscription/workers/subscription-seat-sync.processor.js';

/**
 * Subset of {@link BillingContainer} the seat-sync worker needs (REQ-4): just the subscription
 * service, which manages its own organization DB contexts and the Stripe quantity push.
 *
 * @remarks
 * - **Algorithm:** structural `Pick` over the billing container.
 * - **Failure modes:** none — type only.
 * - **Side effects:** none.
 * - **Notes:** sourced from the worker composition root (`createWorkerContainers`), never the API
 *   process container; keeps the worker decoupled from unrelated billing services.
 */
export type SubscriptionSeatSyncWorkerBillingContainer = Pick<
  BillingContainer,
  'subscriptionService'
>;

/**
 * BullMQ worker that reconciles the Stripe subscription quantity to an org's member count (REQ-4).
 *
 * @remarks
 * - **Algorithm:** validates the job payload at the boundary via `parseJobDataOrDeadLetter`, then
 *   propagates the captured trace context and delegates to {@link processSubscriptionSeatSyncJob}.
 *   The subscription service phases its own DB contexts around the Stripe call.
 * - **Failure modes:** Stripe outages propagate so BullMQ honours its retry/backoff; stalled jobs
 *   are warn-logged; poison payloads are dead-lettered by `parseJobDataOrDeadLetter`.
 * - **Side effects:** holds a Redis connection until the returned {@link WorkerHandle} is closed.
 * - **Notes:** the subscription service must be sourced from the worker composition root; the worker
 *   never instantiates services itself. `usesPostgres` true (the service opens organization contexts).
 */
export function createSubscriptionSeatSyncWorker(
  billingContainer: SubscriptionSeatSyncWorkerBillingContainer,
): WorkerHandle {
  const { subscriptionService } = billingContainer;
  const worker = new Worker<SubscriptionSeatSyncJobData>(
    SUBSCRIPTION_SEAT_SYNC_QUEUE_NAME,
    async (job) => {
      const jobData = await parseJobDataOrDeadLetter({
        schema: subscriptionSeatSyncJobDataSchema,
        job,
        queueName: SUBSCRIPTION_SEAT_SYNC_QUEUE_NAME,
      });
      // Tenant-scoped job: the organization public id rides in the payload (validated above) so the worker
      // boundary is observably tenant-aware before the service re-enters the organization RLS context.
      const { organizationPublicId, requestId } = jobData;
      logger.info(
        { jobId: job.id, organizationPublicId, requestId },
        'subscription.seat_sync.processing',
      );
      await runWithPropagatedTraceContext(
        { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
        job.name,
        () => processSubscriptionSeatSyncJob(jobData, subscriptionService),
      );
    },
    {
      connection: getBullMQConnectionOptions(),
      concurrency: getWorkerConcurrencyStripe(),
      ...getDefaultWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queueName: SUBSCRIPTION_SEAT_SYNC_QUEUE_NAME },
      'subscription.seat_sync.worker.stalled',
    );
  });

  return buildWorkerHandle(worker, SUBSCRIPTION_SEAT_SYNC_QUEUE_NAME);
}
