import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  varchar,
  boolean,
  timestamp,
  inet,
  index,
  check,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { authSchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';

/** Drizzle table for `auth.sessions` — one row per browser/device session backing JWT refresh; carries a unique `token_hash` and is RLS-gated by user public id, session public id, token hash, or the retention-cleanup escape hatch. */
export const sessions = authSchema
  .table(
    'sessions',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull().unique(),
      user_id: bigint('user_id', { mode: 'number' })
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      organization_id: bigint('organization_id', { mode: 'number' }).references(
        () => organizations.id,
        { onDelete: 'set null' },
      ),
      token_hash: varchar('token_hash', { length: 64 }).notNull().unique(),
      refresh_token_hash: varchar('refresh_token_hash', { length: 64 }),
      // audit-#2: the immediately-previous refresh hash + when it was rotated. The refresh CAS
      // accepts this hash for a short grace window so two concurrent legitimate refreshes (double
      // click / two tabs / proxy retry) presenting the SAME secret both succeed instead of the
      // loser being misclassified as token-reuse and revoking the whole session family.
      previous_refresh_token_hash: varchar('previous_refresh_token_hash', { length: 64 }),
      refresh_token_rotated_at: timestamp('refresh_token_rotated_at', { withTimezone: true }),
      ip_address: inet('ip_address').notNull(),
      user_agent: varchar('user_agent', { length: 512 }),
      last_active_at: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
      expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
      is_revoked: boolean('is_revoked').notNull().default(false),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      index('idx_sessions_user_status').on(table.user_id, table.is_revoked, table.expires_at),
      index('idx_sessions_expires').on(table.expires_at),
      // sec-D #33: covers the session-cleanup worker's revoked-branch
      // (`AND(is_revoked, created_at < cutoff)`). Partial — scoped to the
      // revoked subset only, the live population is unaffected. Added by
      // migration 20260607050000.
      index('idx_sessions_revoked_created_at')
        .on(table.created_at)
        .where(sql`${table.is_revoked} = true`),
      // Rotating refresh credential: indexed so refresh rotation and the refresh-token
      // RLS predicate resolve by index instead of scanning the table. Partial — sessions
      // that never refreshed (NULL) are excluded to keep the index small.
      index('idx_sessions_refresh_token_hash')
        .on(table.refresh_token_hash)
        .where(sql`${table.refresh_token_hash} IS NOT NULL`),
      // Backs the organization_id FK: purging an organization runs `SET NULL ... WHERE
      // organization_id = $1` here, a full scan per purged organization without it. Added by
      // migration 20260923152433.
      index('idx_sessions_organization_id')
        .on(table.organization_id)
        .where(sql`${table.organization_id} IS NOT NULL`),
      check('chk_sessions_expires', sql`${table.expires_at} > ${table.created_at}`),
      check('chk_sessions_last_active', sql`${table.last_active_at} >= ${table.created_at}`),
      pgPolicy('sessions_user_access', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`(
          ${table.user_id} = (
            SELECT id FROM auth.users
            WHERE public_id = current_setting('app.current_user_public_id', true)
              AND deleted_at IS NULL
          )
          OR ${table.public_id} = current_setting('app.current_session_public_id', true)
          OR ${table.token_hash} = current_setting('app.current_session_token_hash', true)
          OR current_setting('app.session_retention_cleanup', true) = 'true'
        )`,
        withCheck: sql`(
          ${table.user_id} = (
            SELECT id FROM auth.users
            WHERE public_id = current_setting('app.current_user_public_id', true)
              AND deleted_at IS NULL
          )
          OR ${table.public_id} = current_setting('app.current_session_public_id', true)
          OR ${table.token_hash} = current_setting('app.current_session_token_hash', true)
          OR current_setting('app.session_retention_cleanup', true) = 'true'
        )`,
      }),
    ],
  )
  .enableRLS();
