import { UnauthorizedError } from '@/shared/errors/index.js';
import {
  withPrincipalDatabaseContext,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';
import { enqueueNotification } from '@/domains/notify/sub-domains/notification/queues/notification.queue.js';
import { PAGINATION } from '@/shared/constants/pagination.constants.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { NotificationRepository } from './notification.repository.js';
import type { UserService } from '@/domains/user/user.service.js';
import { resolveVerifiedUserPrincipalScope } from '@/shared/utils/identity/verified-principal-scope.util.js';

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
 *   {@link UserService}, then run the repository call inside `withPrincipalDatabaseContext` so
 *   Postgres RLS sees the correct identity GUCs; the data-export path
 *   (`listForUserDataExport`, a worker caller) stays on `withUserDatabaseContext`. `dispatchNotification` looks up the
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

  private async resolveUserId(user_public_id: string): Promise<number> {
    const user = await this.userService.findUserRecordByPublicId(user_public_id);
    if (!user) throw new UnauthorizedError();
    return user.id;
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
    const userId = await this.resolveUserId(scope.userPublicId);
    return withPrincipalDatabaseContext(scope, () =>
      this.repository.findByUser(
        userId,
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
    const userId = await this.resolveUserId(options.userPublicId);
    return withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(options.userPublicId),
      () => this.repository.listForUserDataExport(userId, options.limit),
    );
  }

  async get(public_id: string, scope: UserPrincipalDatabaseScope) {
    const userId = await this.resolveUserId(scope.userPublicId);
    return withPrincipalDatabaseContext(scope, () =>
      this.repository.findByPublicIdForUser(public_id, userId),
    );
  }

  async markRead(public_id: string, scope: UserPrincipalDatabaseScope) {
    const userId = await this.resolveUserId(scope.userPublicId);
    return withPrincipalDatabaseContext(scope, () => this.repository.markRead(public_id, userId));
  }

  async markAllRead(scope: UserPrincipalDatabaseScope) {
    const userId = await this.resolveUserId(scope.userPublicId);
    return withPrincipalDatabaseContext(scope, () => this.repository.markAllReadForUser(userId));
  }

  async getUnreadCount(scope: UserPrincipalDatabaseScope) {
    const userId = await this.resolveUserId(scope.userPublicId);
    return withPrincipalDatabaseContext(scope, () => this.repository.countUnreadForUser(userId));
  }

  async deleteNotification(public_id: string, scope: UserPrincipalDatabaseScope) {
    const userId = await this.resolveUserId(scope.userPublicId);
    return withPrincipalDatabaseContext(scope, () =>
      this.repository.deleteByPublicIdForUser(public_id, userId),
    );
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
