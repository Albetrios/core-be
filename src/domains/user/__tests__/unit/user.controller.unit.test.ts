import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createUserController } from '@/domains/user/user.controller.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    auth: {
      kind: 'user' as const,
      userId: generatePublicId('user'),
      role: 'USER',
      organizationPublicId: generatePublicId('organization'),
    },
    params: {},
    body: {},
    query: {},
    headers: {},
    id: 'request-id',
    ip: '127.0.0.1',
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    server: {
      auditDomain: {
        auditService: { record: vi.fn().mockResolvedValue(undefined) },
      },
    },
    ...overrides,
  } as FastifyRequest;
}

describe('createUserController', () => {
  const userPublicId = generatePublicId('user');
  const userService = {
    getMe: vi.fn().mockResolvedValue({ id: userPublicId }),
    updateMe: vi.fn().mockResolvedValue({ id: userPublicId }),
    completeOnboarding: vi.fn().mockResolvedValue({ id: userPublicId }),
    deleteMe: vi.fn().mockResolvedValue(undefined),
    listUsers: vi.fn().mockResolvedValue({
      items: [],
      limit: 20,
      total: null,
      has_more: false,
      next_cursor: null,
    }),
    getUser: vi.fn().mockResolvedValue({ id: userPublicId }),
    adminUpdateUser: vi.fn().mockResolvedValue({ id: userPublicId }),
    deleteUser: vi.fn().mockResolvedValue(undefined),
    suspendUser: vi.fn().mockResolvedValue({ id: userPublicId }),
    unsuspendUser: vi.fn().mockResolvedValue({ id: userPublicId }),
    uploadAvatar: vi.fn().mockResolvedValue({ avatar_url: 'key' }),
    deleteAvatar: vi.fn().mockResolvedValue(undefined),
  };

  const userSettingsService = {
    get: vi.fn().mockResolvedValue({ language: 'en' }),
    update: vi.fn().mockResolvedValue({ language: 'es' }),
  };

  const userNotificationPreferencesService = {
    get: vi.fn().mockResolvedValue({ email: true }),
    put: vi.fn().mockResolvedValue({ email: false }),
  };

  const controller = createUserController({
    userService: userService as never,
    userSettingsService: userSettingsService as never,
    userNotificationPreferencesService: userNotificationPreferencesService as never,
  });

  it('getMe returns current user', async () => {
    await controller.getMe(mockRequest(), {} as FastifyReply);
    expect(userService.getMe).toHaveBeenCalled();
  });

  it('patchMe updates profile', async () => {
    await controller.patchMe(mockRequest({ body: { first_name: 'A' } }), {} as FastifyReply);
    expect(userService.updateMe).toHaveBeenCalled();
  });

  it('completeOnboardingMe delegates to the service', async () => {
    await controller.completeOnboardingMe(mockRequest(), {} as FastifyReply);
    expect(userService.completeOnboarding).toHaveBeenCalled();
  });

  it('deleteMe returns 204', async () => {
    const reply = { status: vi.fn().mockReturnThis(), send: vi.fn() };
    await controller.deleteMe(mockRequest(), reply as unknown as FastifyReply);
    expect(reply.status).toHaveBeenCalledWith(204);
  });

  it('getSettings and patchSettings delegate to settings service', async () => {
    await controller.getSettings(mockRequest(), {} as FastifyReply);
    await controller.patchSettings(mockRequest({ body: { language: 'es' } }), {} as FastifyReply);
    expect(userSettingsService.get).toHaveBeenCalled();
    expect(userSettingsService.update).toHaveBeenCalled();
  });

  it('notification preference handlers delegate to service', async () => {
    await controller.getNotificationPreferences(mockRequest(), {} as FastifyReply);
    await controller.putNotificationPreferences(
      mockRequest({ body: { email: false } }),
      {} as FastifyReply,
    );
    expect(userNotificationPreferencesService.get).toHaveBeenCalled();
    expect(userNotificationPreferencesService.put).toHaveBeenCalled();
  });

  it('listUsers sets has_more and emits cursor when more pages exist', async () => {
    vi.mocked(userService.listUsers).mockResolvedValueOnce({
      items: [{ id: userPublicId }],
      limit: 1,
      total: null,
      has_more: true,
      next_cursor: 'cursor_next',
    } as never);
    const response = await controller.listUsers(
      mockRequest({ query: { limit: 1, after: 'cursor_prev' } }),
      {} as FastifyReply,
    );
    expect(response).toMatchObject({
      meta: { pagination: { has_more: true, next: 'cursor_next' } },
    });
  });

  it('admin user handlers delegate to user service', async () => {
    const targetId = generatePublicId('user');
    await controller.listUsers(mockRequest({ query: { limit: 20 } }), {} as FastifyReply);
    await controller.getUser(mockRequest({ params: { user_id: targetId } }), {} as FastifyReply);
    await controller.updateUser(
      mockRequest({ params: { user_id: targetId }, body: { status: 'SUSPENDED' } }),
      {} as FastifyReply,
    );
    await controller.suspendUser(
      mockRequest({ params: { user_id: targetId } }),
      {} as FastifyReply,
    );
    await controller.unsuspendUser(
      mockRequest({ params: { user_id: targetId } }),
      {} as FastifyReply,
    );
    const deleteReply = { status: vi.fn().mockReturnThis(), send: vi.fn() };
    await controller.deleteUser(
      mockRequest({ params: { user_id: targetId } }),
      deleteReply as unknown as FastifyReply,
    );
    expect(userService.listUsers).toHaveBeenCalled();
    expect(userService.adminUpdateUser).toHaveBeenCalled();
    expect(userService.suspendUser).toHaveBeenCalled();
    expect(userService.unsuspendUser).toHaveBeenCalled();
    expect(userService.deleteUser).toHaveBeenCalled();
  });

  it('admin handlers use empty userId when params are missing', async () => {
    await expect(
      controller.getUser(mockRequest({ params: {} }), {} as FastifyReply),
    ).rejects.toThrow();
    await expect(
      controller.updateUser(mockRequest({ params: undefined }), {} as FastifyReply),
    ).rejects.toThrow();
    await expect(
      controller.deleteUser(mockRequest({ params: {} }), {} as FastifyReply),
    ).rejects.toThrow();
    await expect(
      controller.suspendUser(mockRequest({ params: undefined }), {} as FastifyReply),
    ).rejects.toThrow();
    await expect(
      controller.unsuspendUser(mockRequest({ params: {} }), {} as FastifyReply),
    ).rejects.toThrow();
  });

  it('avatar handlers delegate to user service', async () => {
    await controller.uploadAvatar(
      mockRequest({ body: { avatar_key: 'avatars/user/avatar.png' } }),
      {} as FastifyReply,
    );
    const deleteAvatarReply = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    await controller.deleteAvatar(mockRequest(), deleteAvatarReply as unknown as FastifyReply);
    expect(deleteAvatarReply.code).toHaveBeenCalledWith(204);
    expect(userService.uploadAvatar).toHaveBeenCalled();
    expect(userService.deleteAvatar).toHaveBeenCalled();
  });

  it('listUsers exposes estimated_total when include_total opts into count(*)', async () => {
    vi.mocked(userService.listUsers).mockResolvedValueOnce({
      items: [{ id: userPublicId }],
      limit: 10,
      total: 50,
      has_more: true,
      next_cursor: 'cursor_next',
    } as never);
    const response = await controller.listUsers(
      mockRequest({ query: { limit: 10, include_total: 'true' } }),
      {} as FastifyReply,
    );
    expect(
      (response as { meta: { pagination: { has_more: boolean; next: string | null } } }).meta
        .pagination,
    ).toMatchObject({ has_more: true, next: 'cursor_next', estimated_total: 50 });
  });

  it('listUsers sets has_more false on the last page', async () => {
    vi.mocked(userService.listUsers).mockResolvedValueOnce({
      items: [],
      limit: 10,
      total: null,
      has_more: false,
      next_cursor: null,
    } as never);
    const response = await controller.listUsers(
      mockRequest({ query: { limit: 10, after: 'cursor_prev' } }),
      {} as FastifyReply,
    );
    expect(
      (response as { meta: { pagination: { has_more: boolean; next: string | null } } }).meta
        .pagination,
    ).toMatchObject({ has_more: false, next: null });
  });

  it('admin handlers treat missing userId param as empty string', async () => {
    await expect(
      controller.getUser(mockRequest({ params: {} }), {} as FastifyReply),
    ).rejects.toThrow();
    await expect(
      controller.updateUser(mockRequest({ params: {}, body: {} }), {} as FastifyReply),
    ).rejects.toThrow();
    await expect(
      controller.suspendUser(mockRequest({ params: {} }), {} as FastifyReply),
    ).rejects.toThrow();
    await expect(
      controller.unsuspendUser(mockRequest({ params: {} }), {} as FastifyReply),
    ).rejects.toThrow();
    await expect(
      controller.deleteUser(mockRequest({ params: {} }), {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as unknown as FastifyReply),
    ).rejects.toThrow();
  });
});
