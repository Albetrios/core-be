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
import { runOrganizationTombstoneRetentionJob } from '@/domains/tenancy/sub-domains/organization/workers/organization-tombstone-retention.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { ORGANIZATION_TOMBSTONE_RETENTION_QUEUE_NAME } from './organization-tombstone-retention.constants.js';

/**
 * Hard-delete organizations tombstoned longer than TOMBSTONE_RETENTION_DAYS.
 * Child rows with ON DELETE CASCADE are removed with the organization.
 *
 * @remarks
 * - **Algorithm:** subscribes to {@link ORGANIZATION_TOMBSTONE_RETENTION_QUEUE_NAME}
 *   and runs {@link runOrganizationTombstoneRetentionJob} inside the global
 *   retention-cleanup DB context per delivered job.
 * - **Failure modes:** stalled jobs are logged and retried per BullMQ stall
 *   policy; final-failure DLQ + Sentry are wired by `infrastructure/queue`.
 * - **Side effects:** permanent organization deletions; cascades through
 *   memberships, settings, API keys, notification policies, and audit refs.
 * - **Notes:** repeatable schedule is registered in
 *   `src/infrastructure/queue/scheduler.ts`; instantiated by the worker
 *   bootstrap, never wired in `bootstrap.ts` directly.
 */
export function createOrganizationTombstoneRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    ORGANIZATION_TOMBSTONE_RETENTION_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_retention_cleanup, (databaseHandle) =>
        runOrganizationTombstoneRetentionJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: ORGANIZATION_TOMBSTONE_RETENTION_QUEUE_NAME },
      'organization-tombstone-retention.stalled',
    );
  });

  return buildWorkerHandle(worker, ORGANIZATION_TOMBSTONE_RETENTION_QUEUE_NAME);
}
