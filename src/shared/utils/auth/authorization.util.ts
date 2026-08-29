import type { FastifyReply, FastifyRequest } from 'fastify';
import { resolveUserOrganizationPermissions } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import type { GlobalRole } from '@/shared/constants/roles.constants.js';
import { ForbiddenError, UnauthorizedError } from '@/shared/errors/index.js';
import { recordScopedAuditEvent } from '@/shared/utils/infrastructure/audit-request-context.util.js';

/**
 * Best-effort emit `auth.permission.denied` audit row before throwing
 * {@link ForbiddenError} (sec-U13). Volume is already bounded by the global
 * authenticated rate-limit middleware, so no bespoke per-(user, route)
 * throttle is added here. The audit write is awaited (so it lands before
 * the 403 reaches the client) but failures are swallowed — the
 * `ForbiddenError` path is unchanged. The `auditDomain` decorator is
 * optional-chained so callers without it (early-boot / unit tests) still
 * deny correctly.
 */
async function emitPermissionDenyAudit(
  request: FastifyRequest,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!request.server?.auditDomain?.auditService) return;
  const auth = request.auth;
  const actorUserPublicId = auth?.kind === 'user' ? auth.userId : undefined;
  try {
    await recordScopedAuditEvent(request, {
      actorUserPublicId,
      action: 'auth.permission.denied',
      resource_type: 'route',
      severity: 'WARNING',
      metadata,
    });
  } catch {
    // best-effort: a failure to record must not affect the 403 response.
  }
}

function buildDenyMetadata(
  request: FastifyRequest,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    route: request.routeOptions?.url ?? request.url,
    method: request.method,
    ...extra,
  };
}

/** Per-request memo: one Redis/DB resolve per (user, organization) per HTTP request. */
const organizationPermissionResolveMemo = new WeakMap<
  FastifyRequest,
  Map<string, Promise<string[]>>
>();

function buildOrganizationPermissionMemoKey(
  userPublicId: string,
  organizationPublicId: string,
): string {
  return `${userPublicId}:${organizationPublicId}`;
}

function resolveOrganizationPermissionsForRequest(
  request: FastifyRequest,
  userPublicId: string,
  organizationPublicId: string,
): Promise<string[]> {
  const memoKey = buildOrganizationPermissionMemoKey(userPublicId, organizationPublicId);
  let requestMemo = organizationPermissionResolveMemo.get(request);
  if (!requestMemo) {
    requestMemo = new Map();
    organizationPermissionResolveMemo.set(request, requestMemo);
  }
  const existing = requestMemo.get(memoKey);
  if (existing) {
    return existing;
  }
  const resolved = resolveUserOrganizationPermissions(userPublicId, organizationPublicId);
  requestMemo.set(memoKey, resolved);
  return resolved;
}

/**
 * Returns a Fastify preHandler that checks the authenticated user's global role.
 * Throws ForbiddenError if the user's role is not in the allowed list.
 *
 * Usage:
 *   { preHandler: [app.authenticate, requireRole(GLOBAL_ROLES.SUPER_ADMIN, GLOBAL_ROLES.ADMIN)] }
 */
export function requireRole(
  ...allowedRoles: GlobalRole[]
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const auth = request.auth;
    if (auth?.kind !== 'user') throw new UnauthorizedError();
    if (!(auth.role && allowedRoles.includes(auth.role))) {
      await emitPermissionDenyAudit(
        request,
        buildDenyMetadata(request, {
          deny_reason: 'insufficient_role',
          required_roles: allowedRoles,
          actor_role: auth.role,
        }),
      );
      throw new ForbiddenError('errors:insufficientRolePrivileges');
    }
  };
}

/**
 * Returns a Fastify preHandler that checks the authenticated user has a specific
 * permission within the **active organization** — the signed `org` token claim.
 *
 * Looks up: user -> membership -> role -> role_permissions
 *
 * @param permissionCode - The permission code to check (use domain constants, never bare strings)
 * @param paramName - Vestigial route-param fallback (default: 'organization_id'). After the route
 *   flatten no route carries an `{organization_id}` segment, so the organization is resolved from the token
 *   claim; the param lookup is retained only as a defensive fallback and is normally a no-op.
 *
 * Usage:
 *   { preHandler: [app.authenticate, requireOrganizationPermission(TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE)] }
 */
export function requireOrganizationPermission(
  permissionCode: string,
  paramName = 'organization_id',
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const auth = request.auth;
    if (!auth) throw new UnauthorizedError();

    const params = request.params as Record<string, string>;
    // Organization scope source: the signed `org` token claim (`auth.organizationPublicId`) — no
    // route carries an `{organization_id}` path param post-flatten, so the param lookup below is a
    // vestigial fallback that is normally undefined. The claim is scope, not authority: membership
    // is still verified below (and RLS re-checked per request). Kept aligned with
    // `resolveActiveOrganizationId` so authz and the data/RLS scope can never diverge.
    // eslint-disable-next-line security/detect-object-injection -- paramName is a function argument with a typed default.
    const organizationId = params[paramName] ?? auth.organizationPublicId;
    if (!organizationId) {
      throw new ForbiddenError('errors:organizationContextRequired');
    }

    if (auth.kind === 'apiKey') {
      // Fail closed: an API-key principal is pinned to exactly one organization and it must equal
      // the route's organization. The union guarantees a non-empty organizationPublicId + scopes,
      // so a key scoped to another organization (or lacking the permission) is rejected here.
      if (auth.organizationPublicId !== organizationId) {
        await emitPermissionDenyAudit(
          request,
          buildDenyMetadata(request, {
            deny_reason: 'api_key_organization_mismatch',
            permission_code: permissionCode,
            requested_organization_id: organizationId,
          }),
        );
        throw new ForbiddenError('errors:insufficientOrganizationPermissions');
      }
      if (!auth.apiKeyScopes.includes(permissionCode)) {
        await emitPermissionDenyAudit(
          request,
          buildDenyMetadata(request, {
            deny_reason: 'api_key_scope_missing',
            permission_code: permissionCode,
            organization_id: organizationId,
          }),
        );
        throw new ForbiddenError('errors:insufficientOrganizationPermissions');
      }
      return;
    }

    const permissionCodes = await resolveOrganizationPermissionsForRequest(
      request,
      auth.userId,
      organizationId,
    );
    if (!permissionCodes.includes(permissionCode)) {
      await emitPermissionDenyAudit(
        request,
        buildDenyMetadata(request, {
          deny_reason: 'organization_permission_missing',
          permission_code: permissionCode,
          organization_id: organizationId,
        }),
      );
      throw new ForbiddenError('errors:insufficientOrganizationPermissions');
    }
  };
}
