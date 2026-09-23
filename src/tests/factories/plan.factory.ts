import { database } from '@/infrastructure/database/connection.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

export interface CreatePlanOptions {
  name?: string;
  priceMonthly?: string;
  priceYearly?: string;
  currency?: string;
  /** REQ-4: seat allowance baked into the plan (null/undefined = unlimited). */
  includedSeats?: number | null;
  /** REQ-4: plan capability map surfaced verbatim in the public response. */
  features?: Record<string, boolean | number | string>;
}

/**
 * Create a test plan in the database.
 */
export async function createTestPlan(options: CreatePlanOptions = {}) {
  const publicId = generatePublicId('plan');

  const [plan] = await getOperatorDatabase()
    .insert(plans)
    .values({
      public_id: publicId,
      name: options.name ?? `Test Plan ${publicId}`,
      price_monthly: options.priceMonthly ?? '9.99',
      price_yearly: options.priceYearly ?? '99.99',
      currency: options.currency ?? 'USD',
      features: options.features ?? {},
      // REQ-4: defaults to null (unlimited) so existing callers keep the no-seat-limit behaviour.
      included_seats: options.includedSeats ?? null,
    })
    .returning();

  return plan!;
}
