import { lt } from 'drizzle-orm';
import { deleteInBatchesByCondition } from '@/infrastructure/database/utils/batch-delete.util.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { notifications } from '@/domains/notify/sub-domains/notification/notification.schema.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { env } from '@/shared/config/env.config.js';

/**
 * Hard-delete in-app notifications older than `NOTIFICATION_RETENTION_DAYS` in batches.
 *
 * @remarks
 * - **Algorithm:** computes a cutoff `now - retentionDays`, then delegates to
 *   `deleteInBatchesByCondition` which loops `id` chunks until exhaustion.
 * - **Failure modes:** RLS denials surface as `blockedCount`; batch errors propagate to the
 *   worker which surfaces them via DLQ/Sentry.
 * - **Side effects:** destructive `DELETE` against `notify.notifications`; structured logs at
 *   start and completion.
 * - **Notes:** runs under `withMaintenanceDatabaseContext` so cross-tenant rows are
 *   visible — never call this with a request-scoped handle.
 */
export async function runNotificationRetentionJob(databaseHandle: WorkerDatabaseHandle): Promise<{
  deletedCount: number;
  blockedCount: number;
}> {
  const retentionDays = env.NOTIFICATION_RETENTION_DAYS;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  logger.info(
    { retentionDays, cutoffDate: cutoffDate.toISOString() },
    'notification-retention.starting',
  );

  const { deletedCount, blockedCount } = await deleteInBatchesByCondition({
    databaseHandle,
    table: notifications,
    idColumn: notifications.id,
    whereCondition: lt(notifications.created_at, cutoffDate),
    logContext: 'notification-retention',
    tableLabel: 'notify.notifications',
  });

  logger.info({ deletedCount, blockedCount, retentionDays }, 'notification-retention.completed');

  return { deletedCount, blockedCount };
}
