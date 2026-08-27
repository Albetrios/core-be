import { and, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { countWithCap } from '@/infrastructure/database/utils/capped-count.util.js';
import { NOTIFICATION_MARK_ALL_READ_BATCH_SIZE } from '@/shared/constants/notification.constants.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { resolveRepositoryDatabaseHandle } from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { assertWorkerDatabaseContext } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { notifications } from '@/domains/notify/sub-domains/notification/notification.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { users } from '@/domains/user/user.schema.js';
import {
  buildDescendingCreatedAtIdCursorCondition,
  createOpaqueCursorFromRow,
  parseListCursor,
} from '@/shared/utils/http/pagination.util.js';

/** Keyset-pagination input for {@link NotificationRepository.findByUser}. */
export interface NotificationListPagination {
  after?: string;
  limit: number;
  include_total?: boolean;
}

/** Row shape returned by {@link NotificationRepository.listForUserDataExport}. */
export interface NotificationUserDataExportRow {
  type: string;
  title: string;
  message: string;
  created_at: Date;
}

/** Insert payload for a new notification row (consumed by {@link NotificationRepository.create}). */
export interface CreateNotificationInput {
  user_id: number;
  organization_id?: number;
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  action_url?: string;
  action_label?: string;
}

/**
 * Drizzle-backed data access for `notify.notifications`. Owns the SQL for the user inbox
 * (keyset list, mark-read, unread count) and the worker dispatch projection used to build
 * email/in-app payloads. Resolves its database handle via the shared request/worker context
 * helper so the same class works under HTTP RLS and worker organization scopes.
 */
export class NotificationRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  async create(input: CreateNotificationInput): Promise<number> {
    const rows = await this.db()
      .insert(notifications)
      .values({
        public_id: generatePublicId('notification'),
        user_id: input.user_id,
        organization_id: input.organization_id,
        type: input.type,
        title: input.title,
        message: input.message,
        data: input.data ?? {},
        action_url: input.action_url,
        action_label: input.action_label,
      })
      .returning({ id: notifications.id });
    return rows[0]!.id;
  }

  /** Removes a notification row when post-commit BullMQ enqueue fails (rollback side effect). */
  async deleteByInternalId(notification_id: number): Promise<void> {
    await this.db().delete(notifications).where(eq(notifications.id, notification_id));
  }

  async findOrganizationPublicIdByNotificationId(notification_id: number): Promise<string | null> {
    const rows = await this.db()
      .select({ organizationPublicId: organizations.public_id })
      .from(notifications)
      .leftJoin(organizations, eq(notifications.organization_id, organizations.id))
      .where(eq(notifications.id, notification_id))
      .limit(1);
    return rows[0]?.organizationPublicId ?? null;
  }

  async findOrganizationPublicIdByOrganizationId(organization_id: number): Promise<string | null> {
    const rows = await this.db()
      .select({ organizationPublicId: organizations.public_id })
      .from(organizations)
      .where(eq(organizations.id, organization_id))
      .limit(1);
    return rows[0]?.organizationPublicId ?? null;
  }

  /**
   * sec-D #10: resolve the recipient's user public id from a notification id via the
   * `notify.resolve_user_public_id_for_notification` SECURITY DEFINER function. Used by
   * the notification dispatch worker to pin `withPrincipalDatabaseContext (user scope)` for NULL-organization
   * notifications instead of the wider `app.global_retention_cleanup` retention scope.
   * Returns null when the notification or recipient cannot be resolved (worker treats this
   * as a hard error and throws).
   */
  async findUserPublicIdForNotificationDispatch(notification_id: number): Promise<string | null> {
    const result = await this.db().execute(
      sql`SELECT notify.resolve_user_public_id_for_notification(${notification_id}) AS user_public_id`,
    );
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as { user_public_id: string | null }[];
    return rows[0]?.user_public_id ?? null;
  }

  async findByIdForDispatch(notification_id: number, organization_public_id: string | null) {
    const organizationScopeCondition =
      organization_public_id === null
        ? isNull(notifications.organization_id)
        : eq(organizations.public_id, organization_public_id);

    const rows = await this.db()
      .select({
        id: notifications.id,
        type: notifications.type,
        title: notifications.title,
        message: notifications.message,
        actionUrl: notifications.action_url,
        data: notifications.data,
        userEmail: users.email,
      })
      .from(notifications)
      .innerJoin(users, eq(notifications.user_id, users.id))
      .leftJoin(organizations, eq(notifications.organization_id, organizations.id))
      .where(and(eq(notifications.id, notification_id), organizationScopeCondition))
      .limit(1);
    return rows[0] ?? null;
  }

  async findByUser(user_id: number, pagination: NotificationListPagination) {
    const { after, limit } = pagination;
    const includeTotal = pagination.include_total === true;
    const filterConditions: SQL[] = [eq(notifications.user_id, user_id)];
    const countWhere = and(...filterConditions);
    const cursorCondition = buildDescendingCreatedAtIdCursorCondition(
      notifications.created_at,
      notifications.id,
      parseListCursor(after),
    );
    const where =
      cursorCondition !== undefined ? and(...filterConditions, cursorCondition) : countWhere;

    // Fetch one extra row so has_more is accurate without depending on count(*).
    const rowsPromise = this.db()
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.created_at), desc(notifications.id))
      .limit(limit + 1);

    const countPromise = includeTotal
      ? countWithCap({ database: this.db(), table: notifications, where: countWhere })
      : Promise.resolve(null);

    const [fetchedRows, total] = await Promise.all([rowsPromise, countPromise]);
    const hasMore = fetchedRows.length > limit;
    const items = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
    const lastItem = items.at(-1);
    const nextCursor =
      hasMore && lastItem !== undefined ? createOpaqueCursorFromRow(lastItem) : null;
    return {
      items,
      total,
      limit,
      has_more: hasMore,
      next_cursor: nextCursor,
    };
  }

  async listForUserDataExport(
    user_id: number,
    limit: number,
  ): Promise<NotificationUserDataExportRow[]> {
    return this.db()
      .select({
        type: notifications.type,
        title: notifications.title,
        message: notifications.message,
        created_at: notifications.created_at,
      })
      .from(notifications)
      .where(eq(notifications.user_id, user_id))
      .orderBy(desc(notifications.created_at))
      .limit(limit);
  }

  async findByPublicIdForUser(public_id: string, user_id: number) {
    const rows = await this.db()
      .select()
      .from(notifications)
      .where(and(eq(notifications.public_id, public_id), eq(notifications.user_id, user_id)))
      .limit(1);
    return rows[0] ?? null;
  }

  async markRead(public_id: string, user_id: number) {
    const rows = await this.db()
      .update(notifications)
      .set({ is_read: true, read_at: new Date() })
      .where(and(eq(notifications.public_id, public_id), eq(notifications.user_id, user_id)))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Marks every unread notification for a user as read, returning the number of
   * rows actually flipped.
   *
   * @remarks
   * - **Algorithm:** loops `UPDATE ... WHERE id IN (SELECT id ... WHERE
   *   is_read=false LIMIT N)` in batches of {@link NOTIFICATION_MARK_ALL_READ_BATCH_SIZE},
   *   summing the per-batch `RETURNING` counts until a short (or empty) batch
   *   signals the backlog is drained (audit #39). Each statement is atomic and
   *   bounded, so a user with a very large unread backlog cannot turn this into
   *   one unbounded, long-held write that locks every unread row at once and
   *   stalls concurrent notification inserts for that user.
   * - **Failure modes:** propagates Postgres errors to the controller.
   * - **Side effects:** updates `is_read`/`read_at` on up to the whole unread set.
   * - **Notes:** sec-D10 — the count is summed from each statement's `RETURNING`,
   *   never a separate pre-count, so the caller-visible total can never drift
   *   from the DB effect even as notifications arrive concurrently; a row that
   *   arrives mid-loop is simply "after" the mark-all.
   */
  async markAllReadForUser(user_id: number): Promise<number> {
    let totalMarked = 0;
    for (;;) {
      const database = this.db();
      const batchRows = await database
        .update(notifications)
        .set({ is_read: true, read_at: new Date() })
        .where(
          inArray(
            notifications.id,
            database
              .select({ id: notifications.id })
              .from(notifications)
              .where(and(eq(notifications.user_id, user_id), eq(notifications.is_read, false)))
              .limit(NOTIFICATION_MARK_ALL_READ_BATCH_SIZE),
          ),
        )
        .returning({ id: notifications.id });
      totalMarked += batchRows.length;
      if (batchRows.length < NOTIFICATION_MARK_ALL_READ_BATCH_SIZE) break;
    }
    return totalMarked;
  }

  async countUnreadForUser(user_id: number): Promise<number> {
    const result = await this.db()
      .select({ count: count() })
      .from(notifications)
      .where(and(eq(notifications.user_id, user_id), eq(notifications.is_read, false)));
    return result[0]?.count ?? 0;
  }

  async deleteByPublicIdForUser(public_id: string, user_id: number) {
    const rows = await this.db()
      .delete(notifications)
      .where(and(eq(notifications.public_id, public_id), eq(notifications.user_id, user_id)))
      .returning();
    return rows[0] ?? null;
  }
}

/**
 * Worker-only factory — requires an explicit handle pinned by one of the supported
 * worker database contexts: `organization` (tenant-scoped notifications),
 * `global_admin` (sec-D #10 SECURITY DEFINER user-id lookup for tenant-less
 * notifications), or `user` (sec-D #10 narrow per-user load for tenant-less
 * notifications). Retention cleanup uses a raw batch-delete under
 * `withMaintenanceDatabaseContext` (not this factory), so
 * `global_retention_cleanup` is intentionally NOT an accepted context here.
 */
export function createWorkerNotificationRepository(
  databaseHandle: WorkerDatabaseHandle,
): NotificationRepository {
  assertWorkerDatabaseContext(['organization', 'global_admin', 'user']);
  return new NotificationRepository(databaseHandle);
}
