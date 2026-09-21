import { memoizePermissionCatalog } from './permission-catalog-memo.js';
import { serializePermission } from './permission.serializer.js';
import type { PermissionOutput } from './permission.types.js';
import type { PermissionRepository } from './permission.repository.js';

/**
 * Read-only application service backing `GET /permissions` — exposes the
 * global system-wide permission catalog.
 *
 * @remarks
 * - **Algorithm:** delegates to {@link PermissionRepository.findAll}, which
 *   returns the catalog sorted by `(category, code)` and capped by
 *   `DEFAULT_REPOSITORY_LIST_LIMIT`.
 * - **Failure modes:** repository errors propagate; the catalog is small
 *   enough that hitting the safe row cap implies new permissions need to be
 *   added — the repository logs a warning when this happens.
 * - **Side effects:** none (read-only).
 * - **Notes:** keep distinct from {@link AuthorizationService}, which
 *   resolves the codes a specific user has within an organization rather
 *   than enumerating the global catalog.
 */
export class PermissionService {
  constructor(private readonly repository: PermissionRepository) {}

  /**
   * The catalog read behind `GET /tenancy/permissions`, served from a one-minute in-process memo.
   *
   * @remarks
   * - **Algorithm:** {@link memoizePermissionCatalog} answers from memory, or runs the query once
   *   and memoizes the SERIALIZED rows; concurrent misses share one query.
   * - **Failure modes:** a query failure propagates and is not memoized.
   * - **Side effects:** module-level memo state.
   * - **Notes:** the memo lives here rather than in the repository on purpose —
   *   `assert-grantable-permissions.util.ts` calls `PermissionRepository.findAll()` directly as
   *   the privilege-escalation backstop on role-permission writes, and that check must stay live.
   */
  async list(): Promise<PermissionOutput[]> {
    return memoizePermissionCatalog(async () => {
      const rows = await this.repository.findAll();
      return rows.map(serializePermission);
    });
  }
}
