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

/**
 * Drizzle table for `tenancy.organizations` — the per-tenant root entity.
 * Holds slug-based identity, ownership, lifecycle status, optional Stripe
 * customer linkage, and soft-delete via `deleted_at`. The `pgPolicy`
 * `organizations_tenant_isolation` enforces RLS by matching `public_id` to
 * `app.current_organization_public_id`, with a global retention-cleanup escape
 * hatch for tombstone workers.
 */
export const organizations = tenancySchema
  .table(
    'organizations',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      name: varchar('name', { length: 255 }).notNull(),
      // Nullable: personal organizations carry no human-facing slug (their app URL is `/`,
      // and they are never listed in `/organizations`). Team organizations require one.
      slug: varchar('slug', { length: 100 }),
      // PERSONAL = a single-owner organization auto-provisioned at signup (the user's own
      // workspace); TEAM = a shareable organization with members/roles/invitations.
      type: varchar('type', { length: 20 }).notNull().default('TEAM'),
      owner_user_id: bigint('owner_user_id', { mode: 'number' })
        .notNull()
        .references(() => users.id),
      status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
      logo_url: varchar('logo_url', { length: 512 }),
      stripe_customer_id: varchar('stripe_customer_id', { length: 255 }),
      deleted_at: timestamp('deleted_at', { withTimezone: true }),
      deletion_started_at: timestamp('deletion_started_at', { withTimezone: true }),
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
      uniqueIndex('idx_organizations_public_id').on(table.public_id),
      // Partial: only LIVE rows constrain the team-slug namespace. A full index would keep a
      // soft-deleted team's slug indexed, so `findBySlug` (which filters `deleted_at IS NULL`)
      // reports the slug free while the INSERT collides with the tombstone — burning the slug
      // for everyone until tombstone-retention hard-deletes the row. Mirrors `idx_users_email_unique`
      // and `idx_memberships_user_org_unique`. (Personal organizations have NULL slug → never indexed here.)
      uniqueIndex('idx_organizations_slug').on(table.slug).where(sql`${table.deleted_at} IS NULL`),
      // At most one PERSONAL organization per owner (personal slug is NULL, so the slug
      // unique index does not constrain them — this partial index does).
      uniqueIndex('idx_org_one_personal_per_owner')
        .on(table.owner_user_id)
        .where(sql`${table.type} = 'PERSONAL'`),
      index('idx_organizations_owner').on(table.owner_user_id),
      index('idx_organizations_status_deleted').on(table.status, table.deleted_at),
      index('idx_organizations_created_at').on(table.created_at),
      index('idx_organizations_created_id_active')
        .on(table.created_at, table.id)
        .where(sql`${table.deleted_at} IS NULL`),
      index('idx_organizations_active')
        .on(table.name)
        .where(sql`${table.deleted_at} IS NULL AND ${table.status} = 'ACTIVE'`),
      uniqueIndex('idx_organizations_stripe_customer_id')
        .on(table.stripe_customer_id)
        .where(sql`${table.stripe_customer_id} IS NOT NULL`),
      check(
        'chk_organizations_status',
        sql`${table.status} IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')`,
      ),
      check('chk_organizations_type', sql`${table.type} IN ('PERSONAL', 'TEAM')`),
      // CHECK passes when the expression is NULL, so personal organizations (slug NULL)
      // are allowed; team slugs must match the kebab pattern.
      check('chk_organizations_slug', sql`${table.slug} ~ '^[a-z0-9-]+$'`),
      check('chk_organizations_updated', sql`${table.updated_at} >= ${table.created_at}`),
      // sec-new-D3 keeps `deleted_at IS NULL` on the tenant SELECT arm (a stale organization claim
      // must never read a soft-deleted organization). Because Postgres requires an UPDATE's NEW row
      // to stay SELECT-visible, the tombstoning soft-delete cannot run under the plain organization
      // scope — the service runs it under the global-retention context, whose arm appears
      // in BOTH USING and WITH CHECK (mirroring uploads_tenant_isolation; the tombstone
      // never changes the org's identity columns).
      pgPolicy('organizations_tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`(
            ${table.public_id} = current_setting('app.current_organization_public_id', true)
            AND ${table.deleted_at} IS NULL
          )
          OR current_setting('app.global_retention_cleanup', true) = 'true'`,
        withCheck: sql`${table.public_id} = current_setting('app.current_organization_public_id', true)
          OR current_setting('app.global_retention_cleanup', true) = 'true'`,
      }),
    ],
  )
  .enableRLS();
