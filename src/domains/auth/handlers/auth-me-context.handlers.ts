import type { FastifyReply, FastifyRequest } from 'fastify';
import { successResponse } from '@/shared/utils/http/response.util.js';
import {
  getRequestIdentifier,
  requireAuth,
  requireUserPrincipalDatabaseScope,
} from '@/shared/utils/http/request.util.js';
import { serializeAuthMeContext } from '@/domains/auth/auth-me-context.serializer.js';
import type { AuthContainer } from '@/domains/auth/auth.container.js';

type AuthMeContextHandlersDependencies = Pick<AuthContainer, 'authMeContextService'>;

/** Builds the `GET /auth/me/context` handler — the single authoritative call returning the caller's identity, active org (+capabilities), resolved permissions, global role, and org-switcher list. */
export function createAuthMeContextHandlers({
  authMeContextService,
}: AuthMeContextHandlersDependencies) {
  return {
    getMeContext: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const data = await authMeContextService.getContext({
        scope: requireUserPrincipalDatabaseScope(request),
        globalRole: auth.role,
      });
      return successResponse(serializeAuthMeContext(data), getRequestIdentifier(request));
    },
  };
}
