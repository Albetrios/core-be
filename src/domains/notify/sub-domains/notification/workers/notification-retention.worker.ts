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
import { NOTIFICATION_RETENTION_QUEUE_NAME } from '@/domains/notify/sub-domains/notification/workers/notification-retention.constants.js';
import { runNotificationRetentionJob } from '@/domains/notify/sub-domains/notification/workers/notification-retention.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * Hard-deletes in-app notifications older than NOTIFICATION_RETENTION_DAYS.
 * Repeatable schedule is registered in `src/infrastructure/queue/scheduler.ts`.
 *
 * @remarks
 * - **Algorithm:** wraps {@link runNotificationRetentionJob} in
 *   `withMaintenanceDatabaseContext` so the BullMQ processor sees cross-tenant rows.
 * - **Failure modes:** stalled jobs are logged via the `stalled` listener; processor errors
 *   propagate through BullMQ retries and the queue DLQ.
 * - **Side effects:** registers a `Worker` against Redis with retention-tuned options
 *   (`RETENTION_WORKER_CONCURRENCY`, `getRetentionWorkerOptions`).
 * - **Notes:** the repeatable schedule lives in `infrastructure/queue/scheduler.ts`; this
 *   factory just returns the worker handle for graceful shutdown.
 */
export function createNotificationRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    NOTIFICATION_RETENTION_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP, (databaseHandle) =>
        runNotificationRetentionJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: NOTIFICATION_RETENTION_QUEUE_NAME },
      'notification-retention.stalled',
    );
  });

  return buildWorkerHandle(worker, NOTIFICATION_RETENTION_QUEUE_NAME);
}
