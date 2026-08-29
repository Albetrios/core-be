import type { FastifyRequest } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '@/shared/errors/index.js';
import type { ApiKeyAuthContext, AuthContext, UserAuthContext } from '@/shared/types/index.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import type {
  OrganizationPrincipalDatabaseScope,
  PrincipalDatabaseScope,
  UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

/** Returns the per-request id Fastify generates (used for log correlation, audit fields, idempotency). */
export function getRequestIdentifier(request: FastifyRequest): string {
  return request.id;
}

/** Type guard: narrows `auth` to an end-user principal (`kind: 'user'`). */
export function isUserPrincipal(auth: AuthContext): auth is UserAuthContext {
  return auth.kind === 'user';
}

/** Type guard: narrows `auth` to an organization API-key principal (`kind: 'apiKey'`). */
export function isApiKeyPrincipal(auth: AuthContext): auth is ApiKeyAuthContext {
  return auth.kind === 'apiKey';
}

/**
 * Returns the acting **user** public id, or `undefined` for an API-key principal. Use when
 * attributing a write to a user (e.g. `created_by`) so API-key actions resolve to a null user
 * actor rather than a misleading empty string.
 */
export function getActingUserPublicId(auth: AuthContext): string | undefined {
  return auth.kind === 'user' ? auth.userId : undefined;
}

/**
 * Returns a stable actor id for logging / rate-limit bucketing / observability: the user public
 * id for user principals, or the API-key public id for API-key principals. Never empty.
 */
export function getAuthenticatedActorId(auth: AuthContext): string {
  return auth.kind === 'user' ? auth.userId : auth.apiKeyPublicId;
}

/**
 * Returns the authenticated {@link UserAuthContext} for a **user** principal or throws
 * {@link UnauthorizedError}. Use in controllers/services that require a real end user; do not
 * dereference `request.auth` directly.
 *
 * @remarks
 * Intentionally rejects organization API-key principals. Routes that legitimately accept API
 * keys — those guarded by a `requireOrganizationPermission` preHandler — must use
 * {@link requirePrincipal} and narrow with {@link isApiKeyPrincipal} / {@link getActingUserPublicId}.
 */
export function requireAuth(request: FastifyRequest): UserAuthContext {
  const auth = request.auth;
  if (auth?.kind !== 'user') throw new UnauthorizedError();
  return auth;
}

/**
 * Returns the authenticated principal ({@link AuthContext}) for **either** a user or an
 * organization API-key principal, or throws {@link UnauthorizedError}.
 *
 * @remarks
 * Callers that attribute writes to a user must narrow with {@link getActingUserPublicId}
 * (which yields `undefined` for API keys) rather than assuming a `userId` is present. Does
 * **not** replace {@link requireAuth} on user-only routes.
 */
export function requirePrincipal(request: FastifyRequest): AuthContext {
  const auth = request.auth;
  if (!auth) throw new UnauthorizedError();
  return auth;
}

/**
 * Resolves the active organization public id for an organization-scoped request and validates
 * its shape, throwing {@link ForbiddenError} (`errors:organizationContextRequired`) when no
 * organization is in scope and {@link ValidationError} when the resolved value is malformed.
 *
 * @remarks
 * Uses the **exact same precedence** as `requireOrganizationPermission`: the `{organization_id}`
 * path param when the route carries one, otherwise the signed `org` token claim
 * (`auth.organizationPublicId`). Matching that precedence is a security invariant — the
 * organization the permission preHandler authorized MUST equal the organization the controller
 * then scopes data to (and binds the RLS GUC to via `withAppDatabaseContext`). If the
 * two could diverge (e.g. one read the path while the other read the claim) a caller could be
 * permission-checked against organization A while reading/writing organization B. The claim is
 * scope, not authority: membership is still verified by `requireOrganizationPermission` and RLS
 * re-checked per request. This is the single accessor flattened (path-param-free) routes use to
 * resolve their tenant from the access token.
 */
export function resolveActiveOrganizationId(request: FastifyRequest): string {
  const params = request.params as Record<string, string> | undefined;
  const fromPath = params?.organization_id;
  const fromClaim = request.auth?.organizationPublicId;
  const organizationId = fromPath ?? fromClaim;
  if (!organizationId) {
    throw new ForbiddenError('errors:organizationContextRequired');
  }
  return validatePublicIdParam(organizationId, 'organization_id');
}

/**
 * Narrows the middleware-attached `request.principalScope` to an
 * organization-bearing scope — the `requireAuth`-family accessor for organization-scoped
 * routes. Mints nothing: the scope was already attached by the auth middleware;
 * this only enforces the route contract and narrows the type.
 *
 * @remarks
 * - **Failure modes:** {@link UnauthorizedError} when unauthenticated (no scope
 *   attached); {@link ForbiddenError} (`errors:organizationContextRequired`)
 *   when the token carries no active organization — under the personal/team
 *   organization model that is a stale/malformed token, not a different scope.
 * - **Side effects:** none.
 */
export function requireOrganizationScope(
  request: FastifyRequest,
): OrganizationPrincipalDatabaseScope {
  const scope = request.principalScope as PrincipalDatabaseScope | undefined;
  if (!scope) throw new UnauthorizedError();
  if (scope.organizationPublicId === undefined) {
    throw new ForbiddenError('errors:organizationContextRequired');
  }
  return scope as OrganizationPrincipalDatabaseScope;
}

/**
 * Narrows the middleware-attached `request.principalScope` to a user-bearing
 * scope — the `requireAuth`-family accessor for user-owned resources (rejects
 * API-key principals, matching {@link requireAuth} semantics; the organization
 * stays optional — organization-less tokens are the /users/me self-heal transitional
 * state). Mints nothing.
 *
 * @remarks
 * - **Failure modes:** {@link UnauthorizedError} when unauthenticated or when
 *   the principal is an API key (no user identity).
 * - **Side effects:** none.
 */
export function requireUserScope(request: FastifyRequest): UserPrincipalDatabaseScope {
  const scope = request.principalScope as PrincipalDatabaseScope | undefined;
  if (scope?.userPublicId === undefined) throw new UnauthorizedError();
  return scope as UserPrincipalDatabaseScope;
}
