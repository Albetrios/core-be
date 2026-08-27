import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  varchar,
  boolean,
  timestamp,
  uniqueIndex,
  check,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { authSchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';

/**
 * `auth.user_notification_preferences` — per-user opt-in/opt-out per
 * `(notification_type, channel)` tuple, pinned to the user across every
 * organization context. Row-level security ties each row to the current user
 * (active, not soft-deleted), so the user-database context is required when
 * reading or writing. Channel values are constrained to `EMAIL`, `SMS`, `WEB_PUSH`,
 * `IN_APP` by check constraint.
 *
 * @remarks
 * sec-U7: the `organization_id` column is retained for migration rollback
 * safety, but the RLS policy no longer carries an org branch and a
 * `chk_user_notif_prefs_no_org` CHECK constraint pins the column to NULL.
 * Organization-scoped notification preferences live in the
 * `tenancy.organization_notification_policies` table, which is
 * membership-gated. The schema column + FK are kept (rather than dropped) so
 * a rollback can re-permit org-scoped rows without an ALTER TABLE rewrite if
 * the policy change needs to be undone; a follow-up cleanup PR may drop the
 * column once the soak window passes.
 */
export const user_notification_preferences = authSchema
  .table(
    'user_notification_preferences',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      user_id: bigint('user_id', { mode: 'number' })
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      organization_id: bigint('organization_id', { mode: 'number' }).references(
        () => organizations.id,
        { onDelete: 'set null' },
      ),
      notification_type: varchar('notification_type', { length: 50 }).notNull(),
      channel: varchar('channel', { length: 20 }).notNull(),
      is_enabled: boolean('is_enabled').notNull().default(true),
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
      // audit-#11: UNIQUE natural key so duplicate (user_id, type, channel) rows
      // cannot be persisted (a .limit(1) preference read must be deterministic).
      uniqueIndex('idx_user_notif_prefs_user_type_channel_unique').on(
        table.user_id,
        table.notification_type,
        table.channel,
      ),
      check(
        'chk_user_notif_prefs_channel',
        sql`${table.channel} IN ('EMAIL', 'SMS', 'WEB_PUSH', 'IN_APP')`,
      ),
      check('chk_user_notif_prefs_updated', sql`${table.updated_at} >= ${table.created_at}`),
      // sec-U7: defense-in-depth pin — non-null org_id is rejected at the
      // schema level even when application validation is bypassed (raw SQL,
      // future direct repository write).
      check('chk_user_notif_prefs_no_org', sql`${table.organization_id} IS NULL`),
      pgPolicy('user_notification_preferences_user_access', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${table.user_id} = (
            SELECT id FROM auth.users
            WHERE public_id = current_setting('app.current_user_public_id', true)
              AND deleted_at IS NULL
          )`,
        withCheck: sql`${table.user_id} = (
            SELECT id FROM auth.users
            WHERE public_id = current_setting('app.current_user_public_id', true)
              AND deleted_at IS NULL
          )`,
      }),
    ],
  )
  .enableRLS();
