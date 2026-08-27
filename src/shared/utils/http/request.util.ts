import type { FastifyRequest } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '@/shared/errors/index.js';
import type { ApiKeyAuthContext, AuthContext, UserAuthContext } from '@/shared/types/index.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
  type UserPrincipalDatabaseScope,
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
 * then scopes data to (and binds the RLS GUC to via `withPrincipalDatabaseContext`). If the
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
 * Mints the {@link PrincipalDatabaseScope} for the authenticated request — the single
 * token-derived identity object services relay into `withPrincipalDatabaseContext`.
 *
 * @remarks
 * - **Algorithm:** requires an authenticated principal. A user principal yields
 *   `userPublicId` plus `organizationPublicId` resolved with the SAME
 *   path-param-else-claim precedence (and validation) as
 *   {@link resolveActiveOrganizationId}. An API-key principal yields only the
 *   organization pinned to the key — API keys have no user identity.
 * - **Failure modes:** {@link UnauthorizedError} when unauthenticated;
 *   {@link ForbiddenError} (`errors:organizationContextRequired`) when no
 *   organization resolves; `ValidationError` when a supplied organization id is
 *   malformed.
 * - **Side effects:** none.
 * - **Notes:** the organization is ALWAYS present — under the personal/team
 *   organization model every authenticated principal carries an active
 *   organization (users hold a personal-or-team `org` claim from login/switch;
 *   API keys are pinned to one). A token without one is stale/malformed, not a
 *   different scope, so this single common minter rejects it rather than
 *   modelling an org-less variant. Use {@link requireUserPrincipalDatabaseScope}
 *   when the route additionally requires a real end user (rejects API keys).
 */
export function resolvePrincipalDatabaseScope(
  request: FastifyRequest,
): OrganizationPrincipalDatabaseScope {
  const auth = requirePrincipal(request);
  if (auth.kind === 'apiKey') {
    return createPrincipalDatabaseScope({
      organizationPublicId: validatePublicIdParam(auth.organizationPublicId, 'organization_id'),
      source: 'token',
    }) as OrganizationPrincipalDatabaseScope;
  }
  const params = request.params as Record<string, string> | undefined;
  const organizationId = params?.organization_id ?? auth.organizationPublicId;
  // Parity with resolveActiveOrganizationId: an empty-string path value is "no
  // organization in scope" (403), not a malformed id (400).
  if (!organizationId) {
    throw new ForbiddenError('errors:organizationContextRequired');
  }
  return createPrincipalDatabaseScope({
    userPublicId: auth.userId,
    organizationPublicId: validatePublicIdParam(organizationId, 'organization_id'),
    source: 'token',
  }) as OrganizationPrincipalDatabaseScope;
}

/**
 * Mints a {@link UserPrincipalDatabaseScope} — the common scope narrowed to routes
 * that require a real end user: rejects API-key principals with
 * {@link UnauthorizedError} (matching {@link requireAuth} semantics), so
 * `userPublicId` is guaranteed; the organization is included when present (org-less tokens are the /users/me self-heal transitional state).
 */
export function requireUserPrincipalDatabaseScope(
  request: FastifyRequest,
): UserPrincipalDatabaseScope {
  const auth = requireAuth(request);
  const params = request.params as Record<string, string> | undefined;
  const organizationId = params?.organization_id ?? auth.organizationPublicId;
  return createPrincipalDatabaseScope({
    userPublicId: auth.userId,
    // Org-less is legitimate on the user family (the /users/me self-heal
    // provisions the personal organization on demand); include the org GUC
    // only when a validated claim/param is present.
    organizationPublicId: organizationId
      ? validatePublicIdParam(organizationId, 'organization_id')
      : undefined,
    source: 'token',
  }) as UserPrincipalDatabaseScope;
}
