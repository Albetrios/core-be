import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runStripeWebhookEventReclaimJob } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook-event-reclaim.processor.js';

const sweepReclaimableEventsMock = vi.fn();
const countFailedEventsMock = vi.fn();
const tryReclaimEventMock = vi.fn();
const enqueueStripeWebhookByEventIdMock = vi.fn();
const enqueueStripeWebhookByEventIdForReclaimMock = vi.fn();
const setStripeWebhookEventsFailedCountMock = vi.fn();

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
  };
});

vi.mock('@/domains/billing/sub-domains/stripe-webhook/stripe-webhook-event.repository.js', () => ({
  StripeWebhookEventRepository: class MockStripeWebhookEventRepository {
    sweepReclaimableEvents = sweepReclaimableEventsMock;
    countFailedEvents = countFailedEventsMock;
    tryReclaimEvent = tryReclaimEventMock;
  },
}));

vi.mock('@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js', () => ({
  enqueueStripeWebhookByEventId: (...arguments_: unknown[]) =>
    enqueueStripeWebhookByEventIdMock(...arguments_),
  enqueueStripeWebhookByEventIdForReclaim: (...arguments_: unknown[]) =>
    enqueueStripeWebhookByEventIdForReclaimMock(...arguments_),
}));

vi.mock('@/infrastructure/observability/metrics/prometheus-metrics.js', () => ({
  setStripeWebhookEventsFailedCount: (...arguments_: unknown[]) =>
    setStripeWebhookEventsFailedCountMock(...arguments_),
}));

vi.mock('@/shared/config/env.config.js', () => ({
  env: { STRIPE_WEBHOOK_EVENT_RECLAIM_BATCH_SIZE: 50, LOG_LEVEL: 'silent' },
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('stripe-webhook-event-reclaim.worker', () => {
  beforeEach(() => {
    sweepReclaimableEventsMock.mockReset();
    countFailedEventsMock.mockReset();
    tryReclaimEventMock.mockReset();
    enqueueStripeWebhookByEventIdMock.mockReset();
    enqueueStripeWebhookByEventIdForReclaimMock.mockReset();
    setStripeWebhookEventsFailedCountMock.mockReset();
    sweepReclaimableEventsMock.mockResolvedValue({
      scannedCount: 2,
      candidateStripeEventIds: ['evt_reclaim_1'],
    });
    countFailedEventsMock.mockResolvedValue(0);
    enqueueStripeWebhookByEventIdMock.mockResolvedValue(undefined);
    enqueueStripeWebhookByEventIdForReclaimMock.mockResolvedValue(undefined);
  });

  it('runStripeWebhookEventReclaimJob enqueues stripe-webhook jobs for sweep candidates', async () => {
    const result = await runStripeWebhookEventReclaimJob();

    expect(sweepReclaimableEventsMock).toHaveBeenCalledWith(50);
    expect(enqueueStripeWebhookByEventIdForReclaimMock).toHaveBeenCalledWith(
      'evt_reclaim_1',
      'stripe-webhook-event-reclaim',
    );
    expect(setStripeWebhookEventsFailedCountMock).toHaveBeenCalledWith(0);
    expect(result).toEqual({ scannedCount: 2, enqueuedCount: 1 });
  });

  it('sec-re-02: cron sweep does NOT pre-bump the ledger row state', async () => {
    // The prior wiring called `tryReclaimEvent` inside the sweep, which bumped
    // the row to `processing` AND attempt_count >= 1 AND fresh `updated_at`.
    // That left the worker's subsequent `tryClaimEvent` → `tryReclaimEvent`
    // unable to match any of its three reclaim branches and DLQ'd the job.
    // The processor must no longer touch `tryReclaimEvent` — the worker owns
    // the transition.
    await runStripeWebhookEventReclaimJob();

    expect(tryReclaimEventMock).not.toHaveBeenCalled();
  });

  it('sec-re-02: cron sweep uses the reclaim-specific enqueue (fresh jobId), not the HTTP-path enqueue', async () => {
    // The HTTP-path `enqueueStripeWebhookByEventId` uses jobId
    // `stripe-event-${id}` which BullMQ retains in the failed bucket for
    // seven days (sec-Q #1). The cron retry MUST use the reclaim-specific
    // helper so the new attempt gets a fresh jobId and is not silently
    // no-op'd by the duplicate-jobId Lua path.
    await runStripeWebhookEventReclaimJob();

    expect(enqueueStripeWebhookByEventIdForReclaimMock).toHaveBeenCalledTimes(1);
    expect(enqueueStripeWebhookByEventIdMock).not.toHaveBeenCalled();
  });
});
