import { and, inArray, isNotNull, lt } from 'drizzle-orm';
import { user_data_exports } from '@/domains/user/sub-domains/user-data-export/user-data-export.schema.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { deleteObject } from '@/infrastructure/storage/storage.service.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

const PURGE_BATCH_SIZE = 500;

/**
 * Purge GDPR export rows whose presigned download window has elapsed and remove the matching S3
 * objects (defense-in-depth alongside the bucket lifecycle policy).
 *
 * @remarks
 * - **Algorithm:** loop in batches of `PURGE_BATCH_SIZE` (500); each batch selects expired rows
 *   that still have an `s3_key`, deletes the S3 object, then deletes the row by id; exits when a
 *   batch comes back smaller than the limit.
 * - **Failure modes:** S3 delete failures are logged at `warn` and do not block the row delete
 *   (lifecycle rules will eventually reap the object); database errors propagate to BullMQ.
 * - **Side effects:** deletes from `auth.user_data_exports` and the S3 GDPR prefix; emits
 *   `info` start/end logs and per-failure `warn` logs.
 * - **Notes:** runs inside `withMaintenanceDatabaseContext` (no per-tenant RLS); idempotent
 *   — re-running yields zero deletions once cleanup is complete.
 */
export async function runUserDataExportRetentionJob(
  databaseHandle: WorkerDatabaseHandle,
): Promise<{ deletedCount: number }> {
  const cutoffDate = new Date();
  let deletedCount = 0;

  logger.info({ cutoffDate: cutoffDate.toISOString() }, 'user-data-export-retention.starting');

  for (;;) {
    const batch = await databaseHandle
      .select({
        id: user_data_exports.id,
        public_id: user_data_exports.public_id,
        s3_key: user_data_exports.s3_key,
      })
      .from(user_data_exports)
      .where(
        and(
          isNotNull(user_data_exports.expires_at),
          lt(user_data_exports.expires_at, cutoffDate),
          isNotNull(user_data_exports.s3_key),
        ),
      )
      .limit(PURGE_BATCH_SIZE);

    if (batch.length === 0) {
      break;
    }

    for (const row of batch) {
      const objectDeleted = await deleteObject(row.s3_key!);
      if (!objectDeleted) {
        logger.warn(
          { exportPublicId: row.public_id, s3Key: row.s3_key },
          'user-data-export-retention.s3ObjectDeleteFailed',
        );
      }
    }

    const identifiers = batch.map((row) => row.id);
    await databaseHandle
      .delete(user_data_exports)
      .where(inArray(user_data_exports.id, identifiers));
    deletedCount += batch.length;

    if (batch.length < PURGE_BATCH_SIZE) {
      break;
    }
  }

  logger.info({ deletedCount }, 'user-data-export-retention.completed');

  return { deletedCount };
}
