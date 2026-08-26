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
import { runOrganizationApiKeyTombstoneRetentionJob } from '@/domains/tenancy/sub-domains/organization/organization-api-key/workers/organization-api-key-tombstone-retention.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { ORGANIZATION_API_KEY_TOMBSTONE_RETENTION_QUEUE_NAME } from './organization-api-key-tombstone-retention.constants.js';

/**
 * Hard-delete API keys tombstoned longer than TOMBSTONE_RETENTION_DAYS.
 *
 * @remarks
 * - **Algorithm:** subscribes to {@link ORGANIZATION_API_KEY_TOMBSTONE_RETENTION_QUEUE_NAME}
 *   and runs {@link runOrganizationApiKeyTombstoneRetentionJob} inside the
 *   global retention-cleanup DB context per delivered job.
 * - **Failure modes:** stalled jobs are logged and retried per BullMQ stall
 *   policy; final-failure DLQ + Sentry are wired by `infrastructure/queue`.
 * - **Side effects:** permanent API-key deletions in `tenancy.api_keys`.
 * - **Notes:** the repeatable cron is registered in
 *   `src/infrastructure/queue/scheduler.ts`; the worker is instantiated by
 *   the worker bootstrap rather than wired directly.
 */
export function createOrganizationApiKeyTombstoneRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    ORGANIZATION_API_KEY_TOMBSTONE_RETENTION_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_retention_cleanup, (databaseHandle) =>
        runOrganizationApiKeyTombstoneRetentionJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: ORGANIZATION_API_KEY_TOMBSTONE_RETENTION_QUEUE_NAME },
      'organization-api-key-tombstone-retention.stalled',
    );
  });

  return buildWorkerHandle(worker, ORGANIZATION_API_KEY_TOMBSTONE_RETENTION_QUEUE_NAME);
}
