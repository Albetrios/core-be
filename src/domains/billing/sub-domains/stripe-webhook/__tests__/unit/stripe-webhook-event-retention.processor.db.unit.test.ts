import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { stripe_webhook_events } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook.schema.js';
import { runStripeWebhookEventRetentionJob } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook-event-retention.processor.js';
import { env } from '@/shared/config/env.config.js';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The retention worker's own unit test asserts the *arguments* passed to
 * `deleteInBatchesByCondition` (a mocked delete) — it proves the processor builds the right
 * predicate, but not that the predicate selects the right rows against real SQL. A wrong status
 * set here is a two-way hazard: purging `failed`/`processing` would destroy replayable/in-flight
 * billing events, while never purging `processed`/`skipped_duplicate` would grow the ledger without
 * bound. These cases drive the processor against real Postgres and assert on the surviving rows.
 */
describe('runStripeWebhookEventRetentionJob (database)', () => {
  const retentionDays = env.STRIPE_WEBHOOK_EVENT_RETENTION_DAYS;
  const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

  /** A timestamp `days` days before now. */
  function daysAgo(days: number): Date {
    return new Date(Date.now() - days * MILLISECONDS_PER_DAY);
  }

  /**
   * Insert a webhook-event ledger row and force its `updated_at` (the column the retention
   * predicate filters on) to `updatedAt` — `updated_at` defaults to now(), so it must be set
   * with a second statement.
   */
  async function insertEvent(id: string, status: string, updatedAt: Date): Promise<void> {
    await database.insert(stripe_webhook_events).values({
      stripe_event_id: id,
      event_type: 'customer.subscription.updated',
      stripe_created_at: updatedAt,
      processing_status: status,
    });
    await database
      .update(stripe_webhook_events)
      .set({ updated_at: updatedAt })
      .where(eq(stripe_webhook_events.stripe_event_id, id));
  }

  async function runRetention() {
    return withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.SYSTEM_TABLE_RETENTION,
      (databaseHandle) => runStripeWebhookEventRetentionJob(databaseHandle),
    );
  }

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('purges only terminal (processed / skipped_duplicate) rows past the window and RETAINS failed + processing', async () => {
    const old = daysAgo(retentionDays + 10);
    // Terminal rows beyond the window → deletable.
    await insertEvent('evt_processed_old', 'processed', old);
    await insertEvent('evt_skipped_old', 'skipped_duplicate', old);
    // failed + in-flight processing beyond the window → intentionally RETAINED for replay/ops.
    await insertEvent('evt_failed_old', 'failed', old);
    await insertEvent('evt_processing_old', 'processing', old);
    // A recent processed row inside the window → retained (age guard).
    await insertEvent('evt_processed_recent', 'processed', daysAgo(1));

    const result = await runRetention();

    expect(result.deletedCount).toBe(2);
    expect(result.blockedCount).toBe(0);
    const survivorIds = (
      await database
        .select({ id: stripe_webhook_events.stripe_event_id })
        .from(stripe_webhook_events)
    )
      .map((row) => row.id)
      .sort();
    expect(survivorIds).toEqual(
      ['evt_failed_old', 'evt_processed_recent', 'evt_processing_old'].sort(),
    );
  });

  it('keeps a terminal row sitting just inside the cutoff and deletes one just outside it', async () => {
    // The predicate is `lt(updated_at, cutoff)`, so the boundary belongs to the survivor. An
    // off-by-one to `lte` would silently start purging a day early.
    const justInside = new Date(daysAgo(retentionDays).getTime() + 60 * 60 * 1000);
    const justOutside = new Date(daysAgo(retentionDays).getTime() - 60 * 60 * 1000);
    await insertEvent('evt_inside', 'processed', justInside);
    await insertEvent('evt_outside', 'processed', justOutside);

    const result = await runRetention();

    expect(result.deletedCount).toBe(1);
    const survivors = await database
      .select({ id: stripe_webhook_events.stripe_event_id })
      .from(stripe_webhook_events);
    expect(survivors.map((row) => row.id)).toEqual(['evt_inside']);
  });
});
