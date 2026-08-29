import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { NotFoundError } from '@/shared/errors/index.js';
import { createNotificationController } from '@/domains/notify/sub-domains/notification/notification.controller.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { attachPrincipalScope } from '@/tests/helpers/principal-scope.helper.js';

function mockRequest(overrides: Partial<FastifyRequest> = {}): never {
  return attachPrincipalScope({
    auth: {
      kind: 'user' as const,
      userId: generatePublicId('user'),
      role: 'user',
      organizationPublicId: generatePublicId('organization'),
    },
    params: {},
    body: {},
    headers: {},
    id: 'request-id',
    ...overrides,
  }) as never;
}

describe('createNotificationController', () => {
  const notificationId = generatePublicId('notification');
  const notification = { public_id: notificationId };
  const service = {
    listForUser: vi.fn().mockResolvedValue({
      items: [notification],
      total: null,
      limit: 25,
      has_more: false,
      next_cursor: null,
    }),
    get: vi.fn().mockResolvedValue(notification),
    markRead: vi.fn().mockResolvedValue(notification),
    markAllRead: vi.fn().mockResolvedValue(2),
    getUnreadCount: vi.fn().mockResolvedValue(2),
    deleteNotification: vi.fn().mockResolvedValue(notification),
  };

  const controller = createNotificationController(service as never);

  it('listNotifications returns paginated data', async () => {
    const response = await controller.listNotifications(
      mockRequest({ query: { limit: '25' } }),
      {} as FastifyReply,
    );
    expect(service.listForUser).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'request' }),
      expect.objectContaining({ limit: 25, include_total: false }),
    );
    expect(
      (response as { meta: { pagination: { has_more: boolean; next: string | null } } }).meta
        .pagination,
    ).toMatchObject({ has_more: false, next: null });
  });

  it('listNotifications rejects limit above 100', async () => {
    await expect(
      controller.listNotifications(mockRequest({ query: { limit: '500' } }), {} as FastifyReply),
    ).rejects.toThrow();
  });

  it('getNotification returns row', async () => {
    await controller.getNotification(
      mockRequest({ params: { notification_id: notificationId } }),
      {} as FastifyReply,
    );
    expect(service.get).toHaveBeenCalledWith(
      notificationId,
      expect.objectContaining({ source: 'request' }),
    );
  });

  it('markNotificationRead updates row', async () => {
    await controller.markNotificationRead(
      mockRequest({ params: { notification_id: notificationId } }),
      {} as FastifyReply,
    );
    expect(service.markRead).toHaveBeenCalled();
  });

  it('markAllRead returns updated_count summary', async () => {
    const response = await controller.markAllRead(mockRequest(), {} as FastifyReply);
    expect(service.markAllRead).toHaveBeenCalled();
    expect((response as { data: { updated_count: number } }).data.updated_count).toBe(2);
  });

  it('getUnreadCount delegates to service', async () => {
    await controller.getUnreadCount(mockRequest(), {} as FastifyReply);
    expect(service.getUnreadCount).toHaveBeenCalled();
  });

  it('deleteNotification returns 204', async () => {
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    await controller.deleteNotification(
      mockRequest({ params: { notification_id: notificationId } }),
      reply as unknown as FastifyReply,
    );
    expect(reply.code).toHaveBeenCalledWith(204);
  });

  it('getNotification throws NotFound when service returns null', async () => {
    vi.mocked(service.get).mockResolvedValueOnce(null);
    await expect(
      controller.getNotification(
        mockRequest({ params: { notification_id: notificationId } }),
        {} as FastifyReply,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('markNotificationRead throws NotFound when service returns null', async () => {
    vi.mocked(service.markRead).mockResolvedValueOnce(null);
    await expect(
      controller.markNotificationRead(
        mockRequest({ params: { notification_id: notificationId } }),
        {} as FastifyReply,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleteNotification throws NotFound when service returns null', async () => {
    vi.mocked(service.deleteNotification).mockResolvedValueOnce(null);
    await expect(
      controller.deleteNotification(mockRequest({ params: { notification_id: notificationId } }), {
        code: vi.fn(),
        send: vi.fn(),
      } as unknown as FastifyReply),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
