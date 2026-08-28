import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  varchar,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { billingSchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';

/**
 * Drizzle table for `billing.subscriptions` — one row per organization with the
 * current billing state (status, period, Stripe identifiers, last-event
 * watermark). RLS policy `subscriptions_tenant_isolation` restricts access to
 * the organization GUC unless the global retention cleanup flag is set.
 */
export const subscriptions = billingSchema
  .table(
    'subscriptions',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      plan_id: bigint('plan_id', { mode: 'number' })
        .notNull()
        .references(() => plans.id, { onDelete: 'restrict' }),
      provider: varchar('provider', { length: 50 }),
      provider_subscription_id: varchar('provider_subscription_id', { length: 255 }),
      provider_customer_id: varchar('provider_customer_id', { length: 255 }),
      billing_cycle: varchar('billing_cycle', { length: 20 }).notNull(),
      // REQ-4: purchased seat quantity synced FROM Stripe (the subscription item
      // quantity). NULL = not yet synced — seats_total then falls back to the
      // plan's included_seats.
      seats: integer('seats'),
      status: varchar('status', { length: 20 }).notNull().default('TRIALING'),
      current_period_start: timestamp('current_period_start', { withTimezone: true }).notNull(),
      current_period_end: timestamp('current_period_end', { withTimezone: true }).notNull(),
      trial_end: timestamp('trial_end', { withTimezone: true }),
      cancel_at_period_end: boolean('cancel_at_period_end').notNull().default(false),
      canceled_at: timestamp('canceled_at', { withTimezone: true }),
      last_stripe_event_created_at: timestamp('last_stripe_event_created_at', {
        withTimezone: true,
      }),
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
      uniqueIndex('idx_subscriptions_public_id').on(table.public_id),
      // Partial unique index: an organization may hold at most one non-terminal
      // subscription. CANCELED and INCOMPLETE_EXPIRED rows are excluded so
      // re-subscription after cancel OR after an abandoned-checkout expiry does
      // not collide (Issue #10 + audit-#1). Predicate kept in lockstep with
      // `INACTIVE_SUBSCRIPTION_STATUSES` and the service `TERMINAL_STATUSES` set.
      uniqueIndex('idx_subscriptions_org')
        .on(table.organization_id)
        .where(sql`${table.status} NOT IN ('CANCELED', 'INCOMPLETE_EXPIRED')`),
      index('idx_subscriptions_org_status').on(table.organization_id, table.status),
      index('idx_subscriptions_plan').on(table.plan_id),
      index('idx_subscriptions_status_period').on(table.status, table.current_period_end),
      // audit-#10: UNIQUE so two local rows can never point at one Stripe
      // subscription id (the resolver previously masked dups with LIMIT 1).
      uniqueIndex('idx_subscriptions_provider_subscription_id_unique')
        .on(table.provider_subscription_id)
        .where(sql`${table.provider_subscription_id} IS NOT NULL`),
      check(
        'chk_subs_status',
        sql`${table.status} IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'PAUSED', 'UNPAID', 'INCOMPLETE', 'INCOMPLETE_EXPIRED')`,
      ),
      check('chk_subs_cycle', sql`${table.billing_cycle} IN ('MONTHLY', 'YEARLY')`),
      // REQ-4: a NULL seat count means "not yet synced from Stripe"; any concrete value is non-negative.
      check('chk_subs_seats', sql`${table.seats} IS NULL OR ${table.seats} >= 0`),
      check('chk_subs_period', sql`${table.current_period_end} > ${table.current_period_start}`),
      check('chk_subs_updated', sql`${table.updated_at} >= ${table.created_at}`),
      // audit #41: the USING arm keeps the retention-cleanup bypass so the
      // global retention worker can SELECT/DELETE org rows it must purge, but
      // the explicit WITH CHECK omits it. Without an explicit WITH CHECK,
      // Postgres reuses USING for the write-side check, which would let any
      // context with `app.global_retention_cleanup='true'` INSERT/UPDATE a
      // subscription row under an arbitrary `organization_id`. Pinning WITH
      // CHECK to the current-org GUC forces every write to land in the active
      // tenant (HTTP request context or the Stripe-webhook
      // `withAppDatabaseContext`), closing the cross-tenant write hole. No
      // legitimate writer ever inserts/updates subscriptions under the
      // retention GUC, so dropping the bypass on the write side is safe.
      pgPolicy('subscriptions_tenant_isolation', {
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
