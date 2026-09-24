import { sql } from 'drizzle-orm';
import {
  bigserial,
  bigint,
  varchar,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { uploadSchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';

/**
 * Drizzle definition for `upload.uploads`. Stores upload metadata + lifecycle
 * status (`PENDING` → `UPLOADED` or `FAILED`) referenced by S3 object keys.
 * Two permissive RLS policies are layered: tenant-isolation by
 * `app.current_organization_public_id` for organization-scoped rows, and an owner-access
 * policy via `app.current_user_public_id` for user-scoped (NULL-organization) uploads such
 * as avatars.
 */
export const uploads = uploadSchema
  .table(
    'uploads',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      user_id: bigint('user_id', { mode: 'number' })
        .notNull()
        .references(() => users.id),
      organization_id: bigint('organization_id', { mode: 'number' }).references(
        () => organizations.id,
      ),
      file_name: varchar('file_name', { length: 255 }).notNull(),
      file_key: varchar('file_key', { length: 512 }).notNull(),
      mime_type: varchar('mime_type', { length: 100 }).notNull(),
      file_size: integer('file_size').notNull(),
      storage_provider: varchar('storage_provider', { length: 20 }).notNull().default('s3'),
      bucket: varchar('bucket', { length: 100 }).notNull(),
      status: varchar('status', { length: 20 }).notNull().default('PENDING'),
      metadata: jsonb('metadata').notNull().default({}),
      uploaded_at: timestamp('uploaded_at', { withTimezone: true }),
      deleted_at: timestamp('deleted_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
      created_by_user_id: bigint('created_by_user_id', { mode: 'number' }).references(
        () => users.id,
      ),
    },
    (table) => [
      // Attribution FK indexes (partial on IS NOT NULL) from migration 20260623000000 — declared so
      // the schema lists every index the database has (pinned by index-hygiene.integration.test.ts).
      index('idx_uploads_created_by_user_id')
        .on(table.created_by_user_id)
        .where(sql`${table.created_by_user_id} IS NOT NULL`),
      uniqueIndex('idx_uploads_public_id').on(table.public_id),
      index('idx_uploads_user_id').on(table.user_id),
      index('idx_uploads_organization_id')
        .on(table.organization_id)
        .where(sql`${table.organization_id} IS NOT NULL`),
      index('idx_uploads_pending_created_at')
        .on(table.created_at)
        .where(sql`${table.status} = 'PENDING' AND ${table.deleted_at} IS NULL`),
      check('chk_uploads_file_size', sql`${table.file_size} >= 0`),
      check('chk_uploads_status', sql`${table.status} IN ('PENDING', 'UPLOADED', 'FAILED')`),
      pgPolicy('uploads_tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`(
            ${table.organization_id} IS NOT NULL
            AND ${table.organization_id} = (
              SELECT id FROM tenancy.organizations
              WHERE public_id = current_setting('app.current_organization_public_id', true)
            )
          )
          OR current_setting('app.global_retention_cleanup', true) = 'true'`,
        // The retention bypass appears in WITH CHECK too (unlike billing.subscriptions,
        // which is read/delete-only under retention): the pending-sweep worker UPDATEs
        // rows (auto-confirm / mark-FAILED) under the global-retention context, and
        // without the arm those writes are RLS-rejected under the production
        // core_be_app role. organization_id is never changed by those updates.
        withCheck: sql`(
            ${table.organization_id} IS NOT NULL
            AND ${table.organization_id} = (
              SELECT id FROM tenancy.organizations
              WHERE public_id = current_setting('app.current_organization_public_id', true)
            )
          )
          OR current_setting('app.global_retention_cleanup', true) = 'true'`,
      }),
      // Owner access for user-scoped (NULL-organization) uploads such as avatars. Permissive → OR'd with
      // the tenant-isolation policy. Org-scoped rows (organization_id IS NOT NULL) are excluded
      // so a former uploader cannot retain access after losing organization permissions.
      pgPolicy('uploads_owner_access', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${table.organization_id} IS NULL
          AND ${table.user_id} = (
            SELECT id FROM auth.users
            WHERE public_id = current_setting('app.current_user_public_id', true)
              AND deleted_at IS NULL
          )`,
      }),
    ],
  )
  .enableRLS();
