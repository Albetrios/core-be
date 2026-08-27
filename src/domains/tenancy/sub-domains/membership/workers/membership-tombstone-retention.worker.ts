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
import { runMembershipTombstoneRetentionJob } from '@/domains/tenancy/sub-domains/membership/workers/membership-tombstone-retention.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { MEMBERSHIP_TOMBSTONE_RETENTION_QUEUE_NAME } from './membership-tombstone-retention.constants.js';

/**
 * Hard-delete memberships tombstoned longer than TOMBSTONE_RETENTION_DAYS.
 *
 * @remarks
 * - **Algorithm:** constructs a BullMQ `Worker` for the
 *   `MEMBERSHIP_TOMBSTONE_RETENTION_QUEUE_NAME` queue that invokes
 *   {@link runMembershipTombstoneRetentionJob} inside
 *   {@link withMaintenanceDatabaseContext} so RLS is bypassed for
 *   the cleanup.
 * - **Failure modes:** processor exceptions feed BullMQ retry/backoff; stalled
 *   jobs are logged via the `stalled` listener; permanent failures land in
 *   the queue DLQ.
 * - **Side effects:** opens a BullMQ Redis connection and a Postgres handle
 *   per job; emits info/warn logs.
 * - **Notes:** registered through the worker registry — never wire directly
 *   in `bootstrap.ts`. Concurrency and stall tuning come from
 *   {@link getRetentionWorkerOptions} / {@link RETENTION_WORKER_CONCURRENCY}.
 */
export function createMembershipTombstoneRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    MEMBERSHIP_TOMBSTONE_RETENTION_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_retention_cleanup, (databaseHandle) =>
        runMembershipTombstoneRetentionJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: MEMBERSHIP_TOMBSTONE_RETENTION_QUEUE_NAME },
      'membership-tombstone-retention.stalled',
    );
  });

  return buildWorkerHandle(worker, MEMBERSHIP_TOMBSTONE_RETENTION_QUEUE_NAME);
}
