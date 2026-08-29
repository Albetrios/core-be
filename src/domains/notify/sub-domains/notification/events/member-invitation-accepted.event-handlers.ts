import { eventBus, type DomainEvent } from '@/core/events/event-bus.js';
import { createAndDispatchNotification } from '@/domains/notify/sub-domains/notification/notification-dispatch.service.js';
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
