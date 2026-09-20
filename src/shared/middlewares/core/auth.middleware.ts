import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ConfigurationError, UnauthorizedError } from '@/shared/errors/index.js';
import { verifyAccessToken } from '@/shared/utils/security/jwt.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { AuthContext } from '@/shared/types/index.js';
import { GLOBAL_ROLES, type GlobalRole } from '@/shared/constants/roles.constants.js';
import { resolveGlobalRoleForEmail } from '@/shared/utils/auth/global-admin-role.util.js';
import { applyApiKeyAuthentication } from '@/shared/middlewares/security/api-key-auth.middleware.js';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { attachRequestI18nHelpers } from '@/shared/middlewares/core/i18n.middleware.js';

function getBearerToken(request: FastifyRequest): string {
  const authorizationHeader = request.headers.authorization;
  if (!authorizationHeader) throw new UnauthorizedError('errors:missingAuthorizationHeader');
  const match = /^Bearer\s+(\S.*)$/i.exec(authorizationHeader);
  if (!match) throw new UnauthorizedError('errors:invalidAuthorizationHeaderFormat');
  return match[1]!;
}

/**
 * Re-derives the per-request role when the JWT carries `SUPER_ADMIN` (sec-A6).
 *
 * @remarks
 * The JWT bakes in `super_admin` at sign-time from the then-current `GLOBAL_ADMIN_EMAILS`.
 * Without this check, removing an email from the allowlist takes up to
 * `GLOBAL_ADMIN_ACCESS_TOKEN_EXPIRY_SECONDS` (default 5 min) to take effect — meaningful
 * during an active incident response. The middleware now re-derives super_admin against
 * the live allowlist on every request and downgrades on mismatch.
 *
 * Hot-path safe: only fires when the JWT actually claims SUPER_ADMIN (rare in production),
 * and reuses the existing `findUserRecordByPublicId` resolver. On any failure to resolve
 * the user, fails closed (downgrades to no role) so a missing user record cannot retain
 * admin privileges.
 *
 * audit-#16: when the user-domain is not wired this **fails closed** — a privileged claim can no
 * longer be accepted without live allowlist/account-state verification just because an
 * alternate/minimal entrypoint forgot to decorate `userDomain`. Production composition always wires
 * it, so a missing service is a configuration error (raised loudly) rather than a silent privilege
 * grant. Middleware test harnesses that exercise a privileged claim inject a stub `userService`
 * (see `auth.middleware.super-admin-rederive.unit.test.ts`) — dependency injection, not an env flag.
 */
async function rederiveSuperAdminRole(
  request: FastifyRequest,
  userPublicId: string,
): Promise<GlobalRole | undefined> {
  const userService = request.server.userDomain?.userService;
  if (!userService) {
    throw new ConfigurationError(
      'userDomain.userService is required to re-derive a privileged role; refusing to trust a SUPER_ADMIN claim without it',
    );
  }
  const user = await userService.findUserRecordByPublicId(userPublicId);
  if (!user) return undefined;
  // reaudit-#10 + reaudit-#13: gate the SUPER_ADMIN re-grant on the live account state, mirroring the
  // token-minting side (resolveAccessTokenRoleForUser requires status==='ACTIVE' AND a verified
  // email). Keeping the two derivation sites symmetric means safety here does not depend on the
  // invariant that no mint path emits a super_admin claim for an unverified allowlisted account: if
  // one ever did, this path would otherwise keep re-granting admin on every subsequent request. Fail
  // closed for any non-active OR unverified account (defense in depth alongside the session-layer
  // status check).
  if (user.status !== 'ACTIVE' || !user.is_email_verified) return undefined;
  const currentGlobalRole = resolveGlobalRoleForEmail(user.email);
  if (currentGlobalRole === GLOBAL_ROLES.SUPER_ADMIN) {
    return GLOBAL_ROLES.SUPER_ADMIN;
  }
  // Active but no longer in the allowlist — downgrade to USER.
  return GLOBAL_ROLES.USER;
}

async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.auth) {
    const apiKeyAuthenticated = await applyApiKeyAuthentication(request);
    if (!apiKeyAuthenticated) {
      await authenticateWithBearerToken(request);
    }
  }
  // Single attach point for every authentication path (C2): scope + the
  // claim-derived request.organizationId, then the organization default locale
  // (claim-driven — the pre-auth X-Organization-Id header is gone).
  attachRequestPrincipalScope(request);
  await applyOrganizationDefaultLocale(request);
}

