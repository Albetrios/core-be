import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { notifySchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';

/**
 * Drizzle table for `notify.notifications` — the per-user in-app inbox. Soft-scoped by RLS to
 * the current organization or the row owner; a `read_at` check constraint enforces that any
 * row marked `is_read = true` carries a timestamp.
 */
export const notifications = notifySchema
  .table(
    'notifications',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      user_id: bigint('user_id', { mode: 'number' })
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      organization_id: bigint('organization_id', { mode: 'number' }).references(
        () => organizations.id,
        { onDelete: 'set null' },
      ),
      type: varchar('type', { length: 50 }).notNull(),
      title: varchar('title', { length: 255 }).notNull(),
      message: text('message').notNull(),
      data: jsonb('data').notNull().default({}),
      action_url: varchar('action_url', { length: 512 }),
      action_label: varchar('action_label', { length: 50 }),
      is_read: boolean('is_read').notNull().default(false),
      read_at: timestamp('read_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      uniqueIndex('idx_notifications_public_id').on(table.public_id),
      index('idx_notifications_user_read').on(table.user_id, table.is_read, table.created_at),
      index('idx_notifications_user_created_id').on(table.user_id, table.created_at, table.id),
      index('idx_notifications_org').on(table.organization_id, table.created_at),
      index('idx_notifications_type').on(table.type, table.created_at),
      index('idx_notifications_created').on(table.created_at),
      check('chk_notifications_read', sql`NOT ${table.is_read} OR ${table.read_at} IS NOT NULL`),
      pgPolicy('notifications_tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`(
            ${table.organization_id} IS NOT NULL
            AND ${table.organization_id} = (
              SELECT id FROM tenancy.organizations
              WHERE public_id = current_setting('app.current_organization_public_id', true)
            )
          )
          OR current_setting('app.global_retention_cleanup', true) = 'true'`,
        withCheck: sql`(
            ${table.organization_id} IS NOT NULL
            AND ${table.organization_id} = (
              SELECT id FROM tenancy.organizations
              WHERE public_id = current_setting('app.current_organization_public_id', true)
            )
          )`,
      }),
      // Owner access so a user can read/manage their own notifications (the service queries by
      // user_id). Permissive → OR'd with tenant isolation; inert until app.current_user_public_id is set.
      pgPolicy('notifications_owner_access', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${table.user_id} = (
            SELECT id FROM auth.users
            WHERE public_id = current_setting('app.current_user_public_id', true)
              AND deleted_at IS NULL
          )`,
      }),
    ],
  )
  .enableRLS();
