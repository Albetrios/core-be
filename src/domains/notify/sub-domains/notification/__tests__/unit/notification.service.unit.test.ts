import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedError } from '@/shared/errors/index.js';
import {
  PRINCIPAL_SCOPE,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { NotificationService } from '@/domains/notify/sub-domains/notification/notification.service.js';
import type { NotificationRepository } from '@/domains/notify/sub-domains/notification/notification.repository.js';
import type { UserService } from '@/domains/user/user.service.js';

vi.mock('@/domains/notify/sub-domains/notification/queues/notification.queue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Blanket maintenance passthrough: services this suite touches (directly or via
    // cross-domain imports) may enter maintenance contexts (tombstoning, admin reads) —
    // the real wrapper opens a database.transaction() and CI's unit lane has no Postgres.
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
    withAppDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

const user = { id: 1, public_id: 'user_public' };
const scope = PRINCIPAL_SCOPE.REQUEST({
  userPublicId: 'user_public',
  organizationPublicId: 'org_public',
}) as UserPrincipalDatabaseScope;
const missingUserScope = PRINCIPAL_SCOPE.REQUEST({
  userPublicId: 'missing',
  organizationPublicId: 'org_public',
}) as UserPrincipalDatabaseScope;
const notification = {
  id: 2,
  public_id: 'notif_public',
  user_id: 1,
  title: 'Hello',
  body: 'World',
  read_at: null,
  created_at: new Date(),
};

describe('NotificationService', () => {
  const userService = {
    findUserRecordByPublicId: vi.fn().mockResolvedValue(user),
  } as unknown as UserService;

  const repository = {
    findByUser: vi.fn().mockResolvedValue({
      items: [notification],
      total: null,
      limit: 50,
      has_more: false,
      next_cursor: null,
    }),
    findByPublicIdForUser: vi.fn().mockResolvedValue(notification),
    markRead: vi.fn().mockResolvedValue({ ...notification, read_at: new Date() }),
    markAllReadForUser: vi.fn().mockResolvedValue(2),
    countUnreadForUser: vi.fn().mockResolvedValue(3),
    deleteByPublicIdForUser: vi.fn().mockResolvedValue(notification),
    findOrganizationPublicIdByNotificationId: vi.fn().mockResolvedValue('org_public'),
  } as unknown as NotificationRepository;

  const service = new NotificationService(repository, userService);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userService.findUserRecordByPublicId).mockResolvedValue(user as never);
  });

  it('listForUser returns keyset paginated notifications', async () => {
    const result = await service.listForUser(scope, { limit: 50 });
    expect(result.items).toHaveLength(1);
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeNull();
    expect(repository.findByUser).toHaveBeenCalledWith(1, { limit: 50 });
  });

  it('listForUser forwards keyset options to the repository', async () => {
    await service.listForUser(scope, {
      after: 'cursor_prev',
      limit: 25,
      include_total: true,
    });
    expect(repository.findByUser).toHaveBeenLastCalledWith(1, {
      after: 'cursor_prev',
      limit: 25,
      include_total: true,
    });
  });

  it('get returns notification for user', async () => {
    const result = await service.get('notif_public', scope);
    expect(result?.public_id).toBe('notif_public');
  });

  it('resolveUserId throws when user missing', async () => {
    vi.mocked(userService.findUserRecordByPublicId).mockResolvedValue(null);
    await expect(service.listForUser(missingUserScope, { limit: 50 })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('markRead updates notification', async () => {
    await service.markRead('notif_public', scope);
    expect(repository.markRead).toHaveBeenCalled();
  });

  it('getUnreadCount returns count', async () => {
    const result = await service.getUnreadCount(scope);
    expect(result).toBe(3);
  });

  it('dispatchNotification enqueues delivery job', async () => {
    const { enqueueNotification } = await import(
      '@/domains/notify/sub-domains/notification/queues/notification.queue.js'
    );
    await service.dispatchNotification(2);
    expect(enqueueNotification).toHaveBeenCalledWith(2, 'org_public');
  });

  it('markAllRead and deleteNotification delegate to repository', async () => {
    await service.markAllRead(scope);
    await service.deleteNotification('notif_public', scope);
    expect(repository.markAllReadForUser).toHaveBeenCalled();
    expect(repository.deleteByPublicIdForUser).toHaveBeenCalled();
  });
});
