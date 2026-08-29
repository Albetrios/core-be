/**
 * Billing plan seed — default plans (Free, Starter, Pro).
 * Domain-owned; used by scripts/seed orchestration.
 */
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';

/**
 * Free / Starter / Pro baseline used by `pnpm db:seed`. REQ-4: each tier now carries a seat
 * allowance (`included_seats`) and a `features` capability map — Free is small, Pro is larger.
 * Free has 1 seat (solo), Starter 5, Pro 25.
 */
export const DEFAULT_PLANS = [
  {
    name: 'Free',
    price_monthly: '0.00',
    price_yearly: '0.00',
    included_seats: 1,
    features: { priority_support: false, audit_log: false, sso: false },
  },
  {
    name: 'Starter',
    price_monthly: '29.00',
    price_yearly: '290.00',
    included_seats: 5,
    features: { priority_support: false, audit_log: true, sso: false },
  },
  {
    name: 'Pro',
    price_monthly: '99.00',
    price_yearly: '990.00',
    included_seats: 25,
    features: { priority_support: true, audit_log: true, sso: true },
  },
];

/**
 * Idempotently inserts the {@link DEFAULT_PLANS} catalog (or a caller-supplied
 * list), skipping rows whose `name` already exists via `ON CONFLICT DO NOTHING`.
 */
export async function seedPlans(
  items: Array<{
    name: string;
    price_monthly: string;
    price_yearly: string;
    is_active?: boolean;
    included_seats?: number | null;
    features?: Record<string, boolean | number | string>;
  }> = DEFAULT_PLANS,
) {
  const inserted = [];
  for (const plan of items) {
    const [row] = await getRequestDatabase()
      .insert(plans)
      .values({
        public_id: generatePublicId('plan'),
        name: plan.name,
        price_monthly: plan.price_monthly,
        price_yearly: plan.price_yearly,
        is_active: plan.is_active ?? true,
        // REQ-4: seat allowance (null = unlimited) + capability flags.
        included_seats: plan.included_seats ?? null,
        ...(plan.features !== undefined ? { features: plan.features } : {}),
      })
      .onConflictDoNothing()
      .returning();
    if (row) inserted.push(row);
  }
  return inserted;
}
