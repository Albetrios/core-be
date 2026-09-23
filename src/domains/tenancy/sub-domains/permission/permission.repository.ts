import { permissions } from '@/domains/tenancy/sub-domains/permission/permission.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { role_permissions } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { DEFAULT_REPOSITORY_LIST_LIMIT } from '@/shared/constants/query-limits.constants.js';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { eq, and, isNull, sql as drizzleSql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

/**
 * Drizzle data access for the global `tenancy.permissions` catalog and for
 * resolving a user's effective permission codes inside an organization via a
 * four-table join (`role_permissions → roles → memberships → organizations`).
 * The catalog table has no RLS policy so {@link findAll} is intentionally
 * global; the per-user lookup accepts an optional `databaseHandle` so callers
 * running outside the request context (the permission cache recompute path) can
 * pass their own handle.
 *
 * @remarks
 * The membership owner is resolved from `public_id` to internal id via the
 * `auth.resolve_user_id_by_public_id` SECURITY DEFINER function rather than a
 * direct `auth.users` join: permission resolution runs under ORG-only context
 * (`app.current_organization_public_id` is set, but `app.current_user_public_id` is not), and
 * `auth.users` is FORCE-RLS protected by an owner policy keyed on
 * `app.current_user_public_id`. A direct join would therefore return zero rows under
 * the non-superuser `core_be_app` role and silently strip every permission
 * (403 on all organization PERM-gated routes). The resolver also filters
 * `deleted_at IS NULL`, so a soft-deleted user resolves to `null` → empty set.
 */
export class PermissionRepository {
  async findAll(limit = DEFAULT_REPOSITORY_LIST_LIMIT) {
    const rows = await getRequestDatabase()
      .select()
      .from(permissions)
      .orderBy(permissions.category, permissions.code)
      .limit(limit);
    if (rows.length >= limit) {
      logger.warn(
        { limit, returned: rows.length },
        'PermissionRepository.findAll hit safe row cap; catalog may be truncated',
      );
    }
    return rows;
  }

  async findPermissionCodesForUserInOrganization(
    userPublicId: string,
    organizationPublicId: string,
    databaseHandle?: PostgresJsDatabase,
  ): Promise<string[]> {
    const database = databaseHandle ?? getRequestDatabase();

    // Resolve public_id → internal id via a SECURITY DEFINER function instead of joining
    // auth.users, which is invisible under ORG-only context with FORCE RLS. The function
    // excludes soft-deleted users, so a deleted user yields no internal id → empty set.
    //
    // Resolved INSIDE the join rather than by a preceding round trip: the function is
    // STABLE, so Postgres evaluates it once per statement, and an unknown or soft-deleted
    // user resolves to NULL, which makes the comparison fail and the set come back empty —
    // the same answer the separate lookup produced with an early return. Same technique and
    // same reason as `OrganizationRepository.findAllForUser`. It matters here because this
    // runs on every permission-cache miss, and a role or permission write invalidates the
    // WHOLE organization at once, so the misses arrive together.
    const internalUserId = drizzleSql<number>`auth.resolve_user_id_by_public_id(${userPublicId})`;

    const rows = await database
      .select({ permission_code: role_permissions.permission_code })
      .from(role_permissions)
      .innerJoin(roles, eq(role_permissions.role_id, roles.id))
      .innerJoin(memberships, eq(memberships.role_id, roles.id))
      .innerJoin(organizations, eq(memberships.organization_id, organizations.id))
      .where(
        and(
          eq(memberships.user_id, internalUserId),
          eq(organizations.public_id, organizationPublicId),
          eq(memberships.status, 'ACTIVE'),
          isNull(memberships.deleted_at),
          isNull(roles.deleted_at),
          isNull(organizations.deleted_at),
        ),
      );

    return rows.map((row) => row.permission_code);
  }
}
