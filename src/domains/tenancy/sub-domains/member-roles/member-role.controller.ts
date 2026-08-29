import type { FastifyReply, FastifyRequest } from 'fastify';
import { paginatedResponse, successResponse } from '@/shared/utils/http/response.util.js';
import {
  getActingUserPublicId,
  getRequestIdentifier,
  requireOrganizationScope,
  requirePrincipal,
} from '@/shared/utils/http/request.util.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import { validateListMemberRolesQuery } from './member-role.validator.js';
import {
  buildAuditActorFields,
  recordScopedAuditEvent,
} from '@/shared/utils/infrastructure/audit-request-context.util.js';
import type { MemberRoleService } from './member-role.service.js';

/**
 * Builds the HTTP handler map for the organization role CRUD endpoints under
 * `/organization/roles`. Mutating handlers also record a scoped audit
 * event via {@link recordScopedAuditEvent} so role lifecycle changes appear in
 * the audit log.
 */
export function createMemberRoleController(service: MemberRoleService) {
  return {
    listRoles: async (request: FastifyRequest, _reply: FastifyReply) => {
      const scope = requireOrganizationScope(request);
      const _organizationId = scope.organizationPublicId;
      const pagination = validateListMemberRolesQuery(request.query);
      const result = await service.list(scope, pagination);
      return paginatedResponse(result.items, getRequestIdentifier(request), {
        per_page: result.limit,
        next: result.next_cursor,
        has_more: result.has_more,
        ...(result.total !== null ? { estimated_total: result.total } : {}),
      });
    },
    getRole: async (request: FastifyRequest, _reply: FastifyReply) => {
      const { role_id: rawRoleId } = (request.params as {
        role_id: string;
      }) ?? { role_id: '' };
      // sec-new-T3: reject malformed path params before reaching the service layer.
      const scope = requireOrganizationScope(request);
      const _organizationId = scope.organizationPublicId;
      const roleId = validatePublicIdParam(rawRoleId ?? '', 'role_id');
      const data = await service.getByPublicId(scope, roleId);
      return successResponse(data, getRequestIdentifier(request));
    },
    createRole: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const scope = requireOrganizationScope(request);
      const organizationId = scope.organizationPublicId;
      const data = await service.create(scope, request.body, getActingUserPublicId(auth));
      await recordScopedAuditEvent(request, {
        ...buildAuditActorFields(auth),
        action: 'tenancy.role.create',
        resource_type: 'role',
        organizationPublicId: organizationId,
        metadata: { role_public_id: (data as { public_id?: string }).public_id },
      });
      return successResponse(data, getRequestIdentifier(request));
    },
    updateRole: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const { role_id: rawUpdateRoleId } = (request.params as {
        role_id: string;
      }) ?? { role_id: '' };
      // sec-new-T3: reject malformed path params before reaching the service layer.
      const scope = requireOrganizationScope(request);
      const organizationId = scope.organizationPublicId;
      const roleId = validatePublicIdParam(rawUpdateRoleId ?? '', 'role_id');
      const data = await service.update(scope, roleId, request.body, getActingUserPublicId(auth));
      await recordScopedAuditEvent(request, {
        ...buildAuditActorFields(auth),
        action: 'tenancy.role.update',
        resource_type: 'role',
        organizationPublicId: organizationId,
        metadata: { role_public_id: roleId },
      });
      return successResponse(data, getRequestIdentifier(request));
    },
    deleteRole: async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const { role_id: rawDeleteRoleId } = (request.params as {
        role_id: string;
      }) ?? { role_id: '' };
      // sec-new-T3: reject malformed path params before reaching the service layer.
      const scope = requireOrganizationScope(request);
      const organizationId = scope.organizationPublicId;
      const roleId = validatePublicIdParam(rawDeleteRoleId ?? '', 'role_id');
      await service.delete(scope, roleId);
      await recordScopedAuditEvent(request, {
        ...buildAuditActorFields(auth),
        action: 'tenancy.role.delete',
        resource_type: 'role',
        organizationPublicId: organizationId,
        metadata: { role_public_id: roleId },
      });
      return reply.code(204).send();
    },
  };
}
