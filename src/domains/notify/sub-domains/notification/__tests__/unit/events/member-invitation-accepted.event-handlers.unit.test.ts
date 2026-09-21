import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const createAndDispatchNotificationMock = vi.fn();
const resolveRecipientPublicIdsMock = vi.fn();
vi.mock('@/domains/notify/sub-domains/notification/notification-dispatch.service.js', () => ({
  createAndDispatchNotification: (...arguments_: unknown[]) =>
    createAndDispatchNotificationMock(...arguments_),
  resolveNotificationRecipientPublicIds: (...arguments_: unknown[]) =>
    resolveRecipientPublicIdsMock(...arguments_),
}));

const invalidateUnreadCountsMock = vi.fn();
vi.mock('@/domains/notify/sub-domains/notification/notification-unread-count.cache.js', () => ({
  invalidateCachedUnreadNotificationCounts: (...arguments_: unknown[]) =>
    invalidateUnreadCountsMock(...arguments_),
}));

describe('member-invitation-accepted notification handler (item #10)', () => {
  let emitAccepted: (payload: unknown) => Promise<void>;

  beforeAll(async () => {
    // One cold import + handler registration for the file — avoids per-test
    // `vi.resetModules()` + event-bus re-import that flakes under parallel fork load.
    const { eventBus } = await import('@/core/events/event-bus.js');
    const { MEMBER_INVITATION_EVENT } = await import(
      '@/domains/tenancy/sub-domains/membership/member-invitation/events/member-invitation.events.js'
    );
    const { registerMemberInvitationAcceptedNotificationHandlers } = await import(
      '@/domains/notify/sub-domains/notification/events/member-invitation-accepted.event-handlers.js'
    );
    registerMemberInvitationAcceptedNotificationHandlers();
    emitAccepted = async (payload: unknown) => {
      await eventBus.emit({
        type: MEMBER_INVITATION_EVENT.ACCEPTED,
        payload,
        timestamp: new Date(),
      });
    };
  }, 60_000);

  beforeEach(() => {
    createAndDispatchNotificationMock.mockReset();
    createAndDispatchNotificationMock.mockResolvedValue(undefined);
    resolveRecipientPublicIdsMock.mockReset();
    resolveRecipientPublicIdsMock.mockResolvedValue([]);
    invalidateUnreadCountsMock.mockReset();
    invalidateUnreadCountsMock.mockResolvedValue(undefined);
  });

  it('fans out one in-app+email notification per manager recipient', async () => {
    await emitAccepted({
      recipient_user_ids: [11, 22],
      organization_id: 7,
      organization_name: 'Acme',
      invitee_name: 'Dana Scully',
    });

    expect(createAndDispatchNotificationMock).toHaveBeenCalledTimes(2);
    expect(createAndDispatchNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 11,
        organization_id: 7,
        type: 'membership.invite_accepted',
        title: 'Invitation accepted',
        message: 'Dana Scully accepted your invitation to join Acme.',
        action_url: '/settings/members',
        data: { channels: ['in_app', 'email'] },
      }),
    );
    expect(createAndDispatchNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 22 }),
    );
  });

  it('one failed dispatch does not drop the rest and never throws out of the handler', async () => {
    createAndDispatchNotificationMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);

    await expect(
      emitAccepted({
        recipient_user_ids: [1, 2],
        organization_id: 7,
        organization_name: 'Acme',
        invitee_name: 'X',
      }),
    ).resolves.not.toThrow();

    expect(createAndDispatchNotificationMock).toHaveBeenCalledTimes(2);
  });

  it('drops each recipient cached unread count, keyed on the public id', async () => {
    // The event carries internal ids; the cache is keyed on public ids. Resolving between the two
    // is the only reason this handler touches the dispatch a second time — if that resolve is
    // skipped or the wrong ids are forwarded, the badge silently lags a whole TTL behind a
    // notification the user was just sent.
    resolveRecipientPublicIdsMock.mockResolvedValue(['usr_first', 'usr_second']);

    await emitAccepted({
      recipient_user_ids: [11, 22],
      organization_id: 7,
      organization_name: 'Acme',
      invitee_name: 'Dana Scully',
    });

    expect(resolveRecipientPublicIdsMock).toHaveBeenCalledWith([11, 22]);
    expect(invalidateUnreadCountsMock).toHaveBeenCalledWith(['usr_first', 'usr_second']);
  });

  it('a failed cache invalidation never escapes the handler', async () => {
    // Accepting an invitation must not fail because Redis did. The cost of swallowing is a badge
    // that stays low until the TTL expires, which the cache module documents as the bounded error.
    resolveRecipientPublicIdsMock.mockRejectedValue(new Error('redis down'));

    await expect(
      emitAccepted({
        recipient_user_ids: [11],
        organization_id: 7,
        organization_name: 'Acme',
        invitee_name: 'X',
      }),
    ).resolves.not.toThrow();

    expect(createAndDispatchNotificationMock).toHaveBeenCalledTimes(1);
    expect(invalidateUnreadCountsMock).not.toHaveBeenCalled();
  });
});
