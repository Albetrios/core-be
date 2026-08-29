import type { FastifyReply, FastifyRequest } from 'fastify';
import { successResponse } from '@/shared/utils/http/response.util.js';
import { getRequestIdentifier, requireAuth } from '@/shared/utils/http/request.util.js';
import { ConflictError, UnauthorizedError } from '@/shared/errors/index.js';
import { requireAllowedSourceOriginForCookieSessionRoute } from '@/shared/middlewares/session/cookie-session-origin.pre-handler.js';
import { recordScopedAuditEvent } from '@/shared/utils/infrastructure/audit-request-context.util.js';
import { verifyAccessToken } from '@/shared/utils/security/jwt.util.js';
import {
  clearSessionCookie,
  parseSessionCookieValue,
  SESSION_COOKIE_NAME,
  setSessionCookie,
} from '@/domains/auth/auth.http.util.js';
import { AuthSerializer } from '@/domains/auth/auth.serializer.js';
import { serializeAuthSessions } from '@/domains/auth/sub-domains/auth-session/auth-session.serializer.js';
import type { AuthContainer } from '@/domains/auth/auth.container.js';

type AuthSessionHandlersDependencies = Pick<
  AuthContainer,
  'authService' | 'authSessionService' | 'authMeContextService'
>;

/** Builds the session-management Fastify handlers: `logout`, `refreshToken` (cookie + origin allowlist), `listSessions`, `revokeSession`, `revokeAllSessions`, and the active-organization `switch-to-*` handlers. */
export function createAuthSessionHandlers({
  authService,
  authSessionService,
  authMeContextService,
}: AuthSessionHandlersDependencies) {
  return {
    logout: async (request: FastifyRequest, reply: FastifyReply) => {
      const authorizationHeader = request.headers.authorization;
      const match = authorizationHeader?.match(/^Bearer\s+(\S.*)$/i);
      const token = match?.[1];
      if (!token) {
        throw new UnauthorizedError('errors:missingAuthorizationHeader');
      }

      let actorUserPublicId: string | undefined;
      try {
        const payload = await verifyAccessToken(token);
        actorUserPublicId = payload.userId;
      } catch {
        // proceed with logout even if token is expired
      }

      await authService.logout(token);

      if (actorUserPublicId) {
        await recordScopedAuditEvent(request, {
          actorUserPublicId,
          action: 'auth.logout',
          resource_type: 'session',
        });
      }

      clearSessionCookie(reply);

      return reply.code(204).send();
    },
    listSessions: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      const data = await authSessionService.list(auth.userId);
      return successResponse(
        serializeAuthSessions(data, { currentSessionPublicId: auth.sessionPublicId ?? null }),
        getRequestIdentifier(request),
      );
    },
    revokeSession: async (
      request: FastifyRequest<{ Params: { session_id: string } }>,
      reply: FastifyReply,
    ) => {
      const auth = requireAuth(request);
      // route-#9: this endpoint revokes OTHER sessions; revoking the current one leaves a stale
      // session cookie and contradicts the documented contract — direct the caller to logout
      // (which also clears the cookie) instead of silently 401-ing their own next request.
      if (
        auth.sessionPublicId !== undefined &&
        auth.sessionPublicId === request.params.session_id
      ) {
        throw new ConflictError('errors:cannotRevokeCurrentSession');
      }
      await authSessionService.revoke(auth.userId, request.params.session_id);
      await recordScopedAuditEvent(request, {
        actorUserPublicId: auth.userId,
        action: 'auth.session.revoke',
        resource_type: 'session',
        metadata: { session_public_id: request.params.session_id },
      });
      return reply.code(204).send();
    },
    refreshToken: async (request: FastifyRequest, reply: FastifyReply) => {
      requireAllowedSourceOriginForCookieSessionRoute(request);
      // eslint-disable-next-line security/detect-object-injection -- SESSION_COOKIE_NAME is a constant.
      const rawSessionCookie = request.cookies?.[SESSION_COOKIE_NAME];
      const parsedSession = rawSessionCookie ? parseSessionCookieValue(rawSessionCookie) : null;
      if (!parsedSession) {
        throw new UnauthorizedError('errors:missingSessionCookie');
      }
      const data = await authService.refreshToken({
        sessionPublicId: parsedSession.sessionPublicId,
        refreshSecret: parsedSession.refreshSecret,
      });
      setSessionCookie(reply, parsedSession.sessionPublicId, data.refresh_secret);
      return successResponse(AuthSerializer.accessToken(data), getRequestIdentifier(request));
    },
    switchToPersonalOrganization: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      if (auth.kind !== 'user' || !auth.sessionPublicId) {
        throw new UnauthorizedError('errors:invalidOrExpiredSession');
      }
      const data = await authService.switchToPersonal({
        userPublicId: auth.userId,
        sessionPublicId: auth.sessionPublicId,
      });
      // Post-gate read: the switch above re-minted the token (the membership/ownership gate ran in
      // the service), so resolving the new active organization + permissions here exposes only what the caller
      // is already scoped to. Returned inline so the client skips a follow-up GET /auth/me/context.
      const context = await authMeContextService.getActiveOrganizationContext({
        userPublicId: auth.userId,
        organizationPublicId: data.organization_public_id,
        globalRole: auth.role,
      });
      // A switch re-mints the access token with a different `org` claim (tenant-context change), so
      // lateral movement between tenants on one session is traceable.
      await recordScopedAuditEvent(request, {
        actorUserPublicId: auth.userId,
        action: 'auth.organization.switch',
        resource_type: 'session',
        metadata: { session_public_id: auth.sessionPublicId, target: 'personal' },
      });
      return successResponse(
        AuthSerializer.accessTokenWithActiveOrganization(data, context),
        getRequestIdentifier(request),
      );
    },
    switchToOrganization: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requireAuth(request);
      if (auth.kind !== 'user' || !auth.sessionPublicId) {
        throw new UnauthorizedError('errors:invalidOrExpiredSession');
      }
      // The route's zod `body` schema has already validated organization_id (400 otherwise).
      const { organization_id: organizationId } = request.body as { organization_id: string };
      const data = await authService.switchToOrganization({
        userPublicId: auth.userId,
        sessionPublicId: auth.sessionPublicId,
        organizationPublicId: organizationId,
      });
      // Post-gate read: switchToOrganization validated active membership (403 otherwise) and re-minted
      // the token, so resolving the new active organization + permissions here is scoped to what the caller may
      // already see. Returned inline so the client skips a follow-up GET /auth/me/context.
      const context = await authMeContextService.getActiveOrganizationContext({
        userPublicId: auth.userId,
        organizationPublicId: data.organization_public_id,
        globalRole: auth.role,
      });
      // A switch re-mints the access token with a different `org` claim (tenant-context change), so
      // lateral movement between tenants on one session is traceable.
      await recordScopedAuditEvent(request, {
        actorUserPublicId: auth.userId,
        action: 'auth.organization.switch',
        resource_type: 'session',
        metadata: {
          session_public_id: auth.sessionPublicId,
          target_organization_id: organizationId,
        },
      });
      return successResponse(
        AuthSerializer.accessTokenWithActiveOrganization(data, context),
        getRequestIdentifier(request),
      );
    },
    revokeAllSessions: async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = requireAuth(request);
      // sec-new-A3: preserve the caller's own session so the client is not
      // silently logged out. Extract the bearer token from the Authorization
      // header (always present after authenticate passes) and pass it to the
      // service so that session is excluded from revocation.
      const currentAccessToken =
        request.headers.authorization?.match(/^Bearer\s+(\S.*)$/i)?.[1] ?? '';
      await authSessionService.revokeAllSessionsExceptCurrent({
        userPublicId: auth.userId,
        currentAccessToken,
      });
      await recordScopedAuditEvent(request, {
        actorUserPublicId: auth.userId,
        action: 'auth.session.revoke_all',
        resource_type: 'session',
      });

      // sec-r4-A1: do NOT clear the session cookie here. revokeAllSessionsExceptCurrent
      // intentionally preserves the caller's own session (sec-new-A3) — clearing the cookie
      // would destroy the browser-side refresh token for that preserved session, silently
      // logging the caller out on their next token refresh despite the DB row being alive.
      // clearSessionCookie() is only called in logout, which explicitly terminates the
      // caller's own session.

      return reply.code(204).send();
    },
  };
}
