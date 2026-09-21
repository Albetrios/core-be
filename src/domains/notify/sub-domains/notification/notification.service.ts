import { UnauthorizedError } from '@/shared/errors/index.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { enqueueNotification } from '@/domains/notify/sub-domains/notification/queues/notification.queue.js';
import { PAGINATION } from '@/shared/constants/pagination.constants.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { NotificationRepository } from './notification.repository.js';
import type { UserService } from '@/domains/user/user.service.js';
import {
  getCachedUnreadNotificationCount,
  invalidateCachedUnreadNotificationCount,
  setCachedUnreadNotificationCount,
} from './notification-unread-count.cache.js';

/**
 * Options forwarded from controllers/event handlers into {@link NotificationService.listForUser}.
 *
 * @remarks
 * - **Algorithm:** consumed verbatim by the repository keyset-pagination layer.
 * - **Failure modes:** invalid `after` cursors raise inside the repository.
 * - **Side effects:** none (read-only).
 * - **Notes:** `include_total` is opt-in because the inbox stays keyset-only by default.
 */
export interface NotificationListServiceOptions {
  after?: string;
  limit?: number;
  include_total?: boolean;
}

/**
 * Persists in-app notifications and enqueues delivery for the owning user.
 *
 * @remarks
 * - **Algorithm:** controller-facing methods take the token-minted
 *   {@link UserPrincipalDatabaseScope}, resolve the user public id to an internal id via
 *   {@link UserService}, then run the repository call inside `withAppDatabaseContext` so
 *   Postgres RLS sees the correct identity GUCs; the data-export path
 *   (`listForUserDataExport`, a worker caller) stays on `withAppDatabaseContext (user scope)`. `dispatchNotification` looks up the
 *   organization public id and re-enqueues a notification job for the BullMQ worker.
 * - **Failure modes:** `UnauthorizedError` for unknown user public ids; repository errors
 *   propagate; `enqueueNotification` failures bubble to the caller.
 * - **Side effects:** Postgres reads/writes against `notify.notifications` (mark-read,
 *   mark-all-read, delete) plus optional BullMQ enqueue from `dispatchNotification`.
 * - **Notes:** `listForUser` takes a {@link NotificationListServiceOptions} object.
 */
export class NotificationService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly userService: UserService,
  ) {}

  /**
   * Resolves the caller's internal id from **inside** the caller's database context.
   *
   * @remarks
   * Every method here needs `user.id` to scope its query, and each used to fetch the whole user
   * row through `UserService.findUserRecordByPublicId` BEFORE opening its own context. That opened
   * a second transaction and held a second pooled checkout for a value the request already had the
   * public id for: `GET /notify/notifications/unread-count` spent eight round trips and two
   * checkouts to return one integer. Called inside the context, this joins the transaction that is
   * already open — the same reuse `AuthMeContextService.getContext` documents. The DB pool is what
   * runs out first under load, so halving the checkouts per request is the point.
   */
  private async resolveUserIdInContext(user_public_id: string): Promise<number> {
    const userId = await this.userService.resolveInternalIdByPublicId(user_public_id);
    if (userId === null) throw new UnauthorizedError();
    return userId;
  }

  /**
   * List notifications for a user using keyset pagination. Takes a
   * {@link NotificationListServiceOptions} object so HTTP controllers can pass parsed
   * pagination input forward unchanged.
   */
  async listForUser(
    scope: UserPrincipalDatabaseScope,
    options: NotificationListServiceOptions = {},
  ) {
    const limit = options.limit ?? PAGINATION.DEFAULT_LIMIT;
    return withAppDatabaseContext(scope, async () =>
      this.repository.findByUser(
        await this.resolveUserIdInContext(scope.userPublicId),
        omitUndefined({
          after: options.after,
          limit,
          include_total: options.include_total,
        }),
      ),
    );
  }

  /** Lists notification metadata for a GDPR data-export bundle (capped by caller). */
  async listForUserDataExport(options: { userPublicId: string; limit: number }) {
    return withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ userPublicId: options.userPublicId }),
      async () =>
        this.repository.listForUserDataExport(
          await this.resolveUserIdInContext(options.userPublicId),
          options.limit,
        ),
    );
  }

  async get(public_id: string, scope: UserPrincipalDatabaseScope) {
    return withAppDatabaseContext(scope, async () =>
      this.repository.findByPublicIdForUser(
        public_id,
        await this.resolveUserIdInContext(scope.userPublicId),
      ),
    );
  }

  async markRead(public_id: string, scope: UserPrincipalDatabaseScope) {
    const result = await withAppDatabaseContext(scope, async () =>
      this.repository.markRead(public_id, await this.resolveUserIdInContext(scope.userPublicId)),
    );
    // After the commit: invalidating first would let a concurrent read repopulate the pre-write
    // count, which is the race the tombstone exists to close.
    await invalidateCachedUnreadNotificationCount(scope.userPublicId);
    return result;
  }

  async markAllRead(scope: UserPrincipalDatabaseScope) {
    const result = await withAppDatabaseContext(scope, async () =>
      this.repository.markAllReadForUser(await this.resolveUserIdInContext(scope.userPublicId)),
    );
    await invalidateCachedUnreadNotificationCount(scope.userPublicId);
    return result;
  }

  /**
   * The unread badge — polled by every open tab, and the reason this cache exists.
   *
   * @remarks
   * - **Algorithm:** Redis first; on a miss, count in Postgres and populate. The cache is read
   *   only here, after the route's `authenticate` has produced the scope, because Redis sits
   *   outside RLS — reading it earlier would hand one user another's count.
   * - **Failure modes:** a Redis outage reads as a miss and the count comes from Postgres.
   * - **Side effects:** one Redis read, and a write on a miss.
   * - **Notes:** a hit skips the whole database round trip, which for this route was the entire
   *   request: a transaction, a `set_config`, an id resolve and a `COUNT`, to return one integer.
   */
  async getUnreadCount(scope: UserPrincipalDatabaseScope) {
    const cached = await getCachedUnreadNotificationCount(scope.userPublicId);
    if (cached !== null) return cached;

    const count = await withAppDatabaseContext(scope, async () =>
      this.repository.countUnreadForUser(await this.resolveUserIdInContext(scope.userPublicId)),
    );
    await setCachedUnreadNotificationCount(scope.userPublicId, count);
    return count;
  }

  async deleteNotification(public_id: string, scope: UserPrincipalDatabaseScope) {
    const result = await withAppDatabaseContext(scope, async () =>
      this.repository.deleteByPublicIdForUser(
        public_id,
        await this.resolveUserIdInContext(scope.userPublicId),
      ),
    );
    // Only when a row actually went. A miss here is a 404, and tombstoning on one would let a
    // caller cold-start their own cache at will by deleting ids that do not exist. Deleting an
    // already-READ notification does not change the count either, but the row's read state is not
    // in hand at this point and that redundant invalidation costs one Postgres count at worst.
    if (result) await invalidateCachedUnreadNotificationCount(scope.userPublicId);
    return result;
  }

  /**
   * Enqueue async dispatch for a persisted notification row (email / in-app channels).
   */
  async dispatchNotification(notificationId: number): Promise<void> {
    const organizationPublicId =
      await this.repository.findOrganizationPublicIdByNotificationId(notificationId);
    await enqueueNotification(notificationId, organizationPublicId);
  }
}
