import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import {
  findPendingUploadsOlderThan,
  hardDeleteUploadsByInternalIds,
  markConfirmedByInternalId,
  setUploadStatusByInternalId,
  type PendingUploadSweepRow,
} from '@/domains/upload/upload.repository.js';
import {
  copyObject,
  deleteObject,
  getObjectLeadingBytes,
  headObjectResult,
} from '@/infrastructure/storage/storage.service.js';
import { PRESIGNED_URL_EXPIRY_SECONDS } from '@/shared/constants/ttl.constants.js';
import { env } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  isMagicByteVerifiable,
  verifyFileMagicBytes,
} from '@/shared/utils/validation/file-magic.util.js';
import { UPLOAD_PENDING_SWEEP_BATCH_SIZE } from './upload-pending-sweep.constants.js';
import { isSvgContentType } from '@/domains/upload/utils/upload-svg.util.js';
import {
  UPLOAD_PENDING_KEY_PREFIX,
  stripPendingObjectKeyPrefix,
} from '@/domains/upload/upload.constants.js';

/**
 * Outcome counters for one {@link runUploadPendingSweepJob} run.
 *
 * @remarks
 * - **scannedCount:** stale PENDING rows considered in this batch.
 * - **autoConfirmedCount:** rows whose S3 object existed with a matching
 *   length/content-type and were transitioned to `UPLOADED`.
 * - **failedCount:** rows whose S3 object existed but with metadata mismatch;
 *   transitioned to `FAILED` so they can never be attached.
 * - **deletedCount:** orphan rows whose S3 object was explicitly not found; hard-deleted
 *   after a best-effort S3 delete.
 * - **transientCount:** rows skipped because the S3 HEAD failed transiently (audit-#5);
 *   left PENDING for the next scheduled sweep rather than destructively orphaned.
 */
export type UploadPendingSweepResult = {
  scannedCount: number;
  autoConfirmedCount: number;
  failedCount: number;
  deletedCount: number;
  transientCount: number;
};

/**
 * Reconciles stale PENDING uploads — clients that obtained a presigned URL but never
 * called confirm. For each candidate row past the grace window:
 *
 * - Object exists with matching size  → mark UPLOADED (auto-confirm).
 * - Object exists with mismatched size → mark FAILED (will not be attachable).
 * - Object missing                    → hard-delete the orphan row (idempotent S3 delete first).
 *
 * Runs under withMaintenanceDatabaseContext so RLS does not block cross-tenant rows.
 *
 * @remarks
 * - **Algorithm:** cutoff = now − (`PRESIGNED_URL_EXPIRY_SECONDS` +
 *   `UPLOAD_PENDING_SWEEP_GRACE_SECONDS`). Selects up to
 *   {@link UPLOAD_PENDING_SWEEP_BATCH_SIZE} oldest PENDING rows older than
 *   the cutoff, HEADs each S3 object, and applies the verdict (auto-confirm,
 *   fail, or orphan-delete) in a single pass.
 * - **Failure modes:** transient S3 errors during HEAD or DELETE are logged
 *   at `warn` and the row is left for the next sweep (no row is hard-deleted
 *   unless the object was confirmed missing). Repository errors bubble to
 *   BullMQ for retry.
 * - **Side effects:** updates `upload.uploads` status, deletes orphan rows,
 *   and may delete leftover S3 objects. No events emitted.
 * - **Notes:** batch-scoped — large backlogs drain over multiple repeats.
 *   Caller (worker) supplies the database handle from the global-retention
 *   context so RLS does not filter cross-tenant rows.
 */
