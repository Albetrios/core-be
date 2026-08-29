import type { FastifyReply, FastifyRequest } from 'fastify';
import { successResponse, paginatedResponse } from '@/shared/utils/http/response.util.js';
import {
  getRequestIdentifier,
  requireAuth,
  requireUserScope,
} from '@/shared/utils/http/request.util.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import { recordScopedAuditEvent } from '@/shared/utils/infrastructure/audit-request-context.util.js';
import type { UserContainer } from './user.container.js';

type AdminUserAuditAction =
  | 'user.admin.update'
  | 'user.admin.delete'
  | 'user.admin.suspend'
  | 'user.admin.unsuspend';

function getUserIdParam(request: FastifyRequest): string {
  return validatePublicIdParam((request.params as { user_id: string }).user_id ?? '', 'user_id');
}

async function recordAdminUserAudit(
  request: FastifyRequest,
  actorUserPublicId: string,
  action: AdminUserAuditAction,
  targetUserPublicId: string,
  severity?: 'WARNING',
): Promise<void> {
  await recordScopedAuditEvent(request, {
    actorUserPublicId,
    action,
    resource_type: 'user',
    ...(severity ? { severity } : {}),
    metadata: { target_user_public_id: targetUserPublicId },
  });
}

/**
 * Build the user-domain HTTP handler map covering self-service profile, settings, notification
 * preferences, avatar upload/delete, and admin list/get/update/suspend/unsuspend/delete. Settings
 * mutations also emit a scoped audit event (`user.settings.update`) via the request audit context.
 */
export function createUserController({
  userService,
  userSettingsService,
  userNotificationPreferencesService,
}: Pick<
  UserContainer,
  'userService' | 'userSettingsService' | 'userNotificationPreferencesService'
>) {
  return {
    // ── Self-service ──────────────────────────────────────────

    getMe: async (request: FastifyRequest, _reply: FastifyReply) => {
      const _auth = requireAuth(request);
      const data = await userService.getMe(requireUserScope(request));
      return successResponse(data, getRequestIdentifier(request));
    },

    patchMe: async (request: FastifyRequest, _reply: FastifyReply) => {
      const _auth = requireAuth(request);
      const data = await userService.updateMe(requireUserScope(request), request.body);
      return successResponse(data, getRequestIdentifier(request));
    },

    completeOnboardingMe: async (request: FastifyRequest, _reply: FastifyReply) => {
      const _auth = requireAuth(request);
      const data = await userService.completeOnboarding(requireUserScope(request));
      return successResponse(data, getRequestIdentifier(request));
    },

    deleteMe: async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = requireAuth(request);
      await userService.deleteMe(auth.userId);
      // sec-U9: audit self-initiated account offboarding at WARNING so support can
      // distinguish "user deleted their own account" from "admin deleted it".
      await recordScopedAuditEvent(request, {
        actorUserPublicId: auth.userId,
        action: 'user.self.delete',
        resource_type: 'user',
        severity: 'WARNING',
      });
      return reply.status(204).send();
    },

    getSettings: async (request: FastifyRequest, _reply: FastifyReply) => {
      const _auth = requireAuth(request);
      const data = await userSettingsService.get(requireUserScope(request));
      return successResponse(data, getRequestIdentifier(request));
    },

    patchSettings: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const data = await userSettingsService.update(requireUserScope(request), request.body);
      await recordScopedAuditEvent(request, {
        actorUserPublicId: auth.userId,
        action: 'user.settings.update',
        resource_type: 'user_settings',
      });
      return successResponse(data, getRequestIdentifier(request));
    },

    getNotificationPreferences: async (request: FastifyRequest, _reply: FastifyReply) => {
      const _auth = requireAuth(request);
      const data = await userNotificationPreferencesService.get(requireUserScope(request));
      return successResponse(data, getRequestIdentifier(request));
    },

    putNotificationPreferences: async (request: FastifyRequest, _reply: FastifyReply) => {
      const _auth = requireAuth(request);
      const data = await userNotificationPreferencesService.put(
        requireUserScope(request),
        request.body,
      );
      return successResponse(data, getRequestIdentifier(request));
    },

    uploadAvatar: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const data = await userService.uploadAvatar(auth.userId, request.body);
      return successResponse(data, getRequestIdentifier(request));
    },

    deleteAvatar: async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = requireAuth(request);
      await userService.deleteAvatar(auth.userId);
      return reply.code(204).send();
    },

    // ── Admin ─────────────────────────────────────────────────

    listUsers: async (request: FastifyRequest, _reply: FastifyReply) => {
      const result = await userService.listUsers(request.query);
      return paginatedResponse(result.items, getRequestIdentifier(request), {
        per_page: result.limit,
        next: result.next_cursor,
        has_more: result.has_more,
        ...(result.total !== null ? { estimated_total: result.total } : {}),
      });
    },

    getUser: async (request: FastifyRequest, _reply: FastifyReply) => {
      const userId = getUserIdParam(request);
      const data = await userService.getUser(userId);
      return successResponse(data, getRequestIdentifier(request));
    },

    updateUser: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const userId = getUserIdParam(request);
      const data = await userService.adminUpdateUser(userId, request.body);
      // sec-U9: every admin user-management action emits an audit row so a rogue
      // admin cannot wipe accounts without leaving a platform-visible trace.
      await recordAdminUserAudit(request, auth.userId, 'user.admin.update', userId);
      return successResponse(data, getRequestIdentifier(request));
    },

    deleteUser: async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = requireAuth(request);
      const userId = getUserIdParam(request);
      await userService.deleteUser(userId);
      await recordAdminUserAudit(request, auth.userId, 'user.admin.delete', userId, 'WARNING');
      return reply.status(204).send();
    },

    suspendUser: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const userId = getUserIdParam(request);
      const data = await userService.suspendUser(userId);
      await recordAdminUserAudit(request, auth.userId, 'user.admin.suspend', userId, 'WARNING');
      return successResponse(data, getRequestIdentifier(request));
    },

    unsuspendUser: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const userId = getUserIdParam(request);
      const data = await userService.unsuspendUser(userId);
      await recordAdminUserAudit(request, auth.userId, 'user.admin.unsuspend', userId, 'WARNING');
      return successResponse(data, getRequestIdentifier(request));
    },
  };
}
