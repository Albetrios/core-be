import { enqueueStripeWebhookByEventIdForReclaim } from '@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js';
import { StripeWebhookEventRepository } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook-event.repository.js';
import { setStripeWebhookEventsFailedCount } from '@/infrastructure/observability/metrics/prometheus-metrics.js';
import { env } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

/**
 * Per-run counters returned by {@link runStripeWebhookEventReclaimJob}:
 * `scannedCount` is the number of candidate ledger rows inspected and
 * `enqueuedCount` is how many follow-up `stripe-webhook` jobs were created.
 *
 * @remarks
 * - **Algorithm:** Populated by counting rows from the repository sweep.
 * - **Failure modes:** Re-enqueue failures decrement `enqueuedCount` but do not
 *   affect the row state — the row remains in `failed` or stuck-`processing`
 *   for the next sweep, and the worker performs the actual transition when it
 *   dequeues the re-enqueued job (sec-re-02).
 * - **Side effects:** None — this is a plain data type.
 * - **Notes:** Useful for metrics / log assertions in tests.
 */
export type StripeWebhookEventReclaimJobResult = {
  scannedCount: number;
  enqueuedCount: number;
};

/**
 * Sweeps the Stripe webhook ledger for events that were left in `failed` or
 * stale-`processing` state and re-enqueues fresh jobs so the BullMQ worker can
 * retry them.
 *
 * @remarks
 * - **Algorithm:** Within {@link withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.SYSTEM_TABLE_WORKER)}, asks
 *   {@link StripeWebhookEventRepository.sweepReclaimableEvents} for up to
 *   `env.STRIPE_WEBHOOK_EVENT_RECLAIM_BATCH_SIZE` candidate ids — a pure read,
 *   no row mutation (sec-re-02). For each candidate the processor enqueues a
 *   reclaim job via {@link enqueueStripeWebhookByEventIdForReclaim}, which
 *   uses a fresh attempt-unique jobId so BullMQ's seven-day failed-job
 *   retention (sec-Q #1) does not silently no-op the re-enqueue. The actual
 *   `failed → processing` (or stale-`processing → processing`) transition is
 *   performed by the worker's `tryClaimEvent` → `tryReclaimEvent` when it
 *   dequeues the job — keeping the atomic state machine in one place.
 * - **Failure modes:** Individual re-enqueue errors are logged and skipped so a
 *   single bad event does not block the rest of the batch. Because the
 *   processor does not mutate the row, a failed enqueue simply leaves the row
 *   in its current state for the next sweep.
 * - **Side effects:** Enqueues BullMQ jobs on the `stripe-webhook` queue and
 *   refreshes the `stripe_webhook_events_failed_count` Prometheus gauge.
 * - **Notes:** Driven by the repeatable scheduler registered in
 *   `src/infrastructure/queue/scheduler.ts`; the parameter is injectable for
 *   tests.
 */
export async function runStripeWebhookEventReclaimJob(
  repository: StripeWebhookEventRepository = new StripeWebhookEventRepository(),
): Promise<StripeWebhookEventReclaimJobResult> {
  return withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.SYSTEM_TABLE_WORKER, () =>
    runStripeWebhookEventReclaimJobInner(repository),
  );
}

async function runStripeWebhookEventReclaimJobInner(
  repository: StripeWebhookEventRepository,
): Promise<StripeWebhookEventReclaimJobResult> {
  const batchSize = env.STRIPE_WEBHOOK_EVENT_RECLAIM_BATCH_SIZE;
  const { scannedCount, candidateStripeEventIds } =
    await repository.sweepReclaimableEvents(batchSize);

  let enqueuedCount = 0;
  for (const stripeEventId of candidateStripeEventIds) {
    try {
      await enqueueStripeWebhookByEventIdForReclaim(stripeEventId, 'stripe-webhook-event-reclaim');
      enqueuedCount += 1;
    } catch (error) {
      logger.warn({ error, stripeEventId }, 'stripe-webhook-event-reclaim.enqueue.failed');
    }
  }

  const failedCount = await repository.countFailedEvents();
  setStripeWebhookEventsFailedCount(failedCount);

  logger.info(
    { scannedCount, enqueuedCount, failedCount },
    'stripe-webhook-event-reclaim.completed',
  );

  return { scannedCount, enqueuedCount };
}
