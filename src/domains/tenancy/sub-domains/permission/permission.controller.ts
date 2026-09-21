import type { FastifyReply, FastifyRequest } from 'fastify';
import { applyCatalogCacheHeaders } from '@/shared/utils/http/http-cache.util.js';
import { paginatedResponse } from '@/shared/utils/http/response.util.js';
import { getRequestIdentifier } from '@/shared/utils/http/request.util.js';
import type { PermissionService } from './permission.service.js';

/**
 * Builds the HTTP handler map for `GET /permissions`. The list is a static
 * catalog so the response is annotated for HTTP caching via
 * {@link applyCatalogCacheHeaders}.
 */
export function createPermissionController(service: PermissionService) {
  return {
    listPermissions: async (request: FastifyRequest, reply: FastifyReply) => {
      // Already serialized by the service, which memoizes the response shape rather than the raw
      // rows — so a repeat read skips the serialize too, and the memo holds nothing but JSON.
      const data = await service.list();
      const payload = paginatedResponse(data, getRequestIdentifier(request), {
        per_page: data.length,
        next: null,
        has_more: false,
        estimated_total: data.length,
      });
      if (applyCatalogCacheHeaders(request, reply, payload)) {
        return reply;
      }
      return payload;
    },
  };
}
