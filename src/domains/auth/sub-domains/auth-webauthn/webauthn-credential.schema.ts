import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  jsonb,
  text,
  timestamp,
  varchar,
  index,
  uniqueIndex,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { authSchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';

/** Drizzle table for `auth.webauthn_credentials` — registered passkeys (credential id, public key, signature counter, transports); revocation is soft via `revoked_at` and the unique index is partial on `revoked_at IS NULL`. RLS-gated by `app.current_user_public_id` (set via `withAppDatabaseContext (user scope)`) so passkeys are isolated per user. */
export const webauthn_credentials = authSchema
  .table(
    'webauthn_credentials',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      // audit R5b / M3: opaque external identifier (`wac_<21>`) returned by the passkey-management
      // API and accepted by DELETE …/credentials/{credential_id}; never the bigserial `id` or the
      // raw WebAuthn credential_id blob. App-generated via generatePublicId('webauthnCredential').
      public_id: varchar('public_id', { length: 28 }).notNull(),
      user_id: bigint('user_id', { mode: 'number' })
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      credential_id: text('credential_id').notNull(),
      public_key: text('public_key').notNull(),
      counter: bigint('counter', { mode: 'number' }).notNull().default(0),
      device_type: varchar('device_type', { length: 32 }).notNull().default('singleDevice'),
      backed_up: boolean('backed_up').notNull().default(false),
      transports: jsonb('transports').notNull().default([]),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      last_used_at: timestamp('last_used_at', { withTimezone: true }),
      revoked_at: timestamp('revoked_at', { withTimezone: true }),
    },
    (table) => [
      uniqueIndex('webauthn_credentials_credential_id_unique')
        .on(table.credential_id)
        .where(sql`${table.revoked_at} IS NULL`),
      uniqueIndex('webauthn_credentials_public_id_unique').on(table.public_id),
      // Full, not partial on `revoked_at IS NULL`: the user-delete cascade reaches revoked passkeys
      // too, and a partial index cannot serve it. Replaced webauthn_credentials_user_id_idx in
      // migration 20260923152433.
      index('idx_webauthn_credentials_user_id').on(table.user_id),
      pgPolicy('webauthn_credentials_owner_access', {
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
