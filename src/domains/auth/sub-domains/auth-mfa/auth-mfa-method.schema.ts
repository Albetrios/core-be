import { sql } from 'drizzle-orm';
import {
  bigserial,
  bigint,
  varchar,
  text,
  boolean,
  timestamp,
  index,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { authSchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';

/**
 * Dedicated MFA methods table — conceptually separate from login auth_methods.
 * Stores TOTP secrets, backup codes, and other MFA factor data. RLS-gated by
 * `app.current_user_public_id` (set via `withAppDatabaseContext (user scope)`) so MFA secrets are isolated per user.
 */
export const mfa_methods = authSchema
  .table(
    'mfa_methods',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull().unique(),
      user_id: bigint('user_id', { mode: 'number' })
        .notNull()
        // reaudit-#1: FK + cascade so a user delete purges its MFA secrets (no GDPR orphan).
        .references(() => users.id, { onDelete: 'cascade' }),
      method_type: varchar('method_type', { length: 20 }).notNull(), // TOTP, SMS, EMAIL, BACKUP_CODES
      encrypted_secret: text('encrypted_secret'),
      phone_number: varchar('phone_number', { length: 20 }),
      is_verified: boolean('is_verified').notNull().default(false),
      is_primary: boolean('is_primary').notNull().default(false),
      last_used_at: timestamp('last_used_at', { withTimezone: true }),
      verified_at: timestamp('verified_at', { withTimezone: true }),
      revoked_at: timestamp('revoked_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
      created_by_user_id: bigint('created_by_user_id', { mode: 'number' }).references(
        () => users.id,
        { onDelete: 'set null' },
      ),
    },
    (table) => [
      // Attribution FK indexes (partial on IS NOT NULL) from migration 20260623000000 — declared so
      // the schema lists every index the database has (pinned by index-hygiene.integration.test.ts).
      index('idx_mfa_methods_created_by_user_id')
        .on(table.created_by_user_id)
        .where(sql`${table.created_by_user_id} IS NOT NULL`),
      // reaudit-#1: index the per-user RLS owner predicate + every per-user MFA read.
      index('idx_mfa_methods_user_id').on(table.user_id),
      pgPolicy('mfa_methods_owner_access', {
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
