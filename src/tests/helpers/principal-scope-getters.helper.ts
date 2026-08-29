import type { FastifyRequest } from 'fastify';
import { attachRequestPrincipalScope } from '@/shared/middlewares/core/auth.middleware.js';

/**
 * Mirrors the auth middleware's eager `request.principalScope` attachment on a
 * hand-built fake request, so controller unit suites exercise the REAL request
 * mint (`PRINCIPAL_SCOPE.REQUEST` over `request.auth`) exactly as the
 * production middleware does. Implemented as a lazy getter because test
 * factories often set `request.auth` AFTER building the request object.
 *
 * Fixture bridge: many controller factories predate the personal/team-organization
 * claim model and carry the organization as a `params.organization_id` value
 * with a kind-less user auth stub. Production routes carry no organization path param —
 * the claim is the only source — so the helper folds that legacy fixture shape
 * into the claim (`auth.organizationPublicId ?? params.organization_id`,
 * `kind` defaulting to `'user'`) before running the real attachment.
 */
export function attachPrincipalScopeGetters<T extends object>(request: T): T {
  Object.defineProperty(request, 'principalScope', {
    configurable: true,
    get: () => {
      const source = request as {
        auth?: Record<string, unknown> | null;
        params?: Record<string, string>;
      };
      const auth = source.auth;
      if (!auth) return undefined;
      const carrier = {
        auth: {
          kind: 'user',
          ...auth,
          organizationPublicId:
            (auth.organizationPublicId as string | undefined) ||
            source.params?.organization_id ||
            undefined,
        },
      } as unknown as FastifyRequest;
      attachRequestPrincipalScope(carrier);
      return (carrier as { principalScope?: unknown }).principalScope;
    },
  });
  return request;
}
