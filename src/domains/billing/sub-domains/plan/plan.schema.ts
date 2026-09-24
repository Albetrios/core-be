import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  varchar,
  text,
  boolean,
  decimal,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { billingSchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import type { PlanFeatures } from './plan.types.js';

/**
 * Drizzle table for `billing.plans` — the global subscription plan catalog with
 * monthly / yearly pricing and Stripe product/price identifiers; no tenant RLS
 * because plans are shared across all organizations.
 */
export const plans = billingSchema.table(
  'plans',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    public_id: varchar('public_id', { length: 28 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    price_monthly: decimal('price_monthly', { precision: 10, scale: 2 }).notNull(),
    price_yearly: decimal('price_yearly', { precision: 10, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    features: jsonb('features').$type<PlanFeatures>().notNull().default({}),
    // REQ-4: seat allowance baked into the plan tier. NULL = unlimited/unmetered
    // (the historical behaviour, so existing plans keep an unbounded seat count).
    included_seats: integer('included_seats'),
    stripe_product_id: varchar('stripe_product_id', { length: 255 }),
    stripe_price_monthly_id: varchar('stripe_price_monthly_id', { length: 255 }),
    stripe_price_yearly_id: varchar('stripe_price_yearly_id', { length: 255 }),
    is_active: boolean('is_active').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    created_by_user_id: bigint('created_by_user_id', { mode: 'number' }).references(() => users.id),
    updated_by_user_id: bigint('updated_by_user_id', { mode: 'number' }).references(() => users.id),
  },
  (table) => [
    // Attribution FK indexes (partial on IS NOT NULL) from migration 20260623000000 — declared so
    // the schema lists every index the database has (pinned by index-hygiene.integration.test.ts).
    index('idx_plans_created_by_user_id')
      .on(table.created_by_user_id)
      .where(sql`${table.created_by_user_id} IS NOT NULL`),
    index('idx_plans_updated_by_user_id')
      .on(table.updated_by_user_id)
      .where(sql`${table.updated_by_user_id} IS NOT NULL`),
    uniqueIndex('idx_plans_public_id').on(table.public_id),
    uniqueIndex('idx_plans_name').on(table.name),
    index('idx_plans_active_price').on(table.is_active, table.price_monthly),
    check('chk_plans_price_m', sql`${table.price_monthly} >= 0`),
    check('chk_plans_price_y', sql`${table.price_yearly} >= 0`),
    // REQ-4: a NULL seat allowance means unlimited; any concrete value is non-negative.
    check(
      'chk_plans_included_seats',
      sql`${table.included_seats} IS NULL OR ${table.included_seats} >= 0`,
    ),
    check('chk_plans_currency', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check('chk_plans_updated', sql`${table.updated_at} >= ${table.created_at}`),
  ],
);
