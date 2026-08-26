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
import { USER_DATA_EXPORT_RETENTION_QUEUE_NAME } from '@/domains/user/sub-domains/user-data-export/workers/user-data-export-retention.constants.js';
import { runUserDataExportRetentionJob } from '@/domains/user/sub-domains/user-data-export/workers/user-data-export-retention.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';

/**
 * Construct the BullMQ {@link Worker} that runs {@link runUserDataExportRetentionJob} on the
 * repeatable schedule registered in `src/infrastructure/queue/scheduler.ts`.
 *
 * @remarks
 * - **Algorithm:** every scheduled tick wraps the processor in
 *   `withMaintenanceDatabaseContext`, which strips per-tenant RLS so the cleanup runs
 *   against the global retention session.
 * - **Failure modes:** unexpected errors propagate to BullMQ retries / DLQ; `stalled` events are
 *   logged for observability.
 * - **Side effects:** Redis (queue lease), Postgres (row deletes), S3 (object deletes), logger.
 * - **Notes:** retention concurrency from `RETENTION_WORKER_CONCURRENCY`; defense-in-depth with
 *   the S3 bucket lifecycle so a misconfigured bucket cannot retain export bundles indefinitely.
 */
export function createUserDataExportRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    USER_DATA_EXPORT_RETENTION_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_retention_cleanup, (databaseHandle) =>
        runUserDataExportRetentionJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: USER_DATA_EXPORT_RETENTION_QUEUE_NAME },
      'user-data-export-retention.stalled',
    );
  });

  return buildWorkerHandle(worker, USER_DATA_EXPORT_RETENTION_QUEUE_NAME);
}
