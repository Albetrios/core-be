import { Worker } from 'bullmq';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/maintenance-database.context.js';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import {
  getRetentionWorkerOptions,
  RETENTION_WORKER_CONCURRENCY,
} from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { WEBHOOK_DELIVERY_ATTEMPT_RETENTION_QUEUE_NAME } from '@/domains/notify/sub-domains/webhook/workers/webhook-delivery-attempt-retention.constants.js';
import { runWebhookDeliveryAttemptRetentionJob } from '@/domains/notify/sub-domains/webhook/workers/webhook-delivery-attempt-retention.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * Hard-deletes webhook delivery attempts older than WEBHOOK_DELIVERY_ATTEMPT_RETENTION_DAYS
 * (audit-#3). Repeatable schedule is registered in `src/infrastructure/queue/scheduler.ts`.
 *
 * @remarks
 * - **Algorithm:** wraps {@link runWebhookDeliveryAttemptRetentionJob} in
 *   `withMaintenanceDatabaseContext` so the BullMQ processor sees cross-tenant rows.
 * - **Failure modes:** stalled jobs are logged via the `stalled` listener; processor errors
 *   propagate through BullMQ retries and the queue DLQ.
 * - **Side effects:** registers a `Worker` against Redis with retention-tuned options
 *   (`RETENTION_WORKER_CONCURRENCY`, `getRetentionWorkerOptions`).
 * - **Notes:** the repeatable schedule lives in `infrastructure/queue/scheduler.ts`; this factory
 *   just returns the worker handle for graceful shutdown.
 */
export function createWebhookDeliveryAttemptRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    WEBHOOK_DELIVERY_ATTEMPT_RETENTION_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_retention_cleanup, (databaseHandle) =>
        runWebhookDeliveryAttemptRetentionJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: WEBHOOK_DELIVERY_ATTEMPT_RETENTION_QUEUE_NAME },
      'webhook-delivery-attempt-retention.stalled',
    );
  });

  return buildWorkerHandle(worker, WEBHOOK_DELIVERY_ATTEMPT_RETENTION_QUEUE_NAME);
}
