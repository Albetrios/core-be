import { describe, it, expect, beforeEach } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { PlanRepository } from '@/domains/billing/sub-domains/plan/plan.repository.js';
import { database } from '@/infrastructure/database/connection.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import { eq } from 'drizzle-orm';

describe('PlanRepository (database)', () => {
  const repository = new PlanRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('finds active plans and looks up by public id and internal id', async () => {
    const activePlan = await createTestPlan({ name: 'Active Plan' });
    const inactivePlan = await createTestPlan({ name: 'Inactive Plan' });
    await database.update(plans).set({ is_active: false }).where(eq(plans.id, inactivePlan.id));

    const activePlans = await repository.findAllActive();
    expect(activePlans.some((row) => row.public_id === activePlan.public_id)).toBe(true);
    expect(activePlans.some((row) => row.public_id === inactivePlan.public_id)).toBe(false);

    const byPublicId = await repository.findByPublicId(activePlan.public_id);
    expect(byPublicId?.name).toBe('Active Plan');

    const missingPublicId = await repository.findByPublicId('not_a_real_public_id');
    expect(missingPublicId).toBeNull();

    const byId = await repository.findById(activePlan.id);
    expect(byId?.public_id).toBe(activePlan.public_id);

    const missingId = await repository.findById(9_999_999);
    expect(missingId).toBeNull();
  });

  // sec-r4-D3: findAllActive must apply a hard row cap so an unbounded plan
  // catalog can never page the entire table into the API process.
  it('findAllActive caps results at 100 rows even when more active plans exist (sec-r4-D3)', async () => {
    // Seed 101 active plans — slug must be unique per row.
    for (let index = 0; index < 101; index += 1) {
      await createTestPlan({ name: `Bulk Plan ${String(index).padStart(3, '0')}` });
    }

    const activePlans = await repository.findAllActive();
    expect(activePlans.length).toBe(100);
  });

  // sec-B7: findByStripePriceId is the price→plan lookup the webhook uses to map a
  // Dashboard-driven plan change back to the local plan. It must match EITHER the monthly
  // or the yearly price column, and must never resolve an inactive (decommissioned) plan.
  it('findByStripePriceId matches the yearly price column and excludes inactive plans (sec-B7)', async () => {
    const plan = await createTestPlan({ name: 'Stripe-Linked Plan' });
    // The factory does not set Stripe price ids; set them directly (same pattern as is_active above).
    await database
      .update(plans)
      .set({
        stripe_price_monthly_id: 'price_monthly_live',
        stripe_price_yearly_id: 'price_yearly_live',
      })
      .where(eq(plans.id, plan.id));

    // Resolves via the YEARLY column, not only the monthly one — the `or(...)` covers both.
    const byYearly = await repository.findByStripePriceId('price_yearly_live');
    expect(byYearly?.public_id).toBe(plan.public_id);
    // …and via the monthly column.
    const byMonthly = await repository.findByStripePriceId('price_monthly_live');
    expect(byMonthly?.public_id).toBe(plan.public_id);

    // A retired plan whose price id still matches must NOT resolve: the `is_active = true` guard
    // stops the webhook from re-pinning a subscription onto a decommissioned plan.
    await database.update(plans).set({ is_active: false }).where(eq(plans.id, plan.id));
    expect(await repository.findByStripePriceId('price_yearly_live')).toBeNull();

    // An unknown price id resolves to null.
    expect(await repository.findByStripePriceId('price_unknown')).toBeNull();
  });

  // findFreePlanSeatCeiling drives the entitlement floor for organizations with no active subscription:
  // the cheapest ACTIVE plan's included_seats (served by idx_plans_active_price). A cheaper
  // INACTIVE plan must be ignored, and an unlimited (null) cheapest plan means "no ceiling".
  it('findFreePlanSeatCeiling returns the cheapest ACTIVE plan seat ceiling, ignoring cheaper inactive plans', async () => {
    // Cheapest row overall is inactive → must be skipped despite the lowest price.
    const cheapInactive = await createTestPlan({
      name: 'Cheap Retired',
      priceMonthly: '1.00',
      includedSeats: 99,
    });
    await database.update(plans).set({ is_active: false }).where(eq(plans.id, cheapInactive.id));
    // Cheapest ACTIVE plan → its included_seats (2) is the ceiling.
    await createTestPlan({ name: 'Entry Active', priceMonthly: '5.00', includedSeats: 2 });
    await createTestPlan({ name: 'Pro Active', priceMonthly: '20.00', includedSeats: 25 });

    expect(await repository.findFreePlanSeatCeiling()).toBe(2);
  });

  it('findFreePlanSeatCeiling returns null when the cheapest active plan grants unlimited seats', async () => {
    // Cheapest active plan has included_seats = null (unlimited) → no Free-tier ceiling to enforce.
    await createTestPlan({ name: 'Unlimited Entry', priceMonthly: '5.00', includedSeats: null });
    await createTestPlan({ name: 'Higher Tier', priceMonthly: '20.00', includedSeats: 25 });

    expect(await repository.findFreePlanSeatCeiling()).toBeNull();
  });
});
