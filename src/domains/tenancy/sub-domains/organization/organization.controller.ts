import type { FastifyReply, FastifyRequest } from 'fastify';
import { paginatedResponse, successResponse } from '@/shared/utils/http/response.util.js';
import {
  getActingUserPublicId,
  getRequestIdentifier,
  requireAuth,
  requireOrganizationScope,
  requirePrincipal,
} from '@/shared/utils/http/request.util.js';
import type { OrganizationService } from './organization.service.js';
import type { AuditService } from '@/domains/audit/audit.service.js';
import { AuditSerializer } from '@/domains/audit/audit.serializer.js';

/**
 * Builds the Fastify handler map for the organization routes — account-level
 * `/organizations` (list, create, by-slug lookup) and the active-organization
 * `/organization` resource (get/update/delete, logo upload/delete, audit-log
 * listing). Wraps service calls with `requireAuth`, public-id validation, and
 * `successResponse` / `paginatedResponse` shaping. The optional
 * {@link AuditService} is required only by `listOrganizationAuditLogs`.
 */
export function createOrganizationController(
  service: OrganizationService,
  auditService?: AuditService,
) {
  return {
    listOrganizations: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const result = await service.list(request.query, auth.userId, auth.role);
      return paginatedResponse(result.items, getRequestIdentifier(request), {
        per_page: result.limit,
        next: result.next_cursor,
        has_more: result.has_more,
        ...(result.total !== null ? { estimated_total: result.total } : {}),
      });
    },
    getOrganization: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const id = requireOrganizationScope(request).organizationPublicId;
      const data = await service.getByPublicId(id, auth.userId, auth.role);
      return successResponse(data, getRequestIdentifier(request));
    },
    getOrganizationBySlug: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const { slug } = (request.params as { slug: string }) ?? { slug: '' };
      const data = await service.getBySlug(slug, auth.userId, auth.role);
      return successResponse(data, getRequestIdentifier(request));
    },
    createOrganization: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const data = await service.create(request.body, auth.userId);
      return successResponse(data, getRequestIdentifier(request));
    },
    updateOrganization: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const id = requireOrganizationScope(request);
      const data = await service.update(id, request.body, getActingUserPublicId(auth));
      return successResponse(data, getRequestIdentifier(request));
    },
    deleteOrganization: async (request: FastifyRequest, reply: FastifyReply) => {
      requirePrincipal(request);
      const id = requireOrganizationScope(request);
      await service.delete(id);
      return reply.code(204).send();
    },
    uploadLogo: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const id = requireOrganizationScope(request);
      const data = await service.uploadLogo(id, request.body, getActingUserPublicId(auth));
      return successResponse(data, getRequestIdentifier(request));
    },
    deleteLogo: async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const id = requireOrganizationScope(request);
      await service.deleteLogo(id, getActingUserPublicId(auth));
      return reply.code(204).send();
    },
    listOrganizationAuditLogs: async (request: FastifyRequest, _reply: FastifyReply) => {
      if (!auditService) throw new Error('Audit service not configured');
      const scope = requireOrganizationScope(request);
      const organizationId = scope.organizationPublicId;
      const query = {
        ...(request.query as Record<string, unknown>),
        organization_id: organizationId,
      };
      const result = await auditService.listForOrganization(organizationId, query);
      // sec-T finding #4 + sec-re-08: route organization-scoped audit log rows through
      // `AuditSerializer.many` so (a) the sensitive-metadata denylist runs and
      // (b) the strip-only allowlist drops every top-level bigint id, surfacing
      // the resolved actor/target/organization public ids instead. The admin
      // path (`audit.controller.ts`) does the same.
      return paginatedResponse(
        AuditSerializer.many(result.items, result.resolution),
        getRequestIdentifier(request),
        {
          per_page: result.limit,
          next: result.next_cursor,
          has_more: result.has_more,
          ...(result.total !== null ? { estimated_total: result.total } : {}),
        },
      );
    },
  };
}
