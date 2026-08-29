/**
 * Subscription bulk seeder — for every organization in the registry, creates
 * `counts.subscriptionsPerOrg` subscriptions linked to a plan from the catalog and the organization owner.
 *
 * Status spread vs. the schema: `idx_subscriptions_org` is a partial unique index that permits at
 * most one non-`CANCELED` subscription per organization (Issue #10). So each organization gets exactly one
 * live subscription (its status rotated across the non-terminal values by organization index, so the whole
 * dataset still covers every live status) and the remaining rows are `CANCELED`. Across the run
 * every value of the `chk_subs_status` constraint is exercised.
 *
 * Idempotency: every bulk row carries a deterministic marker `provider_subscription_id` of the
 * form `sub_bulk_<organizationId>_<index>`. The seeder counts existing markers per organization and only
 * creates the missing higher indices, so a re-run with the same counts is a no-op.
 */
import { and, eq, like } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';
import { generateBulkSubscriptionWindow } from './subscription.faker.js';

const BULK_PROVIDER = 'stripe';
const BULK_SUBSCRIPTION_PREFIX = 'sub_bulk_';

/** Non-terminal statuses (every value of `chk_subs_status` except `CANCELED`). */
const LIVE_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'PAUSED',
  'UNPAID',
  'INCOMPLETE',
  'INCOMPLETE_EXPIRED',
] as const;

/** A plan row the bulk subscriptions link to. */
interface PlanReference {
  /** Internal bigint primary key. */
  id: number;
}

/** Marker prefix for one organization's bulk subscriptions. */
function bulkPrefixForOrganization(organizationId: number): string {
  return `${BULK_SUBSCRIPTION_PREFIX}${organizationId}_`;
}

/**
 * Seeds subscriptions for every organization in `context.registry.organizations`.
 *
 * @remarks
 * Algorithm: load the plan catalog once, then for each organization count existing bulk markers and insert
 * only the missing higher indices (index 0 = a live subscription whose status rotates by organization index;
 * later indices = `CANCELED`). Side effects: inserts into `billing.subscriptions`. Failure modes:
 * warns and returns early if the organization registry or plan catalog is empty; otherwise propagates DB
 * errors.
 */
export async function seedSubscriptionsBulk(context: SeedContext): Promise<void> {
  const database = getRequestDatabase();
  const { subscriptionsPerOrg } = context.counts;
  const organizationPool = context.registry.organizations;
  if (organizationPool.length === 0) {
    context.logger.warn(
      'seed.bulk.subscription: empty organization pool; run tenancy seeder first',
    );
    return;
  }

  const planPool: PlanReference[] = await database.select({ id: plans.id }).from(plans);
  if (planPool.length === 0) {
    context.logger.warn(
      'seed.bulk.subscription: empty plan catalog; run the plan reference seed first',
    );
    return;
  }

  let created = 0;
  for (const [organizationIndex, organization] of organizationPool.entries()) {
    created += await seedSubscriptionsForOrganization({
      context,
      organization,
      organizationIndex,
      planPool,
      target: subscriptionsPerOrg,
    });
  }

  context.logger.info(
    { organizations: organizationPool.length, created },
    'seed.bulk.subscription: subscriptions seeded',
  );
}

/** Seeds the missing bulk subscriptions for a single organization and returns how many were created. */
async function seedSubscriptionsForOrganization(options: {
  context: SeedContext;
  organization: SeededOrg;
  organizationIndex: number;
  planPool: PlanReference[];
  target: number;
}): Promise<number> {
  const { context, organization, organizationIndex, planPool, target } = options;
  const database = getRequestDatabase();

  const existing = await database
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.organization_id, organization.id),
        like(
          subscriptions.provider_subscription_id,
          `${bulkPrefixForOrganization(organization.id)}%`,
        ),
      ),
    );

  let created = 0;
  for (let index = existing.length; index < target; index += 1) {
    const isLive = index === 0;
    const status = isLive
      ? (LIVE_STATUSES[organizationIndex % LIVE_STATUSES.length] as string)
      : 'CANCELED';
    const plan = planPool[(organizationIndex + index) % planPool.length] as PlanReference;
    const window = generateBulkSubscriptionWindow(context.faker);

    await database.insert(subscriptions).values({
      public_id: generatePublicId('subscription'),
      organization_id: organization.id,
      plan_id: plan.id,
      provider: BULK_PROVIDER,
      provider_subscription_id: `${bulkPrefixForOrganization(organization.id)}${index}`,
      provider_customer_id: `cus_bulk_${organization.id}`,
      billing_cycle: window.billing_cycle,
      status,
      current_period_start: window.current_period_start,
      current_period_end: window.current_period_end,
      trial_end: status === 'TRIALING' ? window.current_period_end : null,
      cancel_at_period_end: status === 'CANCELED',
      canceled_at: status === 'CANCELED' ? window.current_period_start : null,
      created_by_user_id: organization.ownerUserId,
    });
    created += 1;
  }

  return created;
}
