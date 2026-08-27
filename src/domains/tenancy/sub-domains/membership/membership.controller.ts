import type { FastifyReply, FastifyRequest } from 'fastify';
import { paginatedResponse, successResponse } from '@/shared/utils/http/response.util.js';
import {
  getActingUserPublicId,
  getRequestIdentifier,
  requireAuth,
  requirePrincipal,
} from '@/shared/utils/http/request.util.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import type { MembershipService } from './membership.service.js';

/**
 * Builds the HTTP handler map for the active-organization membership routes
 * under `/organization/memberships` plus the self-service `leave` and
 * `transfer-ownership` actions. The active organization is resolved from the
 * signed JWT `org` claim via {@link resolveActiveOrganizationId}.
 */
export function createMembershipController(service: MembershipService) {
  return {
    listMemberships: async (request: FastifyRequest, _reply: FastifyReply) => {
      const scope = request.principalScope;
      const _organizationId = scope.organizationPublicId;
      const result = await service.list(scope, request.query);
      return paginatedResponse(result.items, getRequestIdentifier(request), {
        per_page: result.limit,
        next: result.next_cursor,
        has_more: result.has_more,
        ...(result.total !== null ? { estimated_total: result.total } : {}),
      });
    },
    getMembership: async (request: FastifyRequest, _reply: FastifyReply) => {
      const rawParams = (request.params as { membership_id: string }) ?? {
        membership_id: '',
      };
      // sec-re-18 (sec-B10 class): bind path params at the boundary so an
      // attacker-supplied string never flows into Sentry breadcrumbs, log
      // payloads, or metric labels with unbounded cardinality.
      const scope = request.principalScope;
      const _organizationId = scope.organizationPublicId;
      const membershipId = validatePublicIdParam(rawParams.membership_id ?? '', 'membership_id');
      const data = await service.getByPublicId(scope, membershipId);
      return successResponse(data, getRequestIdentifier(request));
    },
    createMembership: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const scope = request.principalScope;
      const _organizationId = scope.organizationPublicId;
      // REQ-1: "Add member" — the raw invitation token is delivered ONLY via email, never returned;
      // the response carries the created INVITED membership (with its embedded invitation ref).
      const data = await service.create(scope, request.body, getActingUserPublicId(auth), {
        requestId: getRequestIdentifier(request),
      });
      return successResponse(data, getRequestIdentifier(request));
    },
    updateMembership: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const rawParams = (request.params as { membership_id: string }) ?? {
        membership_id: '',
      };
      // sec-re-18 (sec-B10 class): bind path params at the boundary so an
      // attacker-supplied string never flows into Sentry breadcrumbs, log
      // payloads, or metric labels with unbounded cardinality.
      const scope = request.principalScope;
      const _organizationId = scope.organizationPublicId;
      const membershipId = validatePublicIdParam(rawParams.membership_id ?? '', 'membership_id');
      const data = await service.update(
        scope,
        membershipId,
        request.body,
        getActingUserPublicId(auth),
      );
      return successResponse(data, getRequestIdentifier(request));
    },
    deleteMembership: async (request: FastifyRequest, reply: FastifyReply) => {
      requirePrincipal(request);
      const rawParams = (request.params as { membership_id: string }) ?? {
        membership_id: '',
      };
      // sec-re-18 (sec-B10 class): bind path params at the boundary so an
      // attacker-supplied string never flows into Sentry breadcrumbs, log
      // payloads, or metric labels with unbounded cardinality.
      const scope = request.principalScope;
      const _organizationId = scope.organizationPublicId;
      const membershipId = validatePublicIdParam(rawParams.membership_id ?? '', 'membership_id');
      await service.delete(scope, membershipId);
      return reply.code(204).send();
    },
    getMembershipPermissions: async (request: FastifyRequest, _reply: FastifyReply) => {
      const rawParams = (request.params as { membership_id: string }) ?? {
        membership_id: '',
      };
      // sec-re-18 (sec-B10 class): bind path params at the boundary so an
      // attacker-supplied string never flows into Sentry breadcrumbs, log
      // payloads, or metric labels with unbounded cardinality.
      const scope = request.principalScope;
      const _organizationId = scope.organizationPublicId;
      const membershipId = validatePublicIdParam(rawParams.membership_id ?? '', 'membership_id');
      const data = await service.getPermissions(scope, membershipId);
      return successResponse(data, getRequestIdentifier(request));
    },
    leaveOrganization: async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = requireAuth(request);
      const scope = request.principalScope;
      const _organizationId = scope.organizationPublicId;
      await service.leaveOrganization(scope, auth.userId);
      return reply.code(204).send();
    },
    transferOwnership: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const scope = request.principalScope;
      const _organizationId = scope.organizationPublicId;
      const data = await service.transferOwnership(scope, request.body, auth.userId);
      return successResponse(data, getRequestIdentifier(request));
    },
  };
}
