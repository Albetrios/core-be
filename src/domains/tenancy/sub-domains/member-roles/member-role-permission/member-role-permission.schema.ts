import { sql } from 'drizzle-orm';
import { bigint, varchar, timestamp, index, primaryKey, pgPolicy } from 'drizzle-orm/pg-core';
import { tenancySchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { permissions } from '@/domains/tenancy/sub-domains/permission/permission.schema.js';

/**
 * `tenancy.role_permissions` join table — assigns permission codes to roles.
 * Composite primary key `(role_id, permission_code)` enforces uniqueness; rows
 * cascade-delete with their role and are restricted from deleting referenced
 * permission codes. RLS isolates rows to the role's owning organization.
 */
export const role_permissions = tenancySchema
  .table(
    'role_permissions',
    {
      role_id: bigint('role_id', { mode: 'number' })
        .notNull()
        .references(() => roles.id, { onDelete: 'cascade' }),
      permission_code: varchar('permission_code', { length: 100 })
        .notNull()
        .references(() => permissions.code, { onDelete: 'restrict' }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      created_by_user_id: bigint('created_by_user_id', { mode: 'number' }).references(
        () => users.id,
      ),
    },
    (table) => [
      primaryKey({
        columns: [table.role_id, table.permission_code],
        name: 'pk_role_permissions',
      }),
      index('idx_role_permissions_code').on(table.permission_code),
      pgPolicy('role_permissions_tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${table.role_id} IN (
            SELECT id FROM tenancy.roles
            WHERE organization_id = (
              SELECT id FROM tenancy.organizations
              WHERE public_id = current_setting('app.current_organization_public_id', true)
            )
          )
          OR current_setting('app.global_retention_cleanup', true) = 'true'`,
        withCheck: sql`${table.role_id} IN (
            SELECT id FROM tenancy.roles
            WHERE organization_id = (
              SELECT id FROM tenancy.organizations
              WHERE public_id = current_setting('app.current_organization_public_id', true)
            )
          )`,
      }),
    ],
  )
  .enableRLS();
