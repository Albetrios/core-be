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
import { runUploadPendingSweepJob } from '@/domains/upload/workers/upload-pending-sweep.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { UPLOAD_PENDING_SWEEP_QUEUE_NAME } from './upload-pending-sweep.constants.js';

/**
 * Reconciles orphan PENDING uploads (presigned URL issued, confirm never called).
 * Repeatable schedule: src/infrastructure/queue/scheduler.ts.
 *
 * @remarks
 * - **Algorithm:** wraps each job in
 *   {@link withMaintenanceDatabaseContext} so RLS allows
 *   cross-tenant scans, then delegates to {@link runUploadPendingSweepJob}.
 * - **Failure modes:** processor errors are bubbled to BullMQ for retry;
 *   stalled jobs are surfaced via a `stalled` log warning. The DLQ + Sentry
 *   hook is attached by the queue bootstrap.
 * - **Side effects:** none beyond what the processor performs (DB writes +
 *   best-effort S3 deletes).
 * - **Notes:** concurrency capped at {@link RETENTION_WORKER_CONCURRENCY};
 *   stall/lock tuning from {@link getRetentionWorkerOptions} accommodates
 *   batch durations that include S3 latency.
 */
export function createUploadPendingSweepWorker(): WorkerHandle {
  const worker = new Worker(
    UPLOAD_PENDING_SWEEP_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP, (databaseHandle) =>
        runUploadPendingSweepJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn({ jobId, queue: UPLOAD_PENDING_SWEEP_QUEUE_NAME }, 'upload-pending-sweep.stalled');
  });

  return buildWorkerHandle(worker, UPLOAD_PENDING_SWEEP_QUEUE_NAME);
}
