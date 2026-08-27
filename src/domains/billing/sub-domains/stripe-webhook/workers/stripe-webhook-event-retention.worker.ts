import { Worker } from 'bullmq';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import {
  getRetentionWorkerOptions,
  RETENTION_WORKER_CONCURRENCY,
} from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { STRIPE_WEBHOOK_EVENT_RETENTION_QUEUE_NAME } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook-event-retention.constants.js';
import { runStripeWebhookEventRetentionJob } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook-event-retention.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/maintenance-database.context.js';

/**
 * Purges terminal Stripe webhook ledger rows older than
 * `STRIPE_WEBHOOK_EVENT_RETENTION_DAYS`. Failed and in-flight rows are retained
 * for replay and ops investigation.
 *
 * @remarks
 * - **Algorithm:** BullMQ {@link Worker} bound to the retention queue. Each job
 *   runs {@link runStripeWebhookEventRetentionJob} inside
 *   {@link withSystemTableRetentionContext} so the delete uses the system-table
 *   retention context with a worker statement-timeout (sec-new-Q4); no
 *   organization GUC required.
 * - **Failure modes:** Stalled jobs are logged; processor errors propagate to
 *   BullMQ's retry/backoff for the retention queue family.
 * - **Side effects:** Hard-deletes rows from `billing.stripe_webhook_events`;
 *   keeps a Redis worker connection open until the returned
 *   {@link WorkerHandle} is closed.
 * - **Notes:** Repeatable cadence (typically daily) is registered in
 *   `src/infrastructure/queue/scheduler.ts`; concurrency tuning comes from
 *   `RETENTION_WORKER_CONCURRENCY`.
 */
export function createStripeWebhookEventRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    STRIPE_WEBHOOK_EVENT_RETENTION_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.system_table_retention, (databaseHandle) =>
        runStripeWebhookEventRetentionJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: STRIPE_WEBHOOK_EVENT_RETENTION_QUEUE_NAME },
      'stripe-webhook-event-retention.stalled',
    );
  });

  return buildWorkerHandle(worker, STRIPE_WEBHOOK_EVENT_RETENTION_QUEUE_NAME);
}
