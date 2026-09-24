import { sql } from 'drizzle-orm';
import {
  bigserial,
  bigint,
  jsonb,
  varchar,
  timestamp,
  index,
  uniqueIndex,
  check,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { tenancySchema } from '@/infrastructure/database/pg-schemas.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { users } from '@/domains/user/user.schema.js';

/**
 * Drizzle table for `tenancy.api_keys` — stores SHA-256 `key_hash`,
 * indexable `key_prefix` (first N chars used for lookup), JSONB `scopes`,
 * `ACTIVE`/`REVOKED` status, optional expiry, and soft-delete. Tenant
 * isolation is enforced by the `api_keys_tenant_isolation` RLS policy that
 * resolves `app.current_organization_public_id` to a tenancy.organizations.id, with
 * an escape hatch for global retention cleanup.
 */
export const api_keys = tenancySchema
  .table(
    'api_keys',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      name: varchar('name', { length: 255 }).notNull(),
      key_hash: varchar('key_hash', { length: 255 }).notNull(),
      key_prefix: varchar('key_prefix', { length: 10 }).notNull(),
      scopes: jsonb('scopes').notNull().default([]),
      last_used_at: timestamp('last_used_at', { withTimezone: true }),
      expires_at: timestamp('expires_at', { withTimezone: true }),
      status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
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
      uniqueIndex('idx_api_keys_public_id').on(table.public_id),
      index('idx_api_keys_organization_status').on(table.organization_id, table.status),
      index('idx_api_keys_org_created_id_active')
        .on(table.organization_id, table.created_at, table.id)
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_api_keys_key_prefix').on(table.key_prefix),
      // sec-D #18: partial UNIQUE on `key_hash` for ACTIVE non-deleted rows so
      // a duplicate hash cannot authenticate as a different organization than
      // the one that issued the surviving key. Revoked keys are unaffected,
      // which keeps the legitimate rotate-then-revoke flow valid. Added by
      // migration 20260607020000.
      uniqueIndex('idx_api_keys_key_hash_active_unique')
        .on(table.key_hash)
        .where(sql`${table.status} = 'ACTIVE' AND ${table.deleted_at} IS NULL`),
      index('idx_api_keys_deleted').on(table.deleted_at).where(sql`${table.deleted_at} IS NULL`),
      index('idx_api_keys_scopes_gin').using('gin', table.scopes),
      check('chk_api_keys_status', sql`${table.status} IN ('ACTIVE', 'REVOKED')`),
      check('chk_api_keys_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('api_keys_tenant_isolation', {
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
