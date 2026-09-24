import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  timestamp,
  jsonb,
  varchar,
  check,
  pgPolicy,
  index,
} from 'drizzle-orm/pg-core';
import { tenancySchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';

/**
 * Drizzle table for `tenancy.organization_settings` — 1:1 with
 * `tenancy.organizations` (PK = `organization_id`). Stores per-tenant
 * delivery toggles, default UI locale (constrained to `en`/`es`), and a
 * free-form `security_policy` JSONB used for MFA enforcement and similar
 * platform rules. RLS is enforced by the
 * `organization_settings_tenant_isolation` policy.
 */
export const organization_settings = tenancySchema
  .table(
    'organization_settings',
    {
      organization_id: bigint('organization_id', { mode: 'number' })
        .primaryKey()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      is_email_notifications_enabled: boolean('is_email_notifications_enabled')
        .notNull()
        .default(true),
      default_locale: varchar('default_locale', { length: 5 }).notNull().default('en'),
      security_policy: jsonb('security_policy').notNull().default({}),
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
      // Attribution FK indexes (partial on IS NOT NULL) from migration 20260623000000 — declared so
      // the schema lists every index the database has (pinned by index-hygiene.integration.test.ts).
      index('idx_organization_settings_created_by_user_id')
        .on(table.created_by_user_id)
        .where(sql`${table.created_by_user_id} IS NOT NULL`),
      index('idx_organization_settings_updated_by_user_id')
        .on(table.updated_by_user_id)
        .where(sql`${table.updated_by_user_id} IS NOT NULL`),
      check('chk_org_settings_updated', sql`${table.updated_at} >= ${table.created_at}`),
      check(
        'chk_organization_settings_default_locale',
        sql`${table.default_locale} IN ('en', 'es')`,
      ),
      pgPolicy('organization_settings_tenant_isolation', {
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
