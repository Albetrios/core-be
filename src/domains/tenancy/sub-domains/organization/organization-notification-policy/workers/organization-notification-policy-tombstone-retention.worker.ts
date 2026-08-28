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
import { runOrganizationNotificationPolicyTombstoneRetentionJob } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/workers/organization-notification-policy-tombstone-retention.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { ORGANIZATION_NOTIFICATION_POLICY_TOMBSTONE_RETENTION_QUEUE_NAME } from './organization-notification-policy-tombstone-retention.constants.js';

/**
 * Hard-delete organization notification policy tombstones older than TOMBSTONE_RETENTION_DAYS.
 * Repeatable schedule is registered in `src/infrastructure/queue/scheduler.ts`.
 *
 * @remarks
 * - **Algorithm:** subscribes to {@link ORGANIZATION_NOTIFICATION_POLICY_TOMBSTONE_RETENTION_QUEUE_NAME}
 *   and runs {@link runOrganizationNotificationPolicyTombstoneRetentionJob}
 *   inside the global retention-cleanup DB context per delivered job.
 * - **Failure modes:** stalled jobs are logged and retried per BullMQ stall
 *   policy; final-failure DLQ + Sentry are wired by `infrastructure/queue`.
 * - **Side effects:** permanent deletes from
 *   `tenancy.organization_notification_policies`.
 * - **Notes:** instantiated by the worker bootstrap; never wired directly
 *   in `bootstrap.ts`.
 */
export function createOrganizationNotificationPolicyTombstoneRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    ORGANIZATION_NOTIFICATION_POLICY_TOMBSTONE_RETENTION_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP, (databaseHandle) =>
        runOrganizationNotificationPolicyTombstoneRetentionJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn(
      { jobId, queue: ORGANIZATION_NOTIFICATION_POLICY_TOMBSTONE_RETENTION_QUEUE_NAME },
      'organization-notification-policy-tombstone-retention.stalled',
    );
  });

  return buildWorkerHandle(worker, ORGANIZATION_NOTIFICATION_POLICY_TOMBSTONE_RETENTION_QUEUE_NAME);
}
