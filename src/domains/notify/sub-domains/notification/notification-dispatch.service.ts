import { scheduleCommitDispatch } from '@/core/events/event-bus.js';
import type {
  NotificationRepository,
  CreateNotificationInput,
} from '@/domains/notify/sub-domains/notification/notification.repository.js';
import { ConfigurationError } from '@/shared/errors/index.js';

/**
 * Composition-root collaborator that hides the persist-then-enqueue choreography from event
 * handlers, so cross-domain emitters can request a notification with a single call.
 *
 * @remarks
 * - **Algorithm:** resolve the organization public id, then atomically persist the notification
 *   row, then enqueue dispatch on the post-commit hook of the surrounding event-bus transaction.
 * - **Failure modes:** a missing organization or insert error short-circuits before any enqueue;
 *   enqueue failures (post-commit) surface via the standard event-bus error channel.
 * - **Side effects:** writes to `notify.notifications`; enqueues a job on the
 *   `notification` BullMQ queue once the surrounding transaction commits.
 * - **Notes:** producers must call {@link configureNotificationDispatch} during container boot;
 *   never invoke this contract before the container has wired the singleton.
 */
export type NotificationDispatch = {
  createAndDispatchNotification(
    input: CreateNotificationInput,
    options?: { requestId?: string },
  ): Promise<void>;
};

/**
 * Build the live {@link NotificationDispatch} bound to a repository handle (used by
 * {@link configureNotificationDispatch} in the notify container).
 *
 * @remarks
 * - **Algorithm:** resolves `organization_public_id` first so a missing organization fails fast before any
 *   write; inserts the row; on commit, enqueues `enqueueNotification(id, organization_public_id)`.
 * - **Failure modes:** lookup or insert errors propagate to the caller; enqueue errors are
 *   deferred to post-commit and bubble through the event-bus failure path.
 * - **Side effects:** Postgres insert into `notify.notifications` and BullMQ enqueue.
 * - **Notes:** ordering matters — the lookup runs before the insert so a failure leaves no
 *   orphan row, and the enqueue is on commit so a rolled-back transaction never schedules work.
 */
export function createNotificationDispatch(
  notificationRepository: NotificationRepository,
): NotificationDispatch {
  return {
    async createAndDispatchNotification(
      input: CreateNotificationInput,
      options?: { requestId?: string },
    ): Promise<void> {
      // Resolve organization public id BEFORE the insert so failure of either step
      // leaves no orphan notification row: a lookup failure short-circuits before
      // any write, and an insert failure means there is nothing to enqueue.
      const organization_public_id =
        input.organization_id === undefined
          ? null
          : await notificationRepository.findOrganizationPublicIdByOrganizationId(
              input.organization_id,
            );
      const notification_id = await notificationRepository.create(input);
      await scheduleCommitDispatch(
        {
          type: 'notification',
          notificationId: notification_id,
          organizationPublicId: organization_public_id,
        },
        options?.requestId !== undefined ? { requestId: options.requestId } : undefined,
      );
    },
  };
}

let notificationDispatch: NotificationDispatch | null = null;

/**
 * Wire the singleton {@link NotificationDispatch} used by module-level
 * {@link createAndDispatchNotification}. Called once from the notify container during boot.
 *
 * @remarks
 * - **Algorithm:** stores the provided dispatch in a module-scoped slot.
 * - **Failure modes:** none — last writer wins.
 * - **Side effects:** mutates the module-level `notificationDispatch` reference.
 * - **Notes:** must be invoked before any cross-domain handler calls
 *   {@link createAndDispatchNotification}, otherwise that call throws `ConfigurationError`.
 */
export function configureNotificationDispatch(dispatch: NotificationDispatch): void {
  notificationDispatch = dispatch;
}

/**
 * Persist a notification row and enqueue async channel dispatch (in-app / email).
 * Used by notify domain event handlers reacting to cross-domain events.
 *
 * @remarks
 * - **Algorithm:** delegates to the singleton wired by {@link configureNotificationDispatch}.
 * - **Failure modes:** throws `ConfigurationError` when the dispatch is unset (boot order bug);
 *   propagates repository / enqueue errors otherwise.
 * - **Side effects:** writes a notification row and enqueues a BullMQ job on commit.
 * - **Notes:** keeps the call site free of DI plumbing so domain event handlers stay simple.
 */
export async function createAndDispatchNotification(
  input: CreateNotificationInput,
  options?: { requestId?: string },
): Promise<void> {
  if (!notificationDispatch) {
    throw new ConfigurationError(
      'Notification dispatch is not configured. Call configureNotificationDispatch from notify.container.',
    );
  }
  await notificationDispatch.createAndDispatchNotification(input, options);
}
