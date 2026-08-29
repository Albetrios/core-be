import { dispatchOutboxEmail } from '@/infrastructure/mail/queues/mail.queue.js';
import { NotificationRepository } from '@/domains/notify/sub-domains/notification/notification.repository.js';
import { enqueueNotification } from '@/domains/notify/sub-domains/notification/queues/notification.queue.js';
import { enqueueUserDataExport } from '@/domains/user/sub-domains/user-data-export/queues/user-data-export.queue.js';
import { createWorkerUserDataExportRepository } from '@/domains/user/sub-domains/user-data-export/user-data-export.repository.js';
import { USER_DATA_EXPORT_STATUSES } from '@/domains/user/sub-domains/user-data-export/user-data-export.types.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { CommitDispatchTask } from '@/infrastructure/queue/commit-dispatch/commit-dispatch.types.js';
import {
  MAINTENANCE_SCOPE,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

/**
 * Executes one durable post-commit task.
 *
 * @remarks
 * - **Algorithm:** switch on `task.type` and delegate to the matching enqueue helper.
 * - **Failure modes:** notification enqueue failure deletes the orphan row; export enqueue failure marks the export failed.
 * - **Side effects:** may enqueue BullMQ jobs or mutate Postgres rows on failure cleanup.
 * - **Notes:** idempotent — safe for recovery sweeper replay.
 */
export async function executeCommitDispatchTask(task: CommitDispatchTask): Promise<void> {
  switch (task.type) {
    case 'mail_outbox':
      if (task.requestId !== undefined) {
        await dispatchOutboxEmail(task.mailOutboxId, { requestId: task.requestId });
      } else {
        await dispatchOutboxEmail(task.mailOutboxId);
      }
      return;
    case 'notification':
      try {
        await enqueueNotification(task.notificationId, task.organizationPublicId);
      } catch (error) {
        logger.error(
          { error, notificationId: task.notificationId },
          'commit-dispatch.notification.enqueue_failed',
        );
        // Wrap in a system-table worker context so the cleanup write succeeds when this
        // path runs under the commit-dispatch-recovery worker, which is registered
        // `usesPostgres: false` and would otherwise trip `assertWorkerDatabaseContext`
        // from `resolveRepositoryDatabaseHandle(undefined)`. The outer catch in
        // `commit-dispatch-recovery.processor.ts` would silently swallow that secondary
        // error and leave the orphan notification row in Postgres.
        await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.SYSTEM_TABLE_WORKER, () =>
          new NotificationRepository().deleteByInternalId(task.notificationId),
        );
      }
      return;
    case 'user_data_export':
      try {
        await enqueueUserDataExport({
          exportPublicId: task.exportPublicId,
          userPublicId: task.userPublicId,
          userInternalId: task.userInternalId,
        });
      } catch (error) {
        logger.error(
          { error, exportPublicId: task.exportPublicId, userPublicId: task.userPublicId },
          'commit-dispatch.user_data_export.enqueue_failed',
        );
        await withAppDatabaseContext(
          PRINCIPAL_SCOPE.VERIFIED({ userPublicId: task.userPublicId }),
          async (databaseHandle) => {
            const exportRepository = createWorkerUserDataExportRepository(databaseHandle);
            await exportRepository.updateStatus(task.exportPublicId, task.userInternalId, {
              status: USER_DATA_EXPORT_STATUSES.FAILED,
              failed_at: new Date(),
              error_code: 'enqueue_failed',
            });
          },
        );
      }
      return;
    default: {
      const exhaustiveCheck: never = task;
      throw new Error(`Unknown commit dispatch task: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
