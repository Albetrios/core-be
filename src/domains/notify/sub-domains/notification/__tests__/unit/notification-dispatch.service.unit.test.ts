import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enterOnCommitScope, eventBus } from '@/core/events/event-bus.js';
import { createNotificationDispatch } from '@/domains/notify/sub-domains/notification/notification-dispatch.service.js';
import type { NotificationRepository } from '@/domains/notify/sub-domains/notification/notification.repository.js';

const { enqueueNotificationMock } = vi.hoisted(() => ({
  enqueueNotificationMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/domains/notify/sub-domains/notification/queues/notification.queue.js', () => ({
  enqueueNotification: (...arguments_: unknown[]) => enqueueNotificationMock(...arguments_),
}));

describe('NotificationDispatch', () => {
  const notificationRepository = {
    create: vi.fn().mockResolvedValue(42),
    findOrganizationPublicIdByOrganizationId: vi.fn().mockResolvedValue('org_public'),
    deleteByInternalId: vi.fn().mockResolvedValue(undefined),
    resolveUserPublicIdsByInternalIds: vi.fn().mockResolvedValue(['usr_one', 'usr_two']),
  } as unknown as NotificationRepository;

  const dispatch = createNotificationDispatch(notificationRepository);

  beforeEach(() => {
    enqueueNotificationMock.mockClear();
    vi.mocked(notificationRepository.create).mockClear();
    vi.mocked(notificationRepository.findOrganizationPublicIdByOrganizationId).mockClear();
  });

  it('defers enqueueNotification until flushOnCommit', async () => {
    enterOnCommitScope();
    await dispatch.createAndDispatchNotification({
      user_id: 1,
      organization_id: 2,
      type: 'billing',
      title: 'Test',
      message: 'Body',
    });

    expect(enqueueNotificationMock).not.toHaveBeenCalled();

    await eventBus.flushOnCommit();
    expect(enqueueNotificationMock).toHaveBeenCalledOnce();
    expect(enqueueNotificationMock).toHaveBeenCalledWith(42, 'org_public');
  });

  it('resolves organization public id before inserting the notification row', async () => {
    const callOrder: string[] = [];
    vi.mocked(
      notificationRepository.findOrganizationPublicIdByOrganizationId,
    ).mockImplementationOnce(async () => {
      callOrder.push('lookup');
      return 'org_public';
    });
    vi.mocked(notificationRepository.create).mockImplementationOnce(async () => {
      callOrder.push('create');
      return 42;
    });

    enterOnCommitScope();
    await dispatch.createAndDispatchNotification({
      user_id: 1,
      organization_id: 2,
      type: 'billing',
      title: 'Test',
      message: 'Body',
    });

    expect(callOrder).toEqual(['lookup', 'create']);
  });

  it('skips organization lookup and passes null public id for user-only notifications', async () => {
    enterOnCommitScope();
    await dispatch.createAndDispatchNotification({
      user_id: 1,
      type: 'system',
      title: 'Test',
      message: 'Body',
    });

    expect(notificationRepository.findOrganizationPublicIdByOrganizationId).not.toHaveBeenCalled();

    await eventBus.flushOnCommit();
    expect(enqueueNotificationMock).toHaveBeenCalledWith(42, null);
  });

  it('does not create the notification when organization lookup fails', async () => {
    const lookupError = new Error('organization lookup failed');
    vi.mocked(
      notificationRepository.findOrganizationPublicIdByOrganizationId,
    ).mockRejectedValueOnce(lookupError);

    await expect(
      dispatch.createAndDispatchNotification({
        user_id: 1,
        organization_id: 2,
        type: 'billing',
        title: 'Test',
        message: 'Body',
      }),
    ).rejects.toBe(lookupError);

    expect(notificationRepository.create).not.toHaveBeenCalled();
  });

  it('resolves recipient public ids through the repository batch resolver', async () => {
    // The invite-accepted handler needs public ids to key each recipient's unread-count cache,
    // and it has only internal ids. This is the seam; it lives on the dispatch because that is
    // the repository handle a cross-domain event handler is allowed to reach.
    await expect(dispatch.resolveRecipientPublicIds([11, 22])).resolves.toEqual([
      'usr_one',
      'usr_two',
    ]);
    expect(notificationRepository.resolveUserPublicIdsByInternalIds).toHaveBeenCalledWith([11, 22]);
  });

  it('the module-level resolver refuses to run before the container wired the dispatch', async () => {
    // Boot-order bug, not a runtime condition — an unconfigured singleton quietly answering []
    // would skip every cache invalidation instead of failing somewhere a human would see it.
    // Imported fresh rather than reusing the file's module instance, so this does not depend on
    // no earlier test in this file having configured the singleton.
    vi.resetModules();
    const fresh = await import(
      '@/domains/notify/sub-domains/notification/notification-dispatch.service.js'
    );

    await expect(fresh.resolveNotificationRecipientPublicIds([1])).rejects.toThrow(
      /Notification dispatch is not configured/,
    );

    fresh.configureNotificationDispatch(fresh.createNotificationDispatch(notificationRepository));
    await expect(fresh.resolveNotificationRecipientPublicIds([11, 22])).resolves.toEqual([
      'usr_one',
      'usr_two',
    ]);
  });
});
