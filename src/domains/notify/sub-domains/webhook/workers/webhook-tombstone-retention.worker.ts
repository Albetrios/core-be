import { Worker } from 'bullmq';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import {
  getRetentionWorkerOptions,
  RETENTION_WORKER_CONCURRENCY,
} from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { runWebhookTombstoneRetentionJob } from '@/domains/notify/sub-domains/webhook/workers/webhook-tombstone-retention.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { WEBHOOK_TOMBSTONE_RETENTION_QUEUE_NAME } from './webhook-tombstone-retention.constants.js';

/**
 * Hard-delete notification webhooks tombstoned longer than TOMBSTONE_RETENTION_DAYS.
 * Cascade removes webhook_delivery_attempts (FK ON DELETE CASCADE).
 * Repeatable schedule is registered in `src/infrastructure/queue/scheduler.ts`.
 *
 * @remarks
 * - **Algorithm:** wraps {@link runWebhookTombstoneRetentionJob} in
 *   `withMaintenanceDatabaseContext` so the BullMQ processor sees tombstones across
 *   tenants.
 * - **Failure modes:** stalled jobs are logged via the `stalled` listener; processor errors
 *   propagate through BullMQ retries and the queue DLQ.
 * - **Side effects:** registers a `Worker` against Redis using retention-tuned options
 *   (`RETENTION_WORKER_CONCURRENCY`, `getRetentionWorkerOptions`).
 * - **Notes:** the repeatable schedule lives in `infrastructure/queue/scheduler.ts`; this
 *   factory just returns the worker handle for graceful shutdown.
 */
export function createWebhookTombstoneRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    WEBHOOK_TOMBSTONE_RETENTION_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP, (databaseHandle) =>
        runWebhookTombstoneRetentionJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: WEBHOOK_TOMBSTONE_RETENTION_QUEUE_NAME },
      'webhook-tombstone-retention.stalled',
    );
  });

  return buildWorkerHandle(worker, WEBHOOK_TOMBSTONE_RETENTION_QUEUE_NAME);
}