export async function runUploadPendingSweepJob(
  databaseHandle: WorkerDatabaseHandle,
): Promise<UploadPendingSweepResult> {
  const graceSeconds = env.UPLOAD_PENDING_SWEEP_GRACE_SECONDS;
  const cutoffMs = Date.now() - (PRESIGNED_URL_EXPIRY_SECONDS + graceSeconds) * 1000;
  const cutoffDate = new Date(cutoffMs);

  const rows = await findPendingUploadsOlderThan(
    databaseHandle,
    cutoffDate,
    UPLOAD_PENDING_SWEEP_BATCH_SIZE,
  );

  logger.info(
    {
      scannedCount: rows.length,
      cutoffDate: cutoffDate.toISOString(),
      graceSeconds,
      batchSize: UPLOAD_PENDING_SWEEP_BATCH_SIZE,
    },
    'upload-pending-sweep.starting',
  );

  let autoConfirmedCount = 0;
  let failedCount = 0;
  let transientCount = 0;
  const idsToHardDelete: number[] = [];

  for (const row of rows) {
    const verdict = await resolvePendingUploadVerdict(row);
    if (verdict === 'auto_confirm') {
      // sec-UP finding #20: the HTTP confirm path enforces "a servable row never
      // references the overwritable `pending/` key once it is servable" (sec-UP1).
      // The sweep previously skipped this invariant — flipping status to UPLOADED
      // while leaving `file_key` pointing at the still-overwritable pending object,
      // which an S3 lifecycle policy on `pending/*` (a textbook cost-reclaim
      // practice operators routinely add) would expire out from under the row.
      // Copy bytes to the final key and rewrite `file_key` in the same UPDATE.
      const finalKey = stripPendingObjectKeyPrefix(row.file_key);
      try {
        await copyObject({
          sourceKey: row.file_key,
          destinationKey: finalKey,
          contentType: row.mime_type,
        });
      } catch (copyError) {
        logger.warn(
          { uploadId: row.id, fileKey: row.file_key, error: copyError },
          'upload-pending-sweep.copyToFinalKeyFailed',
        );
        continue;
      }
      await markConfirmedByInternalId(databaseHandle, row.id, finalKey);
      // Best-effort cleanup of the pending bytes; the row is already servable
      // off the final key so a transient delete failure is logged-only.
      const pendingDeleted = await deleteObject(row.file_key);
      if (!pendingDeleted) {
        logger.warn(
          { uploadId: row.id, pendingKey: row.file_key },
          'upload-pending-sweep.pendingDeleteFailedAfterPublish',
        );
      }
      autoConfirmedCount += 1;
      logger.info(
        { uploadId: row.id, pendingKey: row.file_key, finalKey },
        'upload-pending-sweep.autoConfirmed',
      );
    } else if (verdict === 'fail') {
      await setUploadStatusByInternalId(databaseHandle, row.id, 'FAILED');
      failedCount += 1;
      logger.warn(
        { uploadId: row.id, fileKey: row.file_key },
        'upload-pending-sweep.metadataMismatch',
      );
    } else if (verdict === 'transient') {
      // audit-#5: a transient HEAD failure (timeout / throttle / circuit-open / IAM) is NOT
      // proof the object is missing. Leave the row PENDING so the next scheduled sweep
      // re-evaluates it; never hard-delete on an outage.
      transientCount += 1;
      logger.warn(
        { uploadId: row.id, fileKey: row.file_key },
        'upload-pending-sweep.transientHeadSkipped',
      );
    } else {
      // Object explicitly not found — remove any leftover S3 byte (idempotent) and queue the DB delete.
      const deleted = await deleteObject(row.file_key);
      if (!deleted) {
        logger.warn(
          { uploadId: row.id, fileKey: row.file_key },
          'upload-pending-sweep.s3DeleteFailed',
        );
      }
      idsToHardDelete.push(row.id);
    }
  }

  const deletedCount = await hardDeleteUploadsByInternalIds(databaseHandle, idsToHardDelete);

  logger.info(
    { scannedCount: rows.length, autoConfirmedCount, failedCount, deletedCount, transientCount },
    'upload-pending-sweep.completed',
  );

  return {
    scannedCount: rows.length,
    autoConfirmedCount,
    failedCount,
    deletedCount,
    transientCount,
  };
}

type PendingUploadVerdict = 'auto_confirm' | 'fail' | 'orphan' | 'transient';

async function resolvePendingUploadVerdict(
  row: PendingUploadSweepRow,
): Promise<PendingUploadVerdict> {
  // sec-UP finding #20: refuse rows whose `file_key` is not prefixed with the
  // pending namespace. The HTTP confirm path makes the same assertion (sec-UP1)
  // because a row that never went through the pending-key indirection has
  // bypassed the entire publish ceremony. Auto-confirming such a row in the
  // sweep would silently launder it into the UPLOADED state.
  if (!row.file_key.startsWith(UPLOAD_PENDING_KEY_PREFIX)) {
    logger.warn(
      { uploadId: row.id, fileKey: row.file_key },
      'upload-pending-sweep.non_pending_key_refused',
    );
    return 'fail';
  }
  // sec-UP2: the sweep would auto-confirm SVG by setting status=UPLOADED
  // WITHOUT running the publish path that DOMPurifies SVG bytes and copies
  // them off the pending (still client-writable) key. Refuse to auto-
  // confirm SVG; the user must explicitly call confirm (which DOES go
  // through publishConfirmedObject + sanitizer + pending→final copy).
  if (isSvgContentType(row.mime_type)) {
    return 'fail';
  }
  // audit-#5: distinguish an explicit not-found (safe to orphan-delete) from a transient
  // storage outage. The prior `headObject(...) ?? null → orphan` mapping let a timeout /
  // throttle / circuit-open hard-delete a perfectly valid pending row (and its S3 bytes)
  // across an entire sweep batch. A transient result leaves the row PENDING for the next
  // scheduled sweep instead.
  const head = await headObjectResult(row.file_key);
  if (head.kind === 'transient_error') {
    return 'transient';
  }
  if (head.kind === 'not_found' || head.metadata.contentLength === undefined) {
    return 'orphan';
  }
  const metadata = head.metadata;
  const lengthMatches = metadata.contentLength === row.file_size;
  // S3 may not echo a content-type; only fail on type when one is reported.
  const typeMatches = metadata.contentType === undefined || metadata.contentType === row.mime_type;
  if (!(lengthMatches && typeMatches)) {
    return 'fail';
  }
  if (isMagicByteVerifiable(row.mime_type)) {
    try {
      const object = await getObjectLeadingBytes(row.file_key);
      if (object === null || !verifyFileMagicBytes(object.body, row.mime_type)) {
        return 'fail';
      }
    } catch (error) {
      logger.warn(
        { uploadId: row.id, fileKey: row.file_key, error },
        'upload-pending-sweep.magicByteVerifyFailed',
      );
      return 'fail';
    }
  }
  return 'auto_confirm';
}
