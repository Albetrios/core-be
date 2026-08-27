import type { FastifyReply, FastifyRequest } from 'fastify';
import { paginatedResponse, successResponse } from '@/shared/utils/http/response.util.js';
import {
  getActingUserPublicId,
  getRequestIdentifier,
  requireAuth,
  requirePrincipal,
  resolvePrincipalDatabaseScope,
} from '@/shared/utils/http/request.util.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import {
  buildAuditActorFields,
  recordScopedAuditEvent,
} from '@/shared/utils/infrastructure/audit-request-context.util.js';
import type { OrganizationApiKeyService } from './organization-api-key.service.js';

/**
 * Builds the Fastify handler map for `/organization/api-keys` routes —
 * list, get, create (returns the raw key once), update, delete, and rotate.
 * Wraps service calls with principal validation, public-id validation, and the
 * standard response shapers. Create/rotate require a real user principal
 * because they mint new secrets and perform scope-grant checks.
 */
export function createOrganizationApiKeyController(service: OrganizationApiKeyService) {
  return {
    listApiKeys: async (request: FastifyRequest, _reply: FastifyReply) => {
      const scope = resolvePrincipalDatabaseScope(request);
      const _organizationId = scope.organizationPublicId;
      const result = await service.list(scope, request.query);
      return paginatedResponse(result.items, getRequestIdentifier(request), {
        per_page: result.limit,
        next: result.next_cursor,
        has_more: result.has_more,
        ...(result.total !== null ? { estimated_total: result.total } : {}),
      });
    },
    getApiKey: async (request: FastifyRequest, _reply: FastifyReply) => {
      const rawParams = (request.params as { api_key_id: string }) ?? {
        api_key_id: '',
      };
      // sec-re-18 (sec-B10 class): bind path params at the boundary so an
      // attacker-supplied string never flows into Sentry breadcrumbs, log
      // payloads, or metric labels with unbounded cardinality.
      const scope = resolvePrincipalDatabaseScope(request);
      const _organizationId = scope.organizationPublicId;
      const apiKeyId = validatePublicIdParam(rawParams.api_key_id ?? '', 'api_key_id');
      const data = await service.getByPublicId(scope, apiKeyId);
      return successResponse(data, getRequestIdentifier(request));
    },
    createApiKey: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const scope = resolvePrincipalDatabaseScope(request);
      const _organizationId = scope.organizationPublicId;
      const result = await service.create(scope, request.body, auth.userId);
      // Long-lived org bearer credentials: audit minting at WARNING so creation is never silent.
      await recordScopedAuditEvent(request, {
        actorUserPublicId: auth.userId,
        action: 'organization.api_key.create',
        resource_type: 'organization_api_key',
        severity: 'WARNING',
        metadata: { api_key_id: result.api_key.id },
      });
      return successResponse(
        { api_key: result.api_key, raw_key: result.raw_key },
        getRequestIdentifier(request),
      );
    },
    updateApiKey: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const rawParams = (request.params as { api_key_id: string }) ?? {
        api_key_id: '',
      };
      // sec-re-18 (sec-B10 class): bind path params at the boundary so an
      // attacker-supplied string never flows into Sentry breadcrumbs, log
      // payloads, or metric labels with unbounded cardinality.
      const scope = resolvePrincipalDatabaseScope(request);
      const _organizationId = scope.organizationPublicId;
      const apiKeyId = validatePublicIdParam(rawParams.api_key_id ?? '', 'api_key_id');
      const data = await service.update(scope, apiKeyId, request.body, getActingUserPublicId(auth));
      await recordScopedAuditEvent(request, {
        ...buildAuditActorFields(auth),
        action: 'organization.api_key.update',
        resource_type: 'organization_api_key',
        metadata: { api_key_id: apiKeyId },
      });
      return successResponse(data, getRequestIdentifier(request));
    },
    deleteApiKey: async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const rawParams = (request.params as { api_key_id: string }) ?? {
        api_key_id: '',
      };
      // sec-re-18 (sec-B10 class): bind path params at the boundary so an
      // attacker-supplied string never flows into Sentry breadcrumbs, log
      // payloads, or metric labels with unbounded cardinality.
      const scope = resolvePrincipalDatabaseScope(request);
      const _organizationId = scope.organizationPublicId;
      const apiKeyId = validatePublicIdParam(rawParams.api_key_id ?? '', 'api_key_id');
      await service.delete(scope, apiKeyId);
      // Revoking a long-lived org credential is a security-relevant change; audit at WARNING.
      await recordScopedAuditEvent(request, {
        ...buildAuditActorFields(auth),
        action: 'organization.api_key.revoke',
        resource_type: 'organization_api_key',
        severity: 'WARNING',
        metadata: { api_key_id: apiKeyId },
      });
      return reply.code(204).send();
    },
    rotateApiKey: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const rawParams = (request.params as { api_key_id: string }) ?? {
        api_key_id: '',
      };
      // sec-re-18 (sec-B10 class): bind path params at the boundary so an
      // attacker-supplied string never flows into Sentry breadcrumbs, log
      // payloads, or metric labels with unbounded cardinality.
      const scope = resolvePrincipalDatabaseScope(request);
      const _organizationId = scope.organizationPublicId;
      const apiKeyId = validatePublicIdParam(rawParams.api_key_id ?? '', 'api_key_id');
      const result = await service.rotate(scope, apiKeyId, auth.userId);
      // Rotation mints a new secret and invalidates the old one — audit at WARNING.
      await recordScopedAuditEvent(request, {
        actorUserPublicId: auth.userId,
        action: 'organization.api_key.rotate',
        resource_type: 'organization_api_key',
        severity: 'WARNING',
        metadata: { api_key_id: apiKeyId },
      });
      return successResponse(
        { api_key: result.api_key, raw_key: result.raw_key },
        getRequestIdentifier(request),
      );
    },
  };
}
