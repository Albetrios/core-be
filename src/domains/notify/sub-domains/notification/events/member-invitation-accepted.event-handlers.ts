import { eventBus, runEnqueueAfterCommit, type DomainEvent } from '@/core/events/event-bus.js';
import { invalidateCachedUnreadNotificationCounts } from '@/domains/notify/sub-domains/notification/notification-unread-count.cache.js';
import {
  createAndDispatchNotification,
  resolveNotificationRecipientPublicIds,
} from '@/domains/notify/sub-domains/notification/notification-dispatch.service.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  MEMBER_INVITATION_EVENT,
  type MemberInvitationAcceptedPayload,
} from '@/domains/tenancy/sub-domains/membership/member-invitation/events/member-invitation.events.js';

/** Canonical type (from the #964 vocabulary) + FE deep link for the invite-accepted notification. */
const INVITE_ACCEPTED_NOTIFICATION_TYPE = 'membership.invite_accepted';
const INVITE_ACCEPTED_ACTION_URL = '/settings/members';

/**
 * Fans out an `membership.invite_accepted` notification (in-app + email) to each organization
 * `membership:manage` holder resolved by the tenancy accept path.
 *
 * @remarks Runs synchronously inside the accept's `withAppDatabaseContext` (the event is
 * awaited there), so each `createAndDispatchNotification` INSERT sees the organization GUC and satisfies the
 * notification write-RLS. `requestId` is intentionally omitted so the commit-dispatch uses the
 * in-memory `onCommit` path — no Redis write inside the caller's RLS-context transaction. Per-recipient
 * try/catch means one bad insert cannot drop the rest, and the bus swallows any throw so accept is safe.
 */
async function onMemberInvitationAcceptedEvent(event: DomainEvent): Promise<void> {
  const payload = event.payload as MemberInvitationAcceptedPayload;
  const title = 'Invitation accepted';
  const message = `${payload.invitee_name} accepted your invitation to join ${payload.organization_name}.`;
  for (const recipientUserId of payload.recipient_user_ids) {
    try {
      await createAndDispatchNotification({
        user_id: recipientUserId,
        organization_id: payload.organization_id,
        type: INVITE_ACCEPTED_NOTIFICATION_TYPE,
        title,
        message,
        action_url: INVITE_ACCEPTED_ACTION_URL,
        // In-app inbox item + an email to the manager (IN_APP is the persisted row itself; the
        // worker delivers the email channel).
        data: { channels: ['in_app', 'email'] },
      });
    } catch (error) {
      logger.error(
        { err: error, recipientUserId, eventType: event.type },
        'notify.member_invitation_accepted.dispatch.failed',
      );
    }
  }
  await invalidateRecipientUnreadCounts(payload.recipient_user_ids, event.type);
}

/**
 * Drops each recipient's cached unread count, so the badge reflects the notification they were
 * just sent instead of waiting out the TTL.
 *
 * @remarks
 * - **Algorithm:** two halves, on opposite sides of the commit. The internal-id → public-id
 *   resolve runs HERE, inside the accept's live database context, because after commit there is
 *   no handle to resolve with. The tombstone write is deferred to `runEnqueueAfterCommit`.
 * - **Failure modes:** entirely best-effort — a failure leaves a badge low for at most the cache
 *   TTL, which must never be allowed to fail an invitation accept. Logged, never rethrown.
 * - **Side effects:** one SECURITY DEFINER resolve; one short-lived Redis key per recipient, after
 *   the transaction commits.
 * - **Notes:** the split is what lets the tombstone be short. Invalidating from inside the
 *   transaction would be *correct* — a tombstone, unlike a `DEL`, refuses the racing populate
 *   rather than being overwritten by it — but the tombstone would then have to outlive the rest of
 *   the transaction too, and sizing it for that means holding the key cold far longer than the
 *   race needs. Deferring past the commit makes the window just the in-flight read, which is what
 *   `CACHE_INVALIDATION_TOMBSTONE_TTL_SECONDS` is sized for. It also means a rolled-back
 *   accept invalidates nothing, which the pre-commit version got wrong.
 */
async function invalidateRecipientUnreadCounts(
  recipientUserIds: readonly number[],
  eventType: string,
): Promise<void> {
  try {
    const recipientPublicIds = await resolveNotificationRecipientPublicIds(recipientUserIds);
    await runEnqueueAfterCommit(async () => {
      await invalidateCachedUnreadNotificationCounts(recipientPublicIds);
    });
  } catch (error) {
    logger.warn(
      { err: error, eventType },
      'notify.member_invitation_accepted.unread_cache_invalidate.failed',
    );
  }
}

let memberInvitationAcceptedHandlersRegistered = false;

/**
 * Idempotent registrar subscribing the in-process listener for
 * {@link MEMBER_INVITATION_EVENT.ACCEPTED}, so accepting an invitation fans out an
 * `membership.invite_accepted` notification to the organization's members-managers.
 */
export function registerMemberInvitationAcceptedNotificationHandlers(): void {
  if (memberInvitationAcceptedHandlersRegistered) return;
  memberInvitationAcceptedHandlersRegistered = true;
  eventBus.on(MEMBER_INVITATION_EVENT.ACCEPTED, onMemberInvitationAcceptedEvent);
}
