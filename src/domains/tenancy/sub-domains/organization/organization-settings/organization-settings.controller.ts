import type { FastifyReply, FastifyRequest } from 'fastify';
import { successResponse } from '@/shared/utils/http/response.util.js';
import {
  getActingUserPublicId,
  getRequestIdentifier,
  requirePrincipal,
} from '@/shared/utils/http/request.util.js';
import type { OrganizationSettingsService } from './organization-settings.service.js';

/**
 * Builds the Fastify handler map for `/organization/settings` —
 * exposes a `getSettings` reader and a `updateSettings` writer that
 * upserts the row through {@link OrganizationSettingsService}.
 */
export function createOrganizationSettingsController(service: OrganizationSettingsService) {
  return {
    getSettings: async (request: FastifyRequest, _reply: FastifyReply) => {
      const scope = request.principalScope;
      const data = await service.get(scope);
      return successResponse(data, getRequestIdentifier(request));
    },
    updateSettings: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const scope = request.principalScope;
      const data = await service.update(scope, request.body, getActingUserPublicId(auth));
      return successResponse(data, getRequestIdentifier(request));
    },
  };
}
