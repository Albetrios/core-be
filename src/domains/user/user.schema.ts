import { sql } from 'drizzle-orm';
import {
  bigserial,
  bigint,
  varchar,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { authSchema } from '@/infrastructure/database/pg-schemas.js';

/**
 * `auth.users` — canonical platform identity table. Soft-deleted via `deleted_at` so audit and
 * billing FKs stay intact; the unique-by-email partial index excludes deleted rows so an address
 * can be reused after offboarding. Trigram indexes power admin search by email and display name;
 * lockout fields drive failed-login throttling. FORCE RLS-gated (audit #7) by `app.current_user_id`
 * (owner self-access via `withUserDatabaseContext`) or `app.global_admin` (cross-user admin via
 * `withMaintenanceDatabaseContext`); pre-session reads go through the `auth.resolve_user_*`
 * SECURITY DEFINER resolvers.
 */
export const users = authSchema
  .table(
    'users',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      email: varchar('email', { length: 255 }).notNull(),
      email_hash: varchar('email_hash', { length: 64 }).notNull(),
      is_email_verified: boolean('is_email_verified').notNull().default(false),
      first_name: varchar('first_name', { length: 100 }),
      last_name: varchar('last_name', { length: 100 }),
      job_title: varchar('job_title', { length: 150 }),
      avatar_url: varchar('avatar_url', { length: 512 }),
      password_hash: varchar('password_hash', { length: 255 }),
      failed_login_count: integer('failed_login_count').notNull().default(0),
      account_locked_until: timestamp('account_locked_until', { withTimezone: true }),
      last_password_change_at: timestamp('last_password_change_at', { withTimezone: true }),
      is_mfa_enabled: boolean('is_mfa_enabled').notNull().default(false),
      // Stamped when the user finishes the onboarding wizard. NULL = not yet
      // onboarded → the frontend routes every fresh user (personal or team) through
      // onboarding once, regardless of whether a personal org is auto-provisioned.
      onboarding_completed_at: timestamp('onboarding_completed_at', { withTimezone: true }),
      status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
      last_active_at: timestamp('last_active_at', { withTimezone: true }),
      // Soft pointer to the organization the user last acted in; restored as the default
      // active organization at login. No hard FK (avoids a circular cross-schema FK); the
      // login selection re-validates membership, so a stale/dangling value falls back safely.
      last_active_organization_id: bigint('last_active_organization_id', { mode: 'number' }),
      deleted_at: timestamp('deleted_at', { withTimezone: true }),
      deletion_started_at: timestamp('deletion_started_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      uniqueIndex('idx_users_public_id').on(table.public_id),
      index('idx_users_email').on(table.email),
      index('idx_users_email_hash').on(table.email_hash),
      index('idx_users_status_deleted').on(table.status, table.deleted_at),
      index('idx_users_last_active').on(table.last_active_at),
      index('idx_users_verified_status').on(table.is_email_verified, table.status),
      uniqueIndex('idx_users_email_unique').on(table.email).where(sql`${table.deleted_at} IS NULL`),
      index('idx_users_created_id_active')
        .on(table.created_at, table.id)
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_users_last_active_not_deleted')
        .on(table.last_active_at)
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_users_locked')
        .on(table.account_locked_until)
        .where(sql`${table.account_locked_until} IS NOT NULL`),
      index('idx_users_email_trgm').using('gin', table.email.op('gin_trgm_ops')),
      index('idx_users_display_name_trgm').using(
        'gin',
        sql`(coalesce(${table.first_name}, '') || ' ' || coalesce(${table.last_name}, '')) gin_trgm_ops`,
      ),
      check('chk_users_status', sql`${table.status} IN ('ACTIVE', 'LOCKED', 'SUSPENDED')`),
      check('chk_users_failed_login', sql`${table.failed_login_count} >= 0`),
      check('chk_users_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('users_self_or_admin_access', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`(
          (
            ${table.public_id} = current_setting('app.current_user_id', true)
            AND ${table.deleted_at} IS NULL
          )
          OR current_setting('app.global_admin', true) = 'true'
          OR current_setting('app.global_retention_cleanup', true) = 'true'
        )`,
        withCheck: sql`(
          ${table.public_id} = current_setting('app.current_user_id', true)
          OR current_setting('app.global_admin', true) = 'true'
        )`,
      }),
    ],
  )
  .enableRLS();
