import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  timestamp,
  varchar,
  index,
  uniqueIndex,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { authSchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';

/** Drizzle table for `auth.mfa_recovery_codes` — one-time recovery codes hashed at rest; partial index `idx_mfa_recovery_codes_user_unused` keeps lookups cheap for the unused set. RLS-gated by `app.current_user_public_id` (set via `withPrincipalDatabaseContext (user scope)`) so recovery codes are isolated per user. */
export const mfa_recovery_codes = authSchema
  .table(
    'mfa_recovery_codes',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      user_id: bigint('user_id', { mode: 'number' })
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      code_hash: varchar('code_hash', { length: 64 }).notNull(),
      used_at: timestamp('used_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      uniqueIndex('idx_mfa_recovery_codes_user_code_hash').on(table.user_id, table.code_hash),
      index('idx_mfa_recovery_codes_user_unused')
        .on(table.user_id)
        .where(sql`${table.used_at} IS NULL`),
      pgPolicy('mfa_recovery_codes_owner_access', {
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
