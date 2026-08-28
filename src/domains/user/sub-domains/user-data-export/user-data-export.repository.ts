import { and, asc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { DEFAULT_REPOSITORY_LIST_LIMIT } from '@/shared/constants/query-limits.constants.js';
import { capListWithWarning } from '@/shared/utils/infrastructure/list-cap.util.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { resolveRepositoryDatabaseHandle } from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { assertWorkerDatabaseContext } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { user_data_exports } from '@/domains/user/sub-domains/user-data-export/user-data-export.schema.js';
import type { UserDataExportStatus } from '@/domains/user/sub-domains/user-data-export/user-data-export.types.js';

/** Row payload accepted by {@link UserDataExportRepository.create} when enqueuing a new export. */
export type UserDataExportInsert = {
  public_id: string;
  user_id: number;
  status: UserDataExportStatus;
  s3_key: string;
  expires_at: Date;
};

/**
 * Drizzle data-access for `auth.user_data_exports`.
 *
 * @remarks
 * - **Algorithm:** thin CRUD on a single table; reads/writes always scope by `(public_id, user_id)`
 *   so callers cannot cross users by guessing a public id.
 * - **Failure modes:** lookups return `null` when missing; `updateStatus` returns `null` when the
 *   row was deleted concurrently (offboarding) — callers should treat that as a cancelled job.
 * - **Side effects:** writes to `auth.user_data_exports` only; S3 / queue side effects live in the
 *   service.
 * - **Notes:** dual-mode handle — request-scoped DB (HTTP) or worker-scoped handle (resolved via
 *   {@link createWorkerUserDataExportRepository}); never call directly from a worker without a handle.
 */
export class UserDataExportRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  async create(row: UserDataExportInsert) {
    const [created] = await this.db()
      .insert(user_data_exports)
      .values({
        public_id: row.public_id,
        user_id: row.user_id,
        status: row.status,
        s3_key: row.s3_key,
        expires_at: row.expires_at,
      })
      .returning();
    return created!;
  }

  async findByPublicIdAndUserId(export_public_id: string, user_id: number) {
    const rows = await this.db()
      .select()
      .from(user_data_exports)
      .where(
        and(
          eq(user_data_exports.public_id, export_public_id),
          eq(user_data_exports.user_id, user_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findPendingOrProcessingByUserId(user_id: number) {
    const rows = await this.db()
      .select()
      .from(user_data_exports)
      .where(
        and(
          eq(user_data_exports.user_id, user_id),
          inArray(user_data_exports.status, ['pending', 'processing']),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async listByUserId(user_id: number) {
    // audit #36: bound this user-self-scoped read with limit+1 + capListWithWarning so a buggy or
    // abusive export loop (or a future "export history" endpoint) cannot load an unbounded array.
    const rows = await this.db()
      .select()
      .from(user_data_exports)
      .where(eq(user_data_exports.user_id, user_id))
      .orderBy(asc(user_data_exports.id))
      .limit(DEFAULT_REPOSITORY_LIST_LIMIT + 1);
    return capListWithWarning({
      rows,
      limit: DEFAULT_REPOSITORY_LIST_LIMIT,
      resource: 'user.user_data_exports',
      context: { userId: user_id },
    });
  }

  /**
   * Keyset page over rows with a non-null `s3_key`, ordered by `id` ascending.
   *
   * sec-r4-R2: offboarding deletion fan-out reads only the S3 keys it needs to
   * remove, in bounded batches, so a user with a long export history doesn't
   * load every column of every row into memory at once. Pairs with
   * {@link USER_DATA_EXPORT_OFFBOARDING_DELETE_BATCH_SIZE} on the caller side.
   */
  async findS3KeysByUserIdAfter(user_id: number, after_id: number, limit: number) {
    return this.db()
      .select({ id: user_data_exports.id, s3_key: user_data_exports.s3_key })
      .from(user_data_exports)
      .where(
        and(
          eq(user_data_exports.user_id, user_id),
          isNotNull(user_data_exports.s3_key),
          gt(user_data_exports.id, after_id),
        ),
      )
      .orderBy(asc(user_data_exports.id))
      .limit(limit);
  }

  async updateStatus(
    export_public_id: string,
    user_id: number,
    patch: {
      status: UserDataExportStatus;
      s3_key?: string | null;
      expires_at?: Date | null;
      completed_at?: Date | null;
      failed_at?: Date | null;
      error_code?: string | null;
    },
  ) {
    const [updated] = await this.db()
      .update(user_data_exports)
      .set({
        status: patch.status,
        ...(patch.s3_key !== undefined ? { s3_key: patch.s3_key } : {}),
        ...(patch.expires_at !== undefined ? { expires_at: patch.expires_at } : {}),
        ...(patch.completed_at !== undefined ? { completed_at: patch.completed_at } : {}),
        ...(patch.failed_at !== undefined ? { failed_at: patch.failed_at } : {}),
        ...(patch.error_code !== undefined ? { error_code: patch.error_code } : {}),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(user_data_exports.public_id, export_public_id),
          eq(user_data_exports.user_id, user_id),
        ),
      )
      .returning();
    return updated ?? null;
  }

  async deleteAllByUserId(user_id: number): Promise<number> {
    const deleted = await this.db()
      .delete(user_data_exports)
      .where(eq(user_data_exports.user_id, user_id))
      .returning({ id: user_data_exports.id });
    return deleted.length;
  }
}

/** Worker-only factory — requires an explicit handle from `withAppDatabaseContext (user scope)`. */
export function createWorkerUserDataExportRepository(
  databaseHandle: WorkerDatabaseHandle,
): UserDataExportRepository {
  assertWorkerDatabaseContext(['user']);
  return new UserDataExportRepository(databaseHandle);
}
