import { and, asc, eq, or } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';

/**
 * Hard cap on the number of active plan rows returned by `findAllActive`.
 *
 * sec-r4-D3: the catalog is intentionally small (a few tiers in production),
 * but an operator with INSERT on `billing.plans` could otherwise grow it
 * without bound and a single \\/api/v1/plans\\ request would page the entire
 * table into the API process. 100 is well clear of any realistic plan catalog
 * and bounds the memory cost of the public list endpoint.
 */
const PLAN_FIND_ALL_ACTIVE_LIMIT = 100;

/**
 * Drizzle access to the `billing.plans` catalog table. Plans are a global system
 * table (no organization scope), so reads do not depend on RLS context.
 */
export class PlanRepository {
  async findAllActive() {
    return getRequestDatabase()
      .select()
      .from(plans)
      .where(eq(plans.is_active, true))
      .limit(PLAN_FIND_ALL_ACTIVE_LIMIT);
  }

  async findByPublicId(public_id: string) {
    const rows = await getRequestDatabase()
      .select()
      .from(plans)
      .where(eq(plans.public_id, public_id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findById(id: number) {
    const rows = await getRequestDatabase().select().from(plans).where(eq(plans.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Returns the `included_seats` of the cheapest active plan — the "Free tier" seat ceiling.
   *
   * @remarks
   * - **Algorithm:** orders active plans by `price_monthly` ascending (served by
   *   `idx_plans_active_price`) and takes the first row's `included_seats`.
   * - **Failure modes:** returns `null` when no active plan exists OR the cheapest plan grants
   *   unlimited seats (`included_seats IS NULL`) — both mean "no Free-tier ceiling to enforce".
   * - **Notes:** the entitlement floor for an organization with no active subscription (and for a
   *   dunning subscription past its grace window) is derived from this, so the Free-tier allowance
   *   tracks whatever the catalog's entry tier is rather than a hard-coded constant.
   */
  async findFreePlanSeatCeiling(): Promise<number | null> {
    const rows = await getRequestDatabase()
      .select({ included_seats: plans.included_seats })
      .from(plans)
      .where(eq(plans.is_active, true))
      .orderBy(asc(plans.price_monthly))
      .limit(1);
    return rows[0]?.included_seats ?? null;
  }

  /**
   * Resolves a Stripe price id to the owning local plan (matches either the
   * monthly or yearly column). Returns null when no catalog row references the
   * given price id — used by the Stripe webhook handler to map an externally-
   * mutated subscription back to the local plan id.
   *
   * @remarks
   * sec-B7: `customer.subscription.updated` events used to skip the price → plan
   * mapping, so a plan change initiated directly in the Stripe Dashboard left
   * the local `subscriptions.plan_id` pinned to the previous plan. Every
   * entitlement check against `plan.features` continued serving the OLD
   * feature set until something other than a webhook (e.g. a fresh checkout)
   * rebuilt the row. This finder is the lookup half of the fix; the webhook
   * handler now passes the resolved id into `syncFromStripeProviderSubscription`.
   */
  async findByStripePriceId(stripe_price_id: string) {
    const rows = await getRequestDatabase()
      .select()
      .from(plans)
      .where(
        and(
          eq(plans.is_active, true),
          or(
            eq(plans.stripe_price_monthly_id, stripe_price_id),
            eq(plans.stripe_price_yearly_id, stripe_price_id),
          ),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}
