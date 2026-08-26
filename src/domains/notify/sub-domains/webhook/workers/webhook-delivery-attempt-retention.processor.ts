import { lt } from 'drizzle-orm';
import { deleteInBatchesByCondition } from '@/infrastructure/database/utils/batch-delete.util.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { webhook_delivery_attempts } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { env } from '@/shared/config/env.config.js';

/**
 * Hard-delete webhook delivery attempts older than `WEBHOOK_DELIVERY_ATTEMPT_RETENTION_DAYS`
 * in batches (audit-#3).
 *
 * @remarks
 * - **Algorithm:** computes a cutoff `now - retentionDays`, then delegates to
 *   `deleteInBatchesByCondition` which loops `id` chunks until exhaustion (bounded per batch).
 * - **Failure modes:** rows blocked by RLS surface as `blockedCount`; database errors propagate
 *   to the worker for DLQ/Sentry handling.
 * - **Side effects:** destructive `DELETE` against `notify.webhook_delivery_attempts`; structured
 *   logs at start and completion.
 * - **Notes:** previously the ONLY purge of this table was the FK cascade when a parent webhook
 *   was tombstone-deleted, so attempts for long-lived ACTIVE webhooks accumulated forever (each
 *   row retains the full event `payload` and `response_body` — unbounded growth + indefinite PII
 *   retention). This time-based sweep closes that gap. Runs under
 *   `withMaintenanceDatabaseContext` so it sees rows across tenants — never call it
 *   with a request-scoped handle.
 */
export async function runWebhookDeliveryAttemptRetentionJob(
  databaseHandle: WorkerDatabaseHandle,
): Promise<{
  deletedCount: number;
  blockedCount: number;
}> {
  const retentionDays = env.WEBHOOK_DELIVERY_ATTEMPT_RETENTION_DAYS;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  logger.info(
    { retentionDays, cutoffDate: cutoffDate.toISOString() },
    'webhook-delivery-attempt-retention.starting',
  );

  const { deletedCount, blockedCount } = await deleteInBatchesByCondition({
    databaseHandle,
    table: webhook_delivery_attempts,
    idColumn: webhook_delivery_attempts.id,
    whereCondition: lt(webhook_delivery_attempts.created_at, cutoffDate),
    logContext: 'webhook-delivery-attempt-retention',
    tableLabel: 'notify.webhook_delivery_attempts',
  });

  logger.info(
    { deletedCount, blockedCount, retentionDays },
    'webhook-delivery-attempt-retention.completed',
  );

  return { deletedCount, blockedCount };
}
