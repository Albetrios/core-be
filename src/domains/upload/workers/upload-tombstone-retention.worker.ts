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
import { runUploadTombstoneRetentionJob } from '@/domains/upload/workers/upload-tombstone-retention.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { UPLOAD_TOMBSTONE_RETENTION_QUEUE_NAME } from './upload-tombstone-retention.constants.js';

/**
 * Hard-delete uploads tombstoned longer than TOMBSTONE_RETENTION_DAYS.
 * Removes S3 objects before deleting rows.
 *
 * @remarks
 * - **Algorithm:** wraps each job in
 *   {@link withMaintenanceDatabaseContext} (so RLS allows
 *   cross-tenant deletes) and delegates to {@link runUploadTombstoneRetentionJob}.
 * - **Failure modes:** processor errors are bubbled to BullMQ for retry;
 *   stalled jobs are surfaced via a `stalled` log warning. DLQ + Sentry hook
 *   is attached by the queue bootstrap.
 * - **Side effects:** none beyond what the processor performs (DB hard-deletes
 *   + best-effort S3 object deletes).
 * - **Notes:** concurrency capped at {@link RETENTION_WORKER_CONCURRENCY};
 *   stall/lock tuning from {@link getRetentionWorkerOptions} accommodates
 *   long purge runs.
 */
export function createUploadTombstoneRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    UPLOAD_TOMBSTONE_RETENTION_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP, (databaseHandle) =>
        runUploadTombstoneRetentionJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: UPLOAD_TOMBSTONE_RETENTION_QUEUE_NAME },
      'upload-tombstone-retention.stalled',
    );
  });

  return buildWorkerHandle(worker, UPLOAD_TOMBSTONE_RETENTION_QUEUE_NAME);
}
