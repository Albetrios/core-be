import type { FastifyReply, FastifyRequest } from 'fastify';
import { paginatedResponse, successResponse } from '@/shared/utils/http/response.util.js';
import {
  getActingUserPublicId,
  getRequestIdentifier,
  requireOrganizationScope,
  requirePrincipal,
} from '@/shared/utils/http/request.util.js';
import type { MemberRolePermissionService } from './member-role-permission.service.js';
import { serializeMemberRolePermission } from './member-role-permission.serializer.js';

/**
 * Builds the HTTP handler map for role-to-permission assignment endpoints
 * (`GET /organization/roles/:role_id/permissions` and the matching `PUT`).
 * Resolves the active organization from the signed JWT `org` claim and the
 * role public id from the path param, then forwards to
 * {@link MemberRolePermissionService}.
 */
export function createMemberRolePermissionController(service: MemberRolePermissionService) {
  return {
    listRolePermissions: async (request: FastifyRequest, _reply: FastifyReply) => {
      const scope = requireOrganizationScope(request);
      const _organizationId = scope.organizationPublicId;
      const { role_id: roleId } = request.params as { role_id: string };
      const rows = await service.list(scope, roleId);
      const data = rows.map((row) => serializeMemberRolePermission(row, roleId));
      return paginatedResponse(data, getRequestIdentifier(request), {
        per_page: data.length,
        next: null,
        has_more: false,
        estimated_total: data.length,
      });
    },
    putRolePermissions: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const scope = requireOrganizationScope(request);
      const _organizationId = scope.organizationPublicId;
      const { role_id: roleId } = request.params as { role_id: string };
      const rows = await service.put(scope, roleId, request.body, getActingUserPublicId(auth));
      const data = rows.map((row) => serializeMemberRolePermission(row, roleId));
      return successResponse(data, getRequestIdentifier(request));
    },
  };
}
