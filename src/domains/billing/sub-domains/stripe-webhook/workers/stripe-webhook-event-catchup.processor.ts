import { enqueueStripeWebhookByEventIdForReclaim } from '@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js';
import { StripeWebhookEventRepository } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook-event.repository.js';
import {
  isStripeConfigured,
  listRecentStripeEvents,
} from '@/infrastructure/payment/stripe.client.js';
import { env } from '@/shared/config/env.config.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/index.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

const CATCHUP_REQUEST_ID = 'stripe-webhook-event-catchup';

/**
 * Per-run counters returned by {@link runStripeWebhookEventCatchupJob}: `scannedCount` Stripe events
 * inspected from the `events.list` page, `missingCount` of those absent from the local ledger, and
 * `enqueuedCount` follow-up `stripe-webhook` jobs created to ingest them.
 *
 * @remarks
 * - **Algorithm:** populated by diffing the Stripe page against the ledger.
 * - **Failure modes:** a per-id enqueue failure decrements `enqueuedCount` but not `missingCount`.
 * - **Side effects:** none — plain data type.
 * - **Notes:** logged at `info` for ops dashboards.
 */
export type StripeWebhookEventCatchupJobResult = {
  scannedCount: number;
  missingCount: number;
  enqueuedCount: number;
};

/**
 * Recovers Stripe events that never reached the local ledger — e.g. webhooks dropped while the API
 * was down longer than the signature-tolerance window ({@link env.STRIPE_WEBHOOK_TOLERANCE_SECONDS}).
 *
 * @remarks
 * - **Algorithm:** lists the most recent Stripe events created within
 *   `STRIPE_WEBHOOK_EVENT_CATCHUP_WINDOW_MINUTES` (a single bounded page, ≤
 *   `STRIPE_WEBHOOK_EVENT_CATCHUP_PAGE_SIZE`) OUTSIDE any DB context, then — inside a `system_table`
 *   worker context — diffs them against the ledger via
 *   {@link StripeWebhookEventRepository.findExistingStripeEventIds} and enqueues only the missing ids
 *   through {@link enqueueStripeWebhookByEventIdForReclaim}. The worker then re-fetches each event and
 *   {@link StripeWebhookEventService.handleEvent} claims (inserts) the ledger row, so a never-seen
 *   event is materialised and processed exactly like a live webhook.
 * - **Idempotent + bounded:** any event still missing past the page boundary is recovered on the next
 *   run; the Stripe call is one bounded page; the diff is one `IN (...)` read.
 * - **Failure modes:** no-op (zero counts) when Stripe is not configured; individual enqueue errors
 *   are logged and skipped; Stripe/DB errors propagate so BullMQ retries.
 * - **Side effects:** one outbound Stripe `events.list` call; enqueues BullMQ jobs on `stripe-webhook`.
 * - **Notes:** the Stripe call runs before entering the DB context so no pooled connection is held
 *   across the outbound I/O. Driven by the repeatable scheduler in `infrastructure/queue/scheduler.ts`.
 */
export async function runStripeWebhookEventCatchupJob(
  repository: StripeWebhookEventRepository = new StripeWebhookEventRepository(),
): Promise<StripeWebhookEventCatchupJobResult> {
  if (!isStripeConfigured()) {
    logger.debug('stripe-webhook-event-catchup.skipped.stripe_not_configured');
    return { scannedCount: 0, missingCount: 0, enqueuedCount: 0 };
  }

  const windowMinutes = env.STRIPE_WEBHOOK_EVENT_CATCHUP_WINDOW_MINUTES;
  const pageSize = env.STRIPE_WEBHOOK_EVENT_CATCHUP_PAGE_SIZE;
  const createdGteSeconds = Math.floor(
    (Date.now() - windowMinutes * MILLISECONDS_PER_MINUTE) / 1000,
  );

  // Outbound Stripe call FIRST — outside the DB context so no pooled connection is held across it.
  const events = await listRecentStripeEvents({
    createdGteSeconds,
    limit: pageSize,
    requestId: CATCHUP_REQUEST_ID,
  });
  const stripeEventIds = events.map((event) => event.id);

  if (stripeEventIds.length === 0) {
    logger.info({ windowMinutes }, 'stripe-webhook-event-catchup.completed');
    return { scannedCount: 0, missingCount: 0, enqueuedCount: 0 };
  }

  const existingEventIds = await withMaintenanceDatabaseContext(
    MAINTENANCE_SCOPE.SYSTEM_TABLE_WORKER,
    () => repository.findExistingStripeEventIds(stripeEventIds),
  );
  const missingEventIds = stripeEventIds.filter((eventId) => !existingEventIds.has(eventId));

  // Enqueued together rather than one after another: each `add` is its own Lua round trip, and a
  // full batch paid them strictly in series. Each keeps its OWN try/catch — deliberately not
  // `addBulk`, which would collapse the batch into a single all-or-nothing call. This is the
  // recovery path for Stripe events that are already stuck, so one bad event id must not take
  // the other reclaims down with it; the per-event count and warning stay exactly as they were.
  const enqueueOutcomes = await Promise.all(
    missingEventIds.map(async (stripeEventId) => {
      try {
        await enqueueStripeWebhookByEventIdForReclaim(stripeEventId, CATCHUP_REQUEST_ID);
        return true;
      } catch (error) {
        logger.warn({ error, stripeEventId }, 'stripe-webhook-event-catchup.enqueue.failed');
        return false;
      }
    }),
  );
  const enqueuedCount = enqueueOutcomes.filter(Boolean).length;

  logger.info(
    {
      windowMinutes,
      scannedCount: stripeEventIds.length,
      missingCount: missingEventIds.length,
      enqueuedCount,
    },
    'stripe-webhook-event-catchup.completed',
  );

  return {
    scannedCount: stripeEventIds.length,
    missingCount: missingEventIds.length,
    enqueuedCount,
  };
}