async function authenticateWithBearerToken(request: FastifyRequest): Promise<void> {
  const token = getBearerToken(request);

  try {
    const payload = await verifyAccessToken(token);

    const authSessionService = request.server.authDomain?.authSessionService;
    if (!authSessionService) {
      throw new UnauthorizedError('errors:validation.invalidToken');
    }

    // sec-new-A2: pass userPublicId so verifyActiveAccessToken can check user.status
    // on every DB-path validation (cache miss), reducing suspension propagation to ≤60 s.
    const { sessionPublicId } = await authSessionService.verifyActiveAccessToken(
      token,
      payload.userId,
    );

    // sec-A6 / route-#6: re-derive ANY privileged claim (super_admin OR admin) per request against
    // live state, so removal from GLOBAL_ADMIN_EMAILS or account suspension takes effect
    // immediately (not at next token refresh, default 5-minute window) and a stale or forged
    // privileged claim is never trusted for the token lifetime. rederiveSuperAdminRole only ever
    // returns super_admin / user / undefined, so an `admin` claim is downgraded to the user's TRUE
    // role. (No code path mints `admin` today, but re-deriving it fails closed if one ever does.)
    // Regular users skip the lookup — preserves the existing hot-path latency.
    const claimedRole = payload.role ? (payload.role as GlobalRole) : undefined;
    // Anything that is not the ordinary `user` role is treated as a privileged claim and
    // re-derived. Listing the privileged values explicitly meant a claim carrying a value the
    // server no longer issues — a retired role, a typo, a forged string — fell through as
    // "not privileged" and was trusted verbatim for the token's lifetime. Inverting the test
    // fails closed: an unrecognised role is re-derived against live state like any other.
    const isPrivilegedClaim = claimedRole !== undefined && claimedRole !== GLOBAL_ROLES.USER;
    const effectiveRole = isPrivilegedClaim
      ? await rederiveSuperAdminRole(request, payload.userId)
      : claimedRole;

    request.auth = omitUndefined({
      kind: 'user',
      userId: payload.userId,
      role: effectiveRole,
      sessionPublicId,
      // Active organization (tenant scope) carried as a signed claim. Membership + RLS are
      // still re-checked per request — the claim is scope, not authority.
      organizationPublicId: payload.organizationPublicId,
    }) as AuthContext;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }
    throw new UnauthorizedError('errors:validation.invalidToken');
  }
}

/**
 * Attaches the request-minted {@link PrincipalDatabaseScope} as
 * `request.principalScope` — called by BOTH authentication paths (JWT here,
 * API key in `api-key-auth.middleware.ts`) immediately after `request.auth`
 * is set.
 *
 * @remarks
 * - **Algorithm:** the single common mint — whatever verified ids `request.auth`
 *   carries go into `PRINCIPAL_SCOPE.REQUEST` (API keys: organization only; users: user +
 *   organization claim when present). No route-contract decisions here: organization-permission
 *   403s come from the authorization layer, real-user 401s from `requireAuth`
 *   in controllers, and RLS fails closed regardless.
 * - **Failure modes:** none — unauthenticated requests never reach it.
 * - **Side effects:** sets `request.principalScope`.
 */
export function attachRequestPrincipalScope(request: FastifyRequest): void {
  const auth = request.auth;
  if (!auth) return;
  request.principalScope =
    auth.kind === 'apiKey'
      ? PRINCIPAL_SCOPE.REQUEST({ organizationPublicId: auth.organizationPublicId })
      : PRINCIPAL_SCOPE.REQUEST({
          userPublicId: auth.userId,
          organizationPublicId: auth.organizationPublicId,
        });
  // Claim-derived organization decoration — the only writer since the
  // X-Organization-Id header (and tenant middleware) were removed. Consumers
  // (idempotency scope, rate-limit keys, error-handler context, i18n) now see a
  // VERIFIED value or null, never an attacker-controlled header.
  (request as FastifyRequest & { organizationId: string | null }).organizationId =
    auth.organizationPublicId ?? null;
}

/**
 * Applies the organization's default locale when the client sent no
 * `Accept-Language` — claim-driven replacement for the removed pre-auth
 * header flow (which was an unauthenticated DB-lookup amplification vector).
 *
 * @remarks
 * - **Algorithm:** skip when `Accept-Language` is present or no organization is
 *   in scope; otherwise resolve the organization's `default_locale` (Redis-cached)
 *   and re-attach the request i18n helpers with it.
 * - **Failure modes:** none surfaced — locale resolution errors fall back to the
 *   default locale inside the settings service.
 * - **Side effects:** may rebind `request.t` / `request.language` / `request.i18n`.
 */
async function applyOrganizationDefaultLocale(request: FastifyRequest): Promise<void> {
  if (request.headers['accept-language']) return;
  const organizationPublicId = request.auth?.organizationPublicId;
  if (!organizationPublicId) return;
  const organizationSettingsService = request.server.tenancyDomain?.organizationSettingsService;
  if (!organizationSettingsService) return; // minimal entrypoints / unit harnesses without tenancy wiring
  const organizationDefaultLocale =
    await organizationSettingsService.resolveDefaultLocaleForOrganization(organizationPublicId);
  attachRequestI18nHelpers(
    request,
    request as unknown as Parameters<typeof attachRequestI18nHelpers>[1],
    organizationDefaultLocale,
  );
}

const authMiddleware: FastifyPluginAsync = async (app) => {
  app.decorateRequest('auth', null);
  // Claim-derived organization decoration (writer: attachRequestPrincipalScope).
  app.decorateRequest('organizationId', null);
  // The principal scope is a plain per-request property, eagerly assigned by
  // attachRequestPrincipalScope the moment authentication succeeds (both JWT
  // and API-key paths) — undefined on public/unauthenticated routes.
  app.decorateRequest('principalScope', null as never);
  app.decorate('authenticate', authenticate);
};

export default fp(authMiddleware, { name: 'auth-middleware' });
