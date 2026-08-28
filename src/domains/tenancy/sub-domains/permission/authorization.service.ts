import { withAppDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';
import { resolveVerifiedPrincipalScope } from '@/shared/utils/identity/verified-principal-scope.util.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ConfigurationError } from '@/shared/errors/index.js';
import {
  getCachedPermissions,
  withPermissionCacheRecomputeLock,
} from './permission-cache.service.js';
import type { PermissionRepository } from './permission.repository.js';

let permissionRepository: PermissionRepository | null = null;

/**
 * Wire repository from tenancy container (composition root).
 *
 * @remarks
 * - **Algorithm:** stores the provided {@link PermissionRepository} in a
 *   module-level singleton so the function-style
 *   {@link resolveUserOrganizationPermissions} export can resolve it without a
 *   class instance.
 * - **Failure modes:** none on its own; downstream callers that hit
 *   {@link resolveUserOrganizationPermissions} before this has been invoked
 *   throw `ConfigurationError`.
 * - **Side effects:** mutates a module-level variable; safe to call multiple
 *   times (last write wins). Called by `tenancy.container.ts` during boot and
 *   by every `new AuthorizationService(...)` for test isolation.
 * - **Notes:** prefer the class-based {@link AuthorizationService} in new code;
 *   the function-style API exists for legacy preHandlers that ran before DI
 *   was introduced.
 */
export function configureAuthorization(permissionRepositoryInstance: PermissionRepository): void {
  permissionRepository = permissionRepositoryInstance;
}

function getPermissionRepository(): PermissionRepository {
  if (!permissionRepository) {
    throw new ConfigurationError(
      'Authorization is not configured. Call configureAuthorization from tenancy.container.',
    );
  }
  return permissionRepository;
}

/**
 * Authoritative DB read of a user's permission codes within an organization, bypassing the
 * Redis cache entirely (no read, no write).
 *
 * @remarks
 * - **Algorithm:** runs the 5-table join under {@link withAppDatabaseContext} so RLS is
 *   satisfied; never consults or writes the `perm:*` cache.
 * - **Failure modes:** database errors bubble up.
 * - **Side effects:** transient Postgres GUC mutation via `withAppDatabaseContext` only.
 * - **Notes:** used by privilege-escalation guards (sec-r5-L3) where a stale, up-to-5-minute
 *   cached set could let a just-revoked code still be granted. Most callers should prefer the
 *   cached {@link resolvePermissionsWithRepository} path.
 */
async function resolvePermissionsFromDatabase(
  repository: PermissionRepository,
  userPublicId: string,
  organizationPublicId: string,
): Promise<string[]> {
  return withAppDatabaseContext(
    resolveVerifiedPrincipalScope({ organizationPublicId: organizationPublicId }),
    async (databaseHandle) =>
      repository.findPermissionCodesForUserInOrganization(
        userPublicId,
        organizationPublicId,
        databaseHandle as PostgresJsDatabase,
      ),
  );
}

async function resolvePermissionsWithRepository(
  repository: PermissionRepository,
  userPublicId: string,
  organizationPublicId: string,
): Promise<string[]> {
  const cached = await getCachedPermissions(userPublicId, organizationPublicId);
  if (cached !== null) {
    return cached;
  }

  // The recompute callback only computes; withPermissionCacheRecomputeLock owns the cache write
  // and guards it two ways so a racing invalidation cannot be clobbered by a stale write: the
  // lock nonce (per-user invalidatePermissions deletes the lock) and the org cache version
  // captured before the DB read (org-wide invalidateOrganizationPermissions bumps the version,
  // orphaning this commit). See audit-#H1.
  return withPermissionCacheRecomputeLock(userPublicId, organizationPublicId, async () =>
    resolvePermissionsFromDatabase(repository, userPublicId, organizationPublicId),
  );
}

/**
 * Resolves the permission codes a user has within a specific organization.
 * Uses Redis cache with 5-minute TTL to avoid repeated 5-table joins.
 *
 * @remarks
 * - **Algorithm:** hits {@link getCachedPermissions} first; on miss takes the
 *   per-(user, organization) Redis recompute lock via
 *   {@link withPermissionCacheRecomputeLock}, then runs the 5-table join
 *   (`role_permissions → roles → memberships → users + organizations`) under
 *   {@link withAppDatabaseContext} so RLS is satisfied; the lock wrapper then
 *   writes the result to the cache (TTL plus jitter) guarded on the lock nonce.
 * - **Failure modes:** `ConfigurationError` if {@link configureAuthorization}
 *   has not been invoked; Redis errors degrade to a direct database lookup
 *   (logged); database errors bubble up.
 * - **Side effects:** reads and writes Redis under the `perm:*` keyspace;
 *   takes a brief recompute lock; transient Postgres GUC mutation through
 *   `withAppDatabaseContext`.
 * - **Notes:** module-level wrapper around the class-based
 *   {@link AuthorizationService} so legacy preHandlers without DI can still
 *   call it. Cache entries are invalidated via
 *   {@link invalidatePermissions} on role/permission changes.
 */
export async function resolveUserOrganizationPermissions(
  userPublicId: string,
  organizationPublicId: string,
): Promise<string[]> {
  return resolvePermissionsWithRepository(
    getPermissionRepository(),
    userPublicId,
    organizationPublicId,
  );
}

/**
 * Resolves a user's permission codes within an organization straight from the database,
 * bypassing the Redis cache.
 *
 * @remarks
 * - **Algorithm:** delegates to {@link resolvePermissionsFromDatabase} with the module-level
 *   repository singleton — no cache read or write.
 * - **Failure modes:** `ConfigurationError` if {@link configureAuthorization} has not run;
 *   database errors bubble up.
 * - **Side effects:** transient Postgres GUC mutation only.
 * - **Notes:** sec-r5-L3 — for privilege-escalation checks that must not trust a stale
 *   (up-to-5-minute) cached permission set. Prefer {@link resolveUserOrganizationPermissions}
 *   for hot-path authorization.
 */
export async function resolveUserOrganizationPermissionsFromDatabase(
  userPublicId: string,
  organizationPublicId: string,
): Promise<string[]> {
  return resolvePermissionsFromDatabase(
    getPermissionRepository(),
    userPublicId,
    organizationPublicId,
  );
}

/**
 * Class-based entry point used by tenancy DI and by Fastify preHandlers
 * (e.g. `requireOrganizationPermission`) to resolve the permission codes a
 * user has within an organization.
 *
 * @remarks
 * - **Algorithm:** delegates to the shared `resolvePermissionsWithRepository`
 *   helper. Constructor also registers the repository with the module-level
 *   singleton via {@link configureAuthorization} so the function-style
 *   {@link resolveUserOrganizationPermissions} export keeps working.
 * - **Failure modes:** Redis or database failures surface as bare errors so
 *   the caller's preHandler can deny the request; never throws from a stale
 *   cache hit.
 * - **Side effects:** Redis reads/writes under `perm:*`; brief Postgres GUC
 *   mutation; cache writes carry TTL+jitter.
 * - **Notes:** results MUST be invalidated by callers that change roles or
 *   role-permission assignments via {@link invalidatePermissions} or
 *   {@link invalidateOrganizationPermissions}.
 */
export class AuthorizationService {
  constructor(private readonly permissionRepository: PermissionRepository) {
    configureAuthorization(permissionRepository);
  }

  resolveUserOrganizationPermissions(
    userPublicId: string,
    organizationPublicId: string,
  ): Promise<string[]> {
    return resolvePermissionsWithRepository(
      this.permissionRepository,
      userPublicId,
      organizationPublicId,
    );
  }

  /**
   * Cache-bypassing variant of {@link resolveUserOrganizationPermissions} that reads the
   * permission codes straight from the database.
   *
   * @remarks
   * - **Algorithm:** delegates to {@link resolvePermissionsFromDatabase} — no `perm:*` cache
   *   read or write.
   * - **Failure modes:** database errors surface to the caller.
   * - **Side effects:** transient Postgres GUC mutation via `withAppDatabaseContext`.
   * - **Notes:** sec-r5-L3 — used by {@link assertCallerCanGrantPermissionCodes} so a
   *   privilege-escalation check never trusts a stale (up-to-5-minute) cached set.
   */
  resolveUserOrganizationPermissionsFromDatabase(
    userPublicId: string,
    organizationPublicId: string,
  ): Promise<string[]> {
    return resolvePermissionsFromDatabase(
      this.permissionRepository,
      userPublicId,
      organizationPublicId,
    );
  }
}
