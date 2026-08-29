import { and, asc, count, eq, gt, inArray, isNull, lt, sql as drizzleSql } from 'drizzle-orm';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { databaseNowTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { uploads } from '@/domains/upload/upload.schema.js';
import {
  UPLOAD_PENDING_ORGANIZATION_QUOTA_ADVISORY_LOCK_NAMESPACE,
  UPLOAD_PENDING_QUOTA_ADVISORY_LOCK_NAMESPACE,
  UPLOAD_STATUS,
} from '@/domains/upload/upload.constants.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';

/** Drizzle-inferred select row shape for the `upload.uploads` table. */
export type UploadRow = typeof uploads.$inferSelect;

/** Subset returned to the PENDING sweeper; avoids hauling unused metadata columns. */
export type PendingUploadSweepRow = Pick<
  UploadRow,
  'id' | 'public_id' | 'user_id' | 'file_key' | 'mime_type' | 'file_size' | 'created_at'
>;

/** Insert payload for {@link UploadRepository.create}; status defaults to `PENDING` when omitted. */
export interface UploadCreateData {
  user_id: number;
  organization_id?: number | null;
  file_name: string;
  file_key: string;
  mime_type: string;
  file_size: number;
  storage_provider: string;
  bucket: string;
  status?: string;
  created_by_user_id?: number;
}

/**
 * Data-access layer for `upload.uploads`. Owner-scoped reads/writes go through
 * the request database handle (RLS enforces user/organization isolation);
 * inserts retry on public-id collisions and lifecycle transitions are limited
 * to soft-delete + status updates so the row history stays auditable.
 */
export class UploadRepository {
  async create(data: UploadCreateData): Promise<UploadRow> {
    return runInsertWithPublicIdentifierRetry(async () => {
      const public_id = generatePublicId('upload');
      const rows = await getRequestDatabase()
        .insert(uploads)
        .values({
          public_id,
          user_id: data.user_id,
          organization_id: data.organization_id ?? null,
          file_name: data.file_name,
          file_key: data.file_key,
          mime_type: data.mime_type,
          file_size: data.file_size,
          storage_provider: data.storage_provider,
          bucket: data.bucket,
          status: data.status ?? 'PENDING',
          created_by_user_id: data.created_by_user_id ?? data.user_id,
        })
        .returning();
      return rows[0]!;
    });
  }

  async findByPublicId(public_id: string): Promise<UploadRow | null> {
    const rows = await getRequestDatabase()
      .select()
      .from(uploads)
      .where(and(eq(uploads.public_id, public_id), isNull(uploads.deleted_at)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findByFileKey(file_key: string): Promise<UploadRow | null> {
    const rows = await getRequestDatabase()
      .select()
      .from(uploads)
      .where(and(eq(uploads.file_key, file_key), isNull(uploads.deleted_at)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findByPublicIdForUser(public_id: string, user_id: number): Promise<UploadRow | null> {
    const rows = await getRequestDatabase()
      .select()
      .from(uploads)
      .where(
        and(
          eq(uploads.public_id, public_id),
          eq(uploads.user_id, user_id),
          isNull(uploads.deleted_at),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async softDelete(public_id: string, user_id: number): Promise<UploadRow | null> {
    const rows = await getRequestDatabase()
      .update(uploads)
      .set({ deleted_at: databaseNowTimestamp, updated_at: databaseNowTimestamp })
      .where(
        and(
          eq(uploads.public_id, public_id),
          eq(uploads.user_id, user_id),
          isNull(uploads.deleted_at),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async softDeleteByPublicId(public_id: string): Promise<UploadRow | null> {
    const rows = await getRequestDatabase()
      .update(uploads)
      .set({ deleted_at: databaseNowTimestamp, updated_at: databaseNowTimestamp })
      .where(and(eq(uploads.public_id, public_id), isNull(uploads.deleted_at)))
      .returning();
    return rows[0] ?? null;
  }

  async markStatus(public_id: string, user_id: number, status: string): Promise<UploadRow | null> {
    const rows = await getRequestDatabase()
      .update(uploads)
      .set({ status, updated_at: databaseNowTimestamp })
      .where(
        and(
          eq(uploads.public_id, public_id),
          eq(uploads.user_id, user_id),
          isNull(uploads.deleted_at),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async markStatusByPublicId(public_id: string, status: string): Promise<UploadRow | null> {
    const rows = await getRequestDatabase()
      .update(uploads)
      .set({ status, updated_at: databaseNowTimestamp })
      .where(and(eq(uploads.public_id, public_id), isNull(uploads.deleted_at)))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Transitions a PENDING upload to UPLOADED and repoints `file_key` to the final (immutable) key
   * the confirm step published the verified bytes to. One atomic update so the row never points at
   * the still-overwritable pending key once it is servable.
   */
  async markConfirmedByPublicId(public_id: string, file_key: string): Promise<UploadRow | null> {
    const rows = await getRequestDatabase()
      .update(uploads)
      .set({ status: UPLOAD_STATUS.UPLOADED, file_key, updated_at: databaseNowTimestamp })
      .where(and(eq(uploads.public_id, public_id), isNull(uploads.deleted_at)))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Takes a transaction-scoped advisory lock that serializes concurrent PENDING-quota
   * reservations for a single user. The lock is released automatically at COMMIT/ROLLBACK,
   * so it must be acquired inside the same transaction as the subsequent
   * {@link UploadRepository.countPendingByUserId} + {@link UploadRepository.create}
   * (e.g. within `withAppDatabaseContext (user scope)`). This closes the race where concurrent
   * create-upload requests each pass the pending-count check before any row is inserted.
   */
  async acquirePendingUploadQuotaLock(user_id: number): Promise<void> {
    await getRequestDatabase().execute(
      drizzleSql`SELECT pg_advisory_xact_lock(${UPLOAD_PENDING_QUOTA_ADVISORY_LOCK_NAMESPACE}::int, ${user_id}::int)`,
    );
  }

  /**
   * Transaction-scoped advisory lock that serializes concurrent PENDING-quota reservations
   * across ALL members of one organization (audit-#7). Must be acquired in the same
   * transaction as {@link UploadRepository.countPendingByOrganizationId} + the subsequent
   * {@link UploadRepository.create}, and BEFORE {@link acquirePendingUploadQuotaLock} (a
   * globally consistent organization-then-user order) so distinct users in the same organization cannot each
   * pass the organization count check before any row is inserted and burst past the organization cap.
   */
  async acquirePendingOrganizationQuotaLock(organization_id: number): Promise<void> {
    await getRequestDatabase().execute(
      drizzleSql`SELECT pg_advisory_xact_lock(${UPLOAD_PENDING_ORGANIZATION_QUOTA_ADVISORY_LOCK_NAMESPACE}::int, ${organization_id}::int)`,
    );
  }

  /** Number of in-flight PENDING uploads for a user (active, not soft-deleted). */
  async countPendingByUserId(user_id: number): Promise<number> {
    const rows = await getRequestDatabase()
      .select({ value: count() })
      .from(uploads)
      .where(
        and(
          eq(uploads.user_id, user_id),
          eq(uploads.status, 'PENDING'),
          isNull(uploads.deleted_at),
        ),
      );
    return rows[0]?.value ?? 0;
  }

  /**
   * Number of in-flight PENDING uploads aggregated across all members of an
   * organization (sec-UP4). Used by the service to enforce the
   * `UPLOAD_MAX_PENDING_PER_ORGANIZATION` cap so a single organization cannot
   * exhaust storage by piling per-user-cap-compliant PENDING rows across
   * many member accounts.
   */
  async countPendingByOrganizationId(organization_id: number): Promise<number> {
    const rows = await getRequestDatabase()
      .select({ value: count() })
      .from(uploads)
      .where(
        and(
          eq(uploads.organization_id, organization_id),
          eq(uploads.status, 'PENDING'),
          isNull(uploads.deleted_at),
        ),
      );
    return rows[0]?.value ?? 0;
  }

  /**
   * Active uploads for a user with `id > after_id`, ascending by id, capped at
   * `limit`. Used to stream a user's uploads in bounded keyset batches during
   * offboarding so object deletion never loads an unbounded result set.
   *
   * @remarks
   * sec-D12: the unbounded sibling (`findActiveByUserId` without a keyset
   * cursor) was deleted in PR-G35. Every production caller goes through this
   * paginated variant — re-adding the unbounded shape is a foot-gun for any
   * caller that eventually runs on a user with thousands of uploads.
   */
  async findActiveByUserIdAfter(
    user_id: number,
    after_id: number,
    limit: number,
  ): Promise<Pick<UploadRow, 'id' | 'file_key'>[]> {
    return getRequestDatabase()
      .select({ id: uploads.id, file_key: uploads.file_key })
      .from(uploads)
      .where(
        and(eq(uploads.user_id, user_id), gt(uploads.id, after_id), isNull(uploads.deleted_at)),
      )
      .orderBy(asc(uploads.id))
      .limit(limit);
  }

  /**
   * Keyset-paginated stream of active uploads for an organization, mirroring
   * {@link findActiveByUserIdAfter}. Used by the offboarding hook (sec-UP8)
   * so a large-tenant tombstone streams in bounded batches instead of
   * loading the entire set into memory and serialising thousands of S3
   * round-trips.
   *
   * @remarks
   * sec-D12: the unbounded sibling (`findActiveByOrganizationId` without a
   * keyset cursor) was deleted in PR-G35. The audit flagged it as a
   * future-trap — a caller that ran on a small organization today would silently
   * become an O(N) load once tenants grew. Re-adding the unbounded shape
   * requires re-arguing the size bound.
   */
  async findActiveByOrganizationIdAfter(
    organization_id: number,
    after_id: number,
    limit: number,
  ): Promise<Pick<UploadRow, 'id' | 'file_key'>[]> {
    return getRequestDatabase()
      .select({ id: uploads.id, file_key: uploads.file_key })
      .from(uploads)
      .where(
        and(
          eq(uploads.organization_id, organization_id),
          gt(uploads.id, after_id),
          isNull(uploads.deleted_at),
        ),
      )
      .orderBy(asc(uploads.id))
      .limit(limit);
  }

  async softDeleteAllByUserId(user_id: number): Promise<number> {
    const rows = await getRequestDatabase()
      .update(uploads)
      .set({ deleted_at: databaseNowTimestamp, updated_at: databaseNowTimestamp })
      .where(and(eq(uploads.user_id, user_id), isNull(uploads.deleted_at)))
      .returning({ id: uploads.id });
    return rows.length;
  }

  async softDeleteAllByOrganizationId(organization_id: number): Promise<number> {
    const rows = await getRequestDatabase()
      .update(uploads)
      .set({ deleted_at: databaseNowTimestamp, updated_at: databaseNowTimestamp })
      .where(and(eq(uploads.organization_id, organization_id), isNull(uploads.deleted_at)))
      .returning({ id: uploads.id });
    return rows.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker-scoped helpers (sweeper / retention jobs)
//
// These accept an explicit WorkerDatabaseHandle obtained from the retention or
// user database context wrappers. They are NOT for HTTP code paths and must
// not call getRequestDatabase().
// ─────────────────────────────────────────────────────────────────────────────

/** Returns active PENDING uploads created before `cutoff`, oldest first. */
export async function findPendingUploadsOlderThan(
  databaseHandle: WorkerDatabaseHandle,
  cutoff: Date,
  limit: number,
): Promise<PendingUploadSweepRow[]> {
  return databaseHandle
    .select({
      id: uploads.id,
      public_id: uploads.public_id,
      user_id: uploads.user_id,
      file_key: uploads.file_key,
      mime_type: uploads.mime_type,
      file_size: uploads.file_size,
      created_at: uploads.created_at,
    })
    .from(uploads)
    .where(
      and(
        eq(uploads.status, 'PENDING'),
        isNull(uploads.deleted_at),
        lt(uploads.created_at, cutoff),
      ),
    )
    .orderBy(asc(uploads.created_at))
    .limit(limit);
}

/** Updates `status` for an upload by internal id, regardless of owner (worker-scoped). */
export async function setUploadStatusByInternalId(
  databaseHandle: WorkerDatabaseHandle,
  id: number,
  status: string,
): Promise<void> {
  await databaseHandle
    .update(uploads)
    .set({ status, updated_at: databaseNowTimestamp })
    .where(eq(uploads.id, id));
}

/**
 * sec-UP finding #20: worker-side equivalent of the HTTP confirm path's
 * `markConfirmedByPublicId` — flips status to UPLOADED AND repoints `file_key`
 * to the final (non-pending) key in a single UPDATE so a servable row never
 * references the overwritable `pending/` namespace. Used by the pending-sweep
 * auto-confirm path; mirrors the HTTP confirm invariant established by sec-UP1.
 *
 * sec-re-13: tighten the WHERE to also filter `deleted_at IS NULL` (for
 * sibling-consistency with `markConfirmedByPublicId`) and `status = 'PENDING'`.
 * The prior unfiltered `eq(uploads.id, id)` would silently UPDATE a row the
 * user had soft-deleted between the sweep's HEAD and this write, leaving an
 * `UPLOADED` row with `deleted_at IS NOT NULL`. Cross-domain attach checks
 * already filter on `isNull(deleted_at)` so this is not currently exploitable,
 * but the invariant ("only confirm rows that are PENDING and undeleted") is
 * worth making a WHERE-level guarantee instead of a downstream assumption.
 */
export async function markConfirmedByInternalId(
  databaseHandle: WorkerDatabaseHandle,
  id: number,
  finalFileKey: string,
): Promise<void> {
  await databaseHandle
    .update(uploads)
    .set({ status: 'UPLOADED', file_key: finalFileKey, updated_at: databaseNowTimestamp })
    .where(and(eq(uploads.id, id), isNull(uploads.deleted_at), eq(uploads.status, 'PENDING')));
}

/** Hard-deletes upload rows by internal id (caller must remove S3 objects first when needed). */
export async function hardDeleteUploadsByInternalIds(
  databaseHandle: WorkerDatabaseHandle,
  ids: readonly number[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await databaseHandle
    .delete(uploads)
    .where(inArray(uploads.id, ids))
    .returning({ id: uploads.id });
  return rows.length;
}
