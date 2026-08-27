import type { FastifyRequest } from 'fastify';
import {
  resolveTokenUserPrincipalScope,
  resolveTokenPrincipalScope,
} from '@/shared/utils/http/request.util.js';

/**
 * Mirrors the auth middleware's lazy `request.principalScope` /
 * `request.userPrincipalScope` getters on a hand-built fake request, so
 * controller unit suites exercise the REAL request minters exactly as the
 * decorated production request does.
 */
export function attachPrincipalScopeGetters<T extends object>(request: T): T {
  Object.defineProperty(request, 'principalScope', {
    configurable: true,
    get: () => resolveTokenPrincipalScope(request as unknown as FastifyRequest),
  });
  Object.defineProperty(request, 'userPrincipalScope', {
    configurable: true,
    get: () => resolveTokenUserPrincipalScope(request as unknown as FastifyRequest),
  });
  return request;
}
