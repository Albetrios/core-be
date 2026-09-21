import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { SubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import { database } from '@/infrastructure/database/connection.js';
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';

describe('SubscriptionRepository (database)', () => {
  const repository = new SubscriptionRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('lists, finds, creates, and updates subscriptions for an organization', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const plan = await createTestPlan();
    const seeded = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      createdByUserId: owner.id,
    });

    const listed = await repository.listByOrganization(organization.id);
    expect(listed.some((row) => row.public_id === seeded.public_id)).toBe(true);

    const found = await repository.findByPublicId(seeded.public_id, organization.id);
    expect(found?.id).toBe(seeded.id);

    const missing = await repository.findByPublicId('invalid_public_id', organization.id);
    expect(missing).toBeNull();

    const updated = await repository.update(seeded.public_id, organization.id, {
      cancel_at_period_end: true,
    });
    expect(updated?.cancel_at_period_end).toBe(true);

    const missingUpdate = await repository.update('missing_public_id', organization.id, {
      cancel_at_period_end: false,
    });
    expect(missingUpdate).toBeNull();
  });

  it('creates a subscription when organization has none yet', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const plan = await createTestPlan();

    const created = await repository.create({
      organization_id: organization.id,
      plan_id: plan.id,
      billing_cycle: 'MONTHLY',
      status: 'TRIALING',
      current_period_start: new Date(),
      current_period_end: new Date(Date.now() + 86_400_000),
      created_by_user_id: owner.id,
    });
    expect(created.public_id).toBeTruthy();
  });

  it('syncFromStripeProviderSubscription applies fresh events and ignores stale ones', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const plan = await createTestPlan();
    const providerSubscriptionId = `sub_provider_${Date.now()}`;
    const seeded = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      providerSubscriptionId,
    });

    const freshEventAt = new Date('2026-05-01T00:00:00.000Z');
    const synced = await repository.syncFromStripeProviderSubscription(
      providerSubscriptionId,
      { status: 'PAST_DUE' },
      freshEventAt,
    );
    expect(synced?.status).toBe('PAST_DUE');
    expect(synced?.last_stripe_event_created_at?.toISOString()).toBe(freshEventAt.toISOString());

    const staleEventAt = new Date('2026-04-01T00:00:00.000Z');
    const staleSync = await repository.syncFromStripeProviderSubscription(
      providerSubscriptionId,
      { status: 'ACTIVE' },
      staleEventAt,
    );
    expect(staleSync).toBeNull();

    const refetched = await repository.findByPublicId(seeded.public_id, organization.id);
    expect(refetched?.status).toBe('PAST_DUE');
  });

  it('syncFromStripeProviderSubscription updates when last_stripe_event_created_at is null', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const plan = await createTestPlan();
    const providerSubscriptionId = `sub_null_guard_${Date.now()}`;
    const seeded = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      providerSubscriptionId,
    });

    await database
      .update(subscriptions)
      .set({ last_stripe_event_created_at: null, status: 'ACTIVE' })
      .where(eq(subscriptions.id, seeded.id));

    const eventAt = new Date('2026-06-01T00:00:00.000Z');
    const synced = await repository.syncFromStripeProviderSubscription(
      providerSubscriptionId,
      { status: 'PAUSED' },
      eventAt,
    );
    expect(synced?.status).toBe('PAUSED');
  });

  it('markCanceledByProviderSubscriptionId cancels on fresh events and ignores stale ones', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const plan = await createTestPlan();
    const providerSubscriptionId = `sub_cancel_${Date.now()}`;
    await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      providerSubscriptionId,
    });

    const freshEventAt = new Date('2026-05-10T00:00:00.000Z');
    const canceled = await repository.markCanceledByProviderSubscriptionId(
      providerSubscriptionId,
      freshEventAt,
    );
    expect(canceled?.status).toBe('CANCELED');
    expect(canceled?.canceled_at).toBeTruthy();

    const staleEventAt = new Date('2026-05-01T00:00:00.000Z');
    const staleCancel = await repository.markCanceledByProviderSubscriptionId(
      providerSubscriptionId,
      staleEventAt,
    );
    expect(staleCancel).toBeNull();
  });

  it('syncFromStripeProviderSubscription ignores same-second stale updates after cancel', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const plan = await createTestPlan();
    const providerSubscriptionId = `sub_same_second_${Date.now()}`;
    const seeded = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      providerSubscriptionId,
    });

    const eventAt = new Date('2026-05-15T12:00:00.000Z');
    const canceled = await repository.markCanceledByProviderSubscriptionId(
      providerSubscriptionId,
      eventAt,
    );
    expect(canceled?.status).toBe('CANCELED');

    const resurrectAttempt = await repository.syncFromStripeProviderSubscription(
      providerSubscriptionId,
      { status: 'ACTIVE' },
      eventAt,
    );
    expect(resurrectAttempt).toBeNull();

    const refetched = await repository.findByPublicId(seeded.public_id, organization.id);
    expect(refetched?.status).toBe('CANCELED');
  });

  it('audit-#10: rejects a second subscription with a duplicate provider_subscription_id', async () => {
    const subscribedOwner = await createTestUser();
    const subscribedOrganization = await createTestOrganization({
      ownerUserId: subscribedOwner.id,
    });
    const otherOwner = await createTestUser();
    const otherOrganization = await createTestOrganization({ ownerUserId: otherOwner.id });
    const plan = await createTestPlan();
    const providerSubscriptionId = `sub_dup_${Date.now()}`;

    await repository.create({
      organization_id: subscribedOrganization.id,
      plan_id: plan.id,
      billing_cycle: 'MONTHLY',
      status: 'ACTIVE',
      current_period_start: new Date(),
      current_period_end: new Date(Date.now() + 86_400_000),
      provider_subscription_id: providerSubscriptionId,
    });

    // A second local row pointing at the SAME Stripe subscription id (even for a
    // different organization) is now blocked by idx_subscriptions_provider_subscription_id_unique.
    await expect(
      repository.create({
        organization_id: otherOrganization.id,
        plan_id: plan.id,
        billing_cycle: 'MONTHLY',
        status: 'ACTIVE',
        current_period_start: new Date(),
        current_period_end: new Date(Date.now() + 86_400_000),
        provider_subscription_id: providerSubscriptionId,
      }),
    ).rejects.toThrow();
  });

  it('audit-#6: a same-second cancel deterministically wins even when the update arrives first', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const plan = await createTestPlan();
    const providerSubscriptionId = `sub_same_second_reverse_${Date.now()}`;
    const seeded = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      providerSubscriptionId,
    });

    const eventAt = new Date('2026-07-01T09:00:00.000Z');
    // In-place update lands FIRST at T.
    const updated = await repository.syncFromStripeProviderSubscription(
      providerSubscriptionId,
      { status: 'ACTIVE' },
      eventAt,
    );
    expect(updated?.status).toBe('ACTIVE');

    // Cancel lands SECOND at the SAME second T — the `<=` guard lets the terminal
    // event win. Combined with the cancel-then-update test above, this proves the
    // tie-break is order-independent (both orders converge on CANCELED).
    const canceled = await repository.markCanceledByProviderSubscriptionId(
      providerSubscriptionId,
      eventAt,
    );
    expect(canceled?.status).toBe('CANCELED');

    const refetched = await repository.findByPublicId(seeded.public_id, organization.id);
    expect(refetched?.status).toBe('CANCELED');
  });

  it('audit-#1: an INCOMPLETE_EXPIRED subscription releases the slot and allows re-subscription', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const plan = await createTestPlan();

    // Simulate an abandoned checkout that Stripe transitioned to incomplete_expired.
    const expired = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      createdByUserId: owner.id,
    });
    await database
      .update(subscriptions)
      .set({ status: 'INCOMPLETE_EXPIRED' })
      .where(eq(subscriptions.id, expired.id));

    // The expired row no longer counts as the org's active subscription
    // (previously it did, producing a permanent 409 on re-subscribe).
    const active = await repository.findActiveByOrganization(organization.id);
    expect(active).toBeNull();

    // A fresh subscription can be created without tripping idx_subscriptions_org.
    const resubscribed = await repository.create({
      organization_id: organization.id,
      plan_id: plan.id,
      billing_cycle: 'MONTHLY',
      status: 'INCOMPLETE',
      current_period_start: new Date(),
      current_period_end: new Date(Date.now() + 86_400_000),
      created_by_user_id: owner.id,
    });
    expect(resubscribed.public_id).toBeTruthy();
    expect(resubscribed.public_id).not.toBe(expired.public_id);

    // The new row is now the active subscription; the expired row stays excluded.
    const newActive = await repository.findActiveByOrganization(organization.id);
    expect(newActive?.public_id).toBe(resubscribed.public_id);
  });

  it('route-audit B5: a NEWER .updated event cannot resurrect a locally-terminal subscription', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const plan = await createTestPlan();
    const providerSubscriptionId = `sub_resurrect_${Date.now()}`;
    const seeded = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      providerSubscriptionId,
    });

    // Cancel at T1 (e.g. an offboarding / immediate cancel stamps the watermark with wall-clock).
    const cancelAt = new Date('2026-08-01T00:00:00.000Z');
    const canceled = await repository.markCanceledByProviderSubscriptionId(
      providerSubscriptionId,
      cancelAt,
    );
    expect(canceled?.status).toBe('CANCELED');

    // A LATER `.updated(active)` (timestamp AFTER the cancel watermark) must NOT reactivate it.
    // Pre-fix the `<` watermark let this through; the terminal guard now blocks it.
    const laterEventAt = new Date('2026-08-01T00:05:00.000Z');
    const resurrect = await repository.syncFromStripeProviderSubscription(
      providerSubscriptionId,
      { status: 'ACTIVE' },
      laterEventAt,
    );
    expect(resurrect).toBeNull();
    const refetched = await repository.findByPublicId(seeded.public_id, organization.id);
    expect(refetched?.status).toBe('CANCELED');
  });

  it('route-audit B6: update() refuses to mutate a terminal subscription (compare-and-set)', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const plan = await createTestPlan();

    // A row that became terminal (e.g. a concurrent webhook cancel after the service read-check).
    const terminal = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      status: 'CANCELED',
      providerSubscriptionId: null,
    });
    const blocked = await repository.update(terminal.public_id, organization.id, {
      cancel_at_period_end: false,
    });
    expect(blocked).toBeNull();

    // A non-terminal row still updates normally (slot-occupying ACTIVE; CANCELED released the slot).
    const active = await createTestSubscription({
      organizationId: organization.id,
      planId: plan.id,
      status: 'ACTIVE',
      providerSubscriptionId: null,
    });
    const updated = await repository.update(active.public_id, organization.id, {
      cancel_at_period_end: true,
    });
    expect(updated?.cancel_at_period_end).toBe(true);
  });

  it('idx_subscriptions_org rejects a SECOND non-terminal subscription for the same organization', async () => {
    // The partial unique index (WHERE status NOT IN CANCELED/INCOMPLETE_EXPIRED) is the durable
    // backstop for the concurrent-create race when the Redis quota lock lapses — the service's
    // 409 is only the fast path. The exclusion side (re-subscribe after cancel/expiry) is tested;
    // the ENFORCEMENT side (two non-terminal rows collide) was not.
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const plan = await createTestPlan();

    await repository.create({
      organization_id: organization.id,
      plan_id: plan.id,
      billing_cycle: 'MONTHLY',
      status: 'ACTIVE',
      current_period_start: new Date(),
      current_period_end: new Date(Date.now() + 86_400_000),
      created_by_user_id: owner.id,
    });

    await expect(
      repository.create({
        organization_id: organization.id,
        plan_id: plan.id,
        billing_cycle: 'MONTHLY',
        status: 'ACTIVE', // still non-terminal → trips the partial unique index
        current_period_start: new Date(),
        current_period_end: new Date(Date.now() + 86_400_000),
        created_by_user_id: owner.id,
      }),
    ).rejects.toThrow();
  });
});
