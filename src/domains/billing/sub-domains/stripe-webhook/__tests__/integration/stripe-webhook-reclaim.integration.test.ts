import { describe, it, expect, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import { stripe_webhook_events } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook.schema.js';
import { StripeWebhookEventRepository } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook-event.repository.js';
import { STRIPE_WEBHOOK_STUCK_PROCESSING_LEASE_MINUTES } from '@/shared/constants/index.js';

describe('Stripe webhook reclaim — integration', () => {
  const repository = new StripeWebhookEventRepository();
  const stripeEventId = `evt_reclaim_int_${Date.now()}`;

  afterEach(async () => {
    await database
      .delete(stripe_webhook_events)
      .where(eq(stripe_webhook_events.stripe_event_id, stripeEventId));
  });

  it('sec-re-02: sweepReclaimableEvents surfaces failed rows as candidates without mutating them', async () => {
    await repository.tryClaimEvent({
      stripe_event_id: stripeEventId,
      event_type: 'customer.subscription.updated',
      stripe_created_at: new Date(),
    });
    await repository.markFailed(stripeEventId, 'synthetic failure');

    const sweepResult = await repository.sweepReclaimableEvents(10);
    expect(sweepResult.candidateStripeEventIds).toContain(stripeEventId);

    // The row is NOT transitioned by the sweep — the worker's
    // tryClaimEvent → tryReclaimEvent does that when it dequeues.
    const rowsAfterSweep = await database
      .select({ processing_status: stripe_webhook_events.processing_status })
      .from(stripe_webhook_events)
      .where(eq(stripe_webhook_events.stripe_event_id, stripeEventId));
    expect(rowsAfterSweep[0]?.processing_status).toBe('failed');

    // Simulating the worker dequeue: tryClaimEvent (which internally calls
    // tryReclaimEvent) does the actual transition.
    const claimResult = await repository.tryClaimEvent({
      stripe_event_id: stripeEventId,
      event_type: 'customer.subscription.updated',
      stripe_created_at: new Date(),
    });
    expect(claimResult).toBe('reclaimed');

    const rowsAfterClaim = await database
      .select({ processing_status: stripe_webhook_events.processing_status })
      .from(stripe_webhook_events)
      .where(eq(stripe_webhook_events.stripe_event_id, stripeEventId));
    expect(rowsAfterClaim[0]?.processing_status).toBe('processing');
  });

  it('sec-re-02: sweepReclaimableEvents surfaces stuck-processing rows as candidates without mutating them', async () => {
    await repository.tryClaimEvent({
      stripe_event_id: stripeEventId,
      event_type: 'customer.subscription.updated',
      stripe_created_at: new Date(),
    });

    const stuckUpdatedAt = new Date(
      Date.now() - (STRIPE_WEBHOOK_STUCK_PROCESSING_LEASE_MINUTES + 1) * 60_000,
    );
    await database
      .update(stripe_webhook_events)
      .set({ updated_at: stuckUpdatedAt })
      .where(eq(stripe_webhook_events.stripe_event_id, stripeEventId));

    const beforeSweep = await database
      .select({ attempt_count: stripe_webhook_events.attempt_count })
      .from(stripe_webhook_events)
      .where(eq(stripe_webhook_events.stripe_event_id, stripeEventId));
    const initialAttemptCount = beforeSweep[0]?.attempt_count ?? 0;

    const sweepResult = await repository.sweepReclaimableEvents(10);
    expect(sweepResult.candidateStripeEventIds).toContain(stripeEventId);

    // Sweep is a pure read — `attempt_count` is unchanged after the call.
    const afterSweep = await database
      .select({
        processing_status: stripe_webhook_events.processing_status,
        attempt_count: stripe_webhook_events.attempt_count,
      })
      .from(stripe_webhook_events)
      .where(eq(stripe_webhook_events.stripe_event_id, stripeEventId));
    expect(afterSweep[0]?.processing_status).toBe('processing');
    expect(afterSweep[0]?.attempt_count).toBe(initialAttemptCount);

    // Worker-equivalent transition still works because the row is still in
    // stale-processing state.
    const reclaimed = await repository.tryReclaimEvent(stripeEventId);
    expect(reclaimed).toBe(true);

    const afterReclaim = await database
      .select({
        processing_status: stripe_webhook_events.processing_status,
        attempt_count: stripe_webhook_events.attempt_count,
      })
      .from(stripe_webhook_events)
      .where(eq(stripe_webhook_events.stripe_event_id, stripeEventId));
    expect(afterReclaim[0]?.processing_status).toBe('processing');
    expect(afterReclaim[0]?.attempt_count).toBe(initialAttemptCount + 1);
  });

  it('countFailedEvents returns the number of failed ledger rows', async () => {
    await repository.tryClaimEvent({
      stripe_event_id: stripeEventId,
      event_type: 'customer.subscription.updated',
      stripe_created_at: new Date(),
    });
    await repository.markFailed(stripeEventId, 'count probe');

    const failedBeforeReclaim = await repository.countFailedEvents();
    expect(failedBeforeReclaim).toBeGreaterThanOrEqual(1);

    await repository.tryReclaimEvent(stripeEventId);

    const failedAfterReclaim = await repository.countFailedEvents();
    const stillFailedRows = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(stripe_webhook_events)
      .where(eq(stripe_webhook_events.processing_status, 'failed'));
    expect(failedAfterReclaim).toBe(stillFailedRows[0]?.count ?? 0);
  });
});
