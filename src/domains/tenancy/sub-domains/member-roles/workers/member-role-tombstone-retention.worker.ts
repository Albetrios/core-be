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
import { runMemberRoleTombstoneRetentionJob } from '@/domains/tenancy/sub-domains/member-roles/workers/member-role-tombstone-retention.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { MEMBER_ROLE_TOMBSTONE_RETENTION_QUEUE_NAME } from './member-role-tombstone-retention.constants.js';

/**
 * Hard-delete roles tombstoned longer than TOMBSTONE_RETENTION_DAYS.
 * tenancy.role_permissions rows cascade via FK ON DELETE CASCADE.
 *
 * @remarks
 * - **Algorithm:** constructs a BullMQ `Worker` for the
 *   `MEMBER_ROLE_TOMBSTONE_RETENTION_QUEUE_NAME` queue that runs
 *   {@link runMemberRoleTombstoneRetentionJob} under
 *   {@link withMaintenanceDatabaseContext} so the cleanup bypasses
 *   per-organization RLS.
 * - **Failure modes:** processor exceptions trigger BullMQ retry/backoff;
 *   stalled jobs are logged via the `stalled` listener; the queue's DLQ
 *   captures permanently failed jobs.
 * - **Side effects:** opens a BullMQ Redis connection; takes a dedicated
 *   Postgres handle for each job; emits info/warn logs.
 * - **Notes:** registered in the worker registry rather than wired directly in
 *   `bootstrap.ts`; concurrency and stall settings come from
 *   {@link getRetentionWorkerOptions} and {@link RETENTION_WORKER_CONCURRENCY}.
 */
export function createMemberRoleTombstoneRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    MEMBER_ROLE_TOMBSTONE_RETENTION_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP, (databaseHandle) =>
        runMemberRoleTombstoneRetentionJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: MEMBER_ROLE_TOMBSTONE_RETENTION_QUEUE_NAME },
      'member-role-tombstone-retention.stalled',
    );
  });

  return buildWorkerHandle(worker, MEMBER_ROLE_TOMBSTONE_RETENTION_QUEUE_NAME);
}
