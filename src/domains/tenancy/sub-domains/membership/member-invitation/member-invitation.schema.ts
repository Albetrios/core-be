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
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';

/**
 * `tenancy.member_invitations` table — outstanding invites for a membership.
 * `token_hash` stores the SHA-256 of the raw token (only the original is
 * emailed); `accepted_at` / `revoked_at` are mutually exclusive terminal
 * states enforced by `chk_member_inv_accepted`. RLS scopes rows to the
 * invitation's owning membership/organization.
 */
export const member_invitations = tenancySchema
  .table(
    'member_invitations',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      membership_id: bigint('membership_id', { mode: 'number' })
        .notNull()
        .references(() => memberships.id, { onDelete: 'cascade' }),
      email: varchar('email', { length: 255 }).notNull(),
      token_hash: varchar('token_hash', { length: 64 }).notNull(),
      invited_by_user_id: bigint('invited_by_user_id', { mode: 'number' })
        .notNull()
        .references(() => users.id),
      expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
      accepted_at: timestamp('accepted_at', { withTimezone: true }),
      revoked_at: timestamp('revoked_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      created_by_user_id: bigint('created_by_user_id', { mode: 'number' }).references(
        () => users.id,
      ),
    },
    (table) => [
      // Attribution FK indexes (partial on IS NOT NULL) from migration 20260623000000 — declared so
      // the schema lists every index the database has (pinned by index-hygiene.integration.test.ts).
      index('idx_member_invitations_created_by_user_id')
        .on(table.created_by_user_id)
        .where(sql`${table.created_by_user_id} IS NOT NULL`),
      // invited_by_user_id is NOT NULL, so its FK index is full, not partial.
      index('idx_member_invitations_invited_by_user_id').on(table.invited_by_user_id),
      uniqueIndex('idx_member_invitations_public_id').on(table.public_id),
      uniqueIndex('idx_member_invitations_token').on(table.token_hash),
      index('idx_member_invitations_membership_created_id').on(
        table.membership_id,
        table.created_at,
        table.id,
      ),
      index('idx_member_invitations_created_id').on(table.created_at, table.id),
      index('idx_member_invitations_email').on(table.email, table.accepted_at),
      // audit #18: covers the cross-organization pending-invitation keyset query
      // (`tenancy.list_pending_member_invitations_for_email`), which filters
      // email + accepted_at IS NULL + revoked_at IS NULL and keyset-orders by
      // (created_at, id). The plain (email, accepted_at) index above left the
      // sort columns uncovered → per-page in-memory sort for heavily-invited emails.
      index('idx_member_invitations_email_pending')
        .on(table.email, table.created_at, table.id)
        .where(sql`${table.accepted_at} IS NULL AND ${table.revoked_at} IS NULL`),
      index('idx_member_invitations_expires').on(table.expires_at),
      check('chk_member_inv_expires', sql`${table.expires_at} > ${table.created_at}`),
      check(
        'chk_member_inv_accepted',
        sql`${table.accepted_at} IS NULL OR ${table.revoked_at} IS NULL`,
      ),
      pgPolicy('member_invitations_tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${table.membership_id} IN (
            SELECT id FROM tenancy.memberships
            WHERE organization_id = (
              SELECT id FROM tenancy.organizations
              WHERE public_id = current_setting('app.current_organization_public_id', true)
            )
          )
          OR current_setting('app.global_retention_cleanup', true) = 'true'`,
        withCheck: sql`${table.membership_id} IN (
            SELECT id FROM tenancy.memberships
            WHERE organization_id = (
              SELECT id FROM tenancy.organizations
              WHERE public_id = current_setting('app.current_organization_public_id', true)
            )
          )`,
      }),
    ],
  )
  .enableRLS();
