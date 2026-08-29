import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  varchar,
  timestamp,
  index,
  uniqueIndex,
  check,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { tenancySchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';

/**
 * `tenancy.memberships` table — links a user to an organization with a role
 * and a lifecycle `status` (INVITED, ACTIVE, SUSPENDED, enforced by
 * `chk_memberships_status`). A partial unique index keeps `(user_id,
 * organization_id)` unique only for active rows so a user can rejoin after
 * being soft-deleted. RLS scopes rows to the caller's organization.
 */
export const memberships = tenancySchema
  .table(
    'memberships',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      user_id: bigint('user_id', { mode: 'number' })
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      role_id: bigint('role_id', { mode: 'number' })
        .notNull()
        .references(() => roles.id, { onDelete: 'restrict' }),
      status: varchar('status', { length: 20 }).notNull().default('INVITED'),
      invited_by_user_id: bigint('invited_by_user_id', { mode: 'number' }).references(
        () => users.id,
      ),
      joined_at: timestamp('joined_at', { withTimezone: true }),
      deleted_at: timestamp('deleted_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
      created_by_user_id: bigint('created_by_user_id', { mode: 'number' }).references(
        () => users.id,
      ),
      updated_by_user_id: bigint('updated_by_user_id', { mode: 'number' }).references(
        () => users.id,
      ),
    },
    (table) => [
      uniqueIndex('idx_memberships_public_id').on(table.public_id),
      index('idx_memberships_user_org').on(table.user_id, table.organization_id),
      index('idx_memberships_org_status').on(table.organization_id, table.status),
      index('idx_memberships_org_created_id_active')
        .on(table.organization_id, table.created_at, table.id)
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_memberships_user_status').on(table.user_id, table.status),
      index('idx_memberships_role').on(table.role_id),
      uniqueIndex('idx_memberships_user_org_unique')
        .on(table.user_id, table.organization_id)
        .where(sql`${table.deleted_at} IS NULL`),
      check('chk_memberships_status', sql`${table.status} IN ('INVITED', 'ACTIVE', 'SUSPENDED')`),
      check(
        'chk_memberships_joined',
        sql`${table.status} != 'ACTIVE' OR ${table.joined_at} IS NOT NULL`,
      ),
      check('chk_memberships_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('memberships_tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )
          OR current_setting('app.global_retention_cleanup', true) = 'true'`,
        withCheck: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )`,
      }),
    ],
  )
  .enableRLS();
