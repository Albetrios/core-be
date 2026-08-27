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
import { runUserTombstoneRetentionJob } from '@/domains/user/workers/user-tombstone-retention.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { USER_TOMBSTONE_RETENTION_QUEUE_NAME } from './user-tombstone-retention.constants.js';

/**
 * Construct the BullMQ {@link Worker} that hard-deletes user tombstones older than
 * `TOMBSTONE_RETENTION_DAYS`.
 *
 * @remarks
 * - **Algorithm:** every scheduled tick wraps {@link runUserTombstoneRetentionJob} in
 *   `withMaintenanceDatabaseContext` so the cleanup runs against the global retention
 *   session (no per-tenant RLS).
 * - **Failure modes:** rows blocked by FK (e.g. an `organizations.owner_user_id` reference)
 *   surface as `blockedCount` and remain for human cleanup; unexpected Postgres errors propagate
 *   to BullMQ retries / DLQ; `stalled` events are warn-logged.
 * - **Side effects:** deletes from `auth.users` (cascading to child tables), drains Redis lease,
 *   logs job lifecycle.
 * - **Notes:** retention concurrency from `RETENTION_WORKER_CONCURRENCY`; repeatable schedule is
 *   registered in `src/infrastructure/queue/scheduler.ts` — never wire workers directly in
 *   `bootstrap.ts`.
 */
export function createUserTombstoneRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    USER_TOMBSTONE_RETENTION_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_retention_cleanup, (databaseHandle) =>
        runUserTombstoneRetentionJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: USER_TOMBSTONE_RETENTION_QUEUE_NAME },
      'user-tombstone-retention.stalled',
    );
  });

  return buildWorkerHandle(worker, USER_TOMBSTONE_RETENTION_QUEUE_NAME);
}
