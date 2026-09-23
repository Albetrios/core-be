import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createStripeWebhookServiceForWorker } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook.container.js';
import type { StripeWebhookService } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook.service.js';
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * audit-#1 (CRITICAL): an out-of-order `customer.subscription.deleted` delivered
 * BEFORE the `customer.subscription.created` must not allow the later (older)
 * create event to resurrect the subscription as ACTIVE. The deletion path writes
 * a terminal CANCELED tombstone; the unique index + terminal-status guard then
 * make the later create a no-op. These tests exercise the real worker service
 * (`createStripeWebhookServiceForWorker`) end-to-end against Postgres.
 */
describe('Stripe Webhook — out-of-order cancellation (audit-#1)', () => {
  let service: StripeWebhookService;
  let organizationPublicId: string;
  let planId: number;
  const stripePriceId = `price_ooo_${generatePublicId('plan')}`;

  const periodStartSeconds = 1_700_000_500;
  const periodEndSeconds = 1_700_086_900;
  // Stripe emits `.created` chronologically before `.deleted`; delivery is reordered.
  const createdEventSeconds = 1_700_000_000;
  const deletedEventSeconds = 1_700_000_600;

  function buildSubscriptionObject(providerSubscriptionId: string): Record<string, unknown> {
    return {
      id: providerSubscriptionId,
      customer: 'cus_ooo',
      cancel_at_period_end: false,
      canceled_at: null,
      metadata: { organization_id: organizationPublicId },
      items: {
        data: [
          {
            current_period_start: periodStartSeconds,
            current_period_end: periodEndSeconds,
            price: { id: stripePriceId },
          },
        ],
      },
    };
  }

  function createdEvent(providerSubscriptionId: string, eventId: string): Stripe.Event {
    return {
      id: eventId,
      type: 'customer.subscription.created',
      created: createdEventSeconds,
      data: { object: { ...buildSubscriptionObject(providerSubscriptionId), status: 'active' } },
    } as unknown as Stripe.Event;
  }

  function deletedEvent(providerSubscriptionId: string, eventId: string): Stripe.Event {
    return {
      id: eventId,
      type: 'customer.subscription.deleted',
      created: deletedEventSeconds,
      data: {
        object: {
          ...buildSubscriptionObject(providerSubscriptionId),
          status: 'canceled',
          canceled_at: deletedEventSeconds,
        },
      },
    } as unknown as Stripe.Event;
  }

  async function readSubscriptionRows(providerSubscriptionId: string) {
    return database
      .select({ id: subscriptions.id, status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.provider_subscription_id, providerSubscriptionId));
  }

  beforeAll(() => {
    service = createStripeWebhookServiceForWorker();
  });

  afterAll(async () => {
    await cleanupDatabase();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    organizationPublicId = organization.public_id;
    const [plan] = await database
      .insert(plans)
      .values({
        public_id: generatePublicId('plan'),
        name: `OOO Plan ${generatePublicId('plan')}`,
        price_monthly: '9.99',
        price_yearly: '99.99',
        currency: 'USD',
        features: {},
        stripe_price_monthly_id: stripePriceId,
      })
      .returning();
    planId = plan!.id;
    expect(planId).toBeGreaterThan(0);
  });

  it('writes a CANCELED tombstone when the deletion arrives with no local row', async () => {
    const providerSubscriptionId = `sub_ooo_${generatePublicId('subscription')}`;

    await service.handleEvent(deletedEvent(providerSubscriptionId, 'evt_del_only'));

    const rows = await readSubscriptionRows(providerSubscriptionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('CANCELED');
  });

  it('does NOT resurrect a tombstoned subscription when the older .created arrives later', async () => {
    const providerSubscriptionId = `sub_ooo_${generatePublicId('subscription')}`;

    // Delivery order: deletion first (no row → tombstone), then the older create.
    await service.handleEvent(deletedEvent(providerSubscriptionId, 'evt_del_first'));
    await service.handleEvent(createdEvent(providerSubscriptionId, 'evt_created_late'));

    const rows = await readSubscriptionRows(providerSubscriptionId);
    // Exactly one row (the tombstone) — the create must not insert a second/active row.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('CANCELED');
  });

  it('still cancels correctly when events arrive in normal order (created then deleted)', async () => {
    const providerSubscriptionId = `sub_ooo_${generatePublicId('subscription')}`;

    // .created with no prior HTTP row → fallback INSERT (ACTIVE), then .deleted cancels it.
    await service.handleEvent(createdEvent(providerSubscriptionId, 'evt_created_normal'));
    const afterCreate = await readSubscriptionRows(providerSubscriptionId);
    expect(afterCreate).toHaveLength(1);
    expect(afterCreate[0]!.status).toBe('ACTIVE');

    await service.handleEvent(deletedEvent(providerSubscriptionId, 'evt_deleted_normal'));
    const afterDelete = await readSubscriptionRows(providerSubscriptionId);
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]!.status).toBe('CANCELED');
  });
});
