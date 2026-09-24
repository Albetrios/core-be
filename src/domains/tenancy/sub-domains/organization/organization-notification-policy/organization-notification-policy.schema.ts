import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  varchar,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  check,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { tenancySchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';

/**
 * Drizzle table for `tenancy.organization_notification_policies` — defines,
 * per organization, how each `(notification_type, channel)` pair is
 * delivered (default_enabled / is_mandatory / muted_until). The
 * `idx_org_notif_policy_unique` index enforces a single policy per pair, the
 * channel `check` constraint restricts values to
 * `EMAIL`/`SMS`/`WEB_PUSH`/`IN_APP`, and the
 * `organization_notification_policies_tenant_isolation` policy enforces RLS.
 */
export const organization_notification_policies = tenancySchema
  .table(
    'organization_notification_policies',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      notification_type: varchar('notification_type', { length: 50 }).notNull(),
      channel: varchar('channel', { length: 20 }).notNull(),
      default_enabled: boolean('default_enabled').notNull().default(true),
      is_mandatory: boolean('is_mandatory').notNull().default(false),
      muted_until: timestamp('muted_until', { withTimezone: true }),
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
      // Attribution FK indexes (partial on IS NOT NULL) from migration 20260623000000 — declared so
      // the schema lists every index the database has (pinned by index-hygiene.integration.test.ts).
      index('idx_organization_notification_policies_created_by_user_id')
        .on(table.created_by_user_id)
        .where(sql`${table.created_by_user_id} IS NOT NULL`),
      index('idx_organization_notification_policies_updated_by_user_id')
        .on(table.updated_by_user_id)
        .where(sql`${table.updated_by_user_id} IS NOT NULL`),
      uniqueIndex('idx_organization_notification_policies_public_id').on(table.public_id),
      uniqueIndex('idx_org_notif_policy_unique').on(
        table.organization_id,
        table.notification_type,
        table.channel,
      ),
      index('idx_org_notif_policy_mandatory').on(table.organization_id, table.is_mandatory),
      // sec-D #34: `idx_org_notif_policy_muted` was dropped by migration
      // 20260607060000. After sec-D1 (writers normalize stale mutes to NULL),
      // the column is either NULL or a future timestamp and no read path
      // filters by it; the btree was pure dead weight on every upsert.
      check(
        'chk_org_notif_channel',
        sql`${table.channel} IN ('EMAIL', 'SMS', 'WEB_PUSH', 'IN_APP')`,
      ),
      // sec-D1: the previous `chk_org_notif_muted` (volatile `now()` in a
      // CHECK) made the row IMMUTABLE once `muted_until` slipped into the
      // past — even soft-delete failed. Mute expiry is enforced at the
      // read layer (`muted_until > now()` in selects) and writers
      // normalize stale mutes to NULL before persisting. The constraint
      // is dropped by migration `20260605240100_drop_volatile_chk_org_notif_muted.sql`.
      check('chk_org_notif_updated', sql`${table.updated_at} >= ${table.created_at}`),
      pgPolicy('organization_notification_policies_tenant_isolation', {
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
