import { eq } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { role_permissions } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.schema.js';

/**
 * Hard cap on the number of permission rows returned for a single role.
 *
 * sec-r4-D4: the in-app permission registries (tenancy / audit / notify /
 * billing / upload) total well under 100 distinct codes; 256 is comfortably
 * clear of any realistic future ceiling and prevents a corrupted
 * `tenancy.role_permissions` table (e.g. a bug in a future migration, or a
 * privileged-INSERT bypass) from paging unbounded rows into the API process
 * on every per-role permission read.
 */
const MEMBER_ROLE_PERMISSION_MAX_ROWS_PER_ROLE = 256;

/**
 * Drizzle data access for `tenancy.role_permissions`, the join table that
 * couples organization roles to permission codes. {@link replace} implements
 * set semantics: it deletes every existing row for the role before inserting
 * the new set, so callers should pass the full desired permission list.
 *
 * @remarks
 * **Tenant-isolation precondition (audit L4):** `role_permissions` has no
 * `organization_id` column — these queries scope by `role_id` and rely on the
 * caller having resolved the role *within the active organization* (the service
 * loads the role organization-scoped before mutating its permissions). The
 * `role_permissions_tenant_isolation` RLS policy backstops both halves: `USING`
 * confines reads/deletes to `role_id IN (SELECT id FROM tenancy.roles WHERE
 * organization_id = current-organization)`, and — since audit H1 added the explicit
 * `WITH CHECK` — inserts are confined to the same organization-owned role set, so a write
 * can never land a permission row on a foreign org's role even under a retention
 * context. No redundant organization predicate is added here to avoid threading
 * `organization_id` through a join the RLS policy already enforces.
 */
export class MemberRolePermissionRepository {
  async findByRoleId(role_id: number) {
    return getRequestDatabase()
      .select()
      .from(role_permissions)
      .where(eq(role_permissions.role_id, role_id))
      .limit(MEMBER_ROLE_PERMISSION_MAX_ROWS_PER_ROLE);
  }

  async replace(role_id: number, permission_codes: string[], created_by_user_id: number | null) {
    await getRequestDatabase()
      .delete(role_permissions)
      .where(eq(role_permissions.role_id, role_id));
    if (permission_codes.length === 0) return [];
    const rows = await getRequestDatabase()
      .insert(role_permissions)
      .values(
        permission_codes.map((permission_code) => ({
          role_id,
          permission_code,
          created_by_user_id: created_by_user_id ?? undefined,
        })),
      )
      .returning();
    return rows;
  }
}
