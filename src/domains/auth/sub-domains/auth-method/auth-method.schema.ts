import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  varchar,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  check,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { authSchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { AUTH_METHOD_TYPES } from './auth-method.constants.js';

/**
 * Drizzle table for `auth.auth_methods` — one row per linked credential (PASSWORD, EMAIL_CODE,
 * OAUTH, MFA_TOTP, MFA_SMS, MFA_EMAIL); soft-deleted via `revoked_at`. FORCE RLS-gated (audit #7):
 * ownership is derived through `auth.users` (`user_id` of the row whose `public_id` matches
 * `app.current_user_public_id`) or the `app.global_admin` admin escape hatch; the pre-session OAuth lookup
 * goes through the `auth.resolve_auth_method_by_provider` SECURITY DEFINER resolver.
 */
export const auth_methods = authSchema
  .table(
    'auth_methods',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      // sec-new-B4: opaque public identifier returned by the auth-method management API
      // (GET /me/auth-methods, POST /me/auth-methods) and accepted as the path parameter
      // on DELETE /me/auth-methods/:publicId so the bigserial is never exposed to callers.
      public_id: varchar('public_id', { length: 28 }).notNull(),
      user_id: bigint('user_id', { mode: 'number' })
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      method_type: varchar('method_type', { length: 20 }).notNull(),
      provider: varchar('provider', { length: 50 }),
      provider_user_id: varchar('provider_user_id', { length: 255 }),
      encrypted_secret: text('encrypted_secret'),
      phone_number: varchar('phone_number', { length: 20 }),
      is_primary: boolean('is_primary').notNull().default(false),
      verified_at: timestamp('verified_at', { withTimezone: true }),
      last_used_at: timestamp('last_used_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      revoked_at: timestamp('revoked_at', { withTimezone: true }),
      created_by_user_id: bigint('created_by_user_id', { mode: 'number' }).references(
        () => users.id,
      ),
    },
    (table) => [
      uniqueIndex('idx_auth_methods_public_id').on(table.public_id),
      index('idx_auth_methods_user_type').on(table.user_id, table.method_type),
      index('idx_auth_methods_provider').on(table.provider, table.provider_user_id),
      index('idx_auth_methods_user_revoked').on(table.user_id, table.revoked_at),
      index('idx_auth_methods_user_primary').on(table.user_id, table.is_primary),
      check(
        'chk_auth_methods_type',
        sql`${table.method_type} IN (${sql.join(
          AUTH_METHOD_TYPES.map((methodType) => sql`${methodType}`),
          sql`, `,
        )})`,
      ),
      pgPolicy('auth_methods_self_or_admin_access', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`(
          ${table.user_id} = (
            SELECT id FROM auth.users
            WHERE public_id = current_setting('app.current_user_public_id', true)
              AND deleted_at IS NULL
          )
          OR current_setting('app.global_admin', true) = 'true'
        )`,
        withCheck: sql`(
          ${table.user_id} = (
            SELECT id FROM auth.users
            WHERE public_id = current_setting('app.current_user_public_id', true)
              AND deleted_at IS NULL
          )
          OR current_setting('app.global_admin', true) = 'true'
        )`,
      }),
    ],
  )
  .enableRLS();

// Note: magic_link_tokens table has been replaced by the unified verification_tokens table.
// See verification-token.schema.ts for the new schema.
