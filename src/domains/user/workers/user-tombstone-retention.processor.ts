import { and, isNotNull, lt } from 'drizzle-orm';
import { deleteInBatchesByCondition } from '@/infrastructure/database/utils/batch-delete.util.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { users } from '@/domains/user/user.schema.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { env } from '@/shared/config/env.config.js';

/**
 * Hard-delete `auth.users` rows that have been soft-deleted longer than
 * `TOMBSTONE_RETENTION_DAYS` so we honor the data-minimisation window.
 *
 * @remarks
 * - **Algorithm:** computes a cutoff of `now - TOMBSTONE_RETENTION_DAYS`, then delegates to
 *   `deleteInBatchesByCondition` to delete in bounded batches by id; rows still referenced by
 *   non-cascading FKs (e.g. an organization owner) increment `blockedCount` and remain in place
 *   for human cleanup.
 * - **Failure modes:** Postgres errors propagate to BullMQ for retry / DLQ; per-row FK violations
 *   are counted as blocked rather than failing the job.
 * - **Side effects:** deletes from `auth.users` (and any cascade-bound child tables), emits
 *   structured `info` start/end logs under `user-tombstone-retention.*`.
 * - **Notes:** runs inside `withMaintenanceDatabaseContext` (no per-tenant RLS) and is
 *   idempotent — re-running with no fresh tombstones is a no-op.
 */
export async function runUserTombstoneRetentionJob(databaseHandle: WorkerDatabaseHandle): Promise<{
  deletedCount: number;
  blockedCount: number;
}> {
  const retentionDays = env.TOMBSTONE_RETENTION_DAYS;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  logger.info(
    { retentionDays, cutoffDate: cutoffDate.toISOString() },
    'user-tombstone-retention.starting',
  );

  const { deletedCount, blockedCount } = await deleteInBatchesByCondition({
    databaseHandle,
    table: users,
    idColumn: users.id,
    whereCondition: and(isNotNull(users.deleted_at), lt(users.deleted_at, cutoffDate))!,
    logContext: 'user-tombstone-retention',
    tableLabel: 'auth.users',
  });

  logger.info({ deletedCount, blockedCount, retentionDays }, 'user-tombstone-retention.completed');

  return { deletedCount, blockedCount };
}
