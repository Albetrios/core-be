import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runStripeWebhookEventCatchupJob } from '@/domains/billing/sub-domains/stripe-webhook/workers/stripe-webhook-event-catchup.processor.js';
import type { StripeWebhookEventRepository } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook-event.repository.js';

const isStripeConfiguredMock = vi.fn();
const listRecentStripeEventsMock = vi.fn();
const enqueueStripeWebhookByEventIdForReclaimMock = vi.fn();

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
  };
});

vi.mock('@/infrastructure/payment/stripe.client.js', () => ({
  isStripeConfigured: (...arguments_: unknown[]) => isStripeConfiguredMock(...arguments_),
  listRecentStripeEvents: (...arguments_: unknown[]) => listRecentStripeEventsMock(...arguments_),
}));

vi.mock('@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js', () => ({
  enqueueStripeWebhookByEventIdForReclaim: (...arguments_: unknown[]) =>
    enqueueStripeWebhookByEventIdForReclaimMock(...arguments_),
}));

vi.mock('@/shared/config/env.config.js', () => ({
  env: {
    STRIPE_WEBHOOK_EVENT_CATCHUP_WINDOW_MINUTES: 60,
    STRIPE_WEBHOOK_EVENT_CATCHUP_PAGE_SIZE: 100,
  },
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function buildRepository(existing: string[]): StripeWebhookEventRepository {
  return {
    findExistingStripeEventIds: vi.fn().mockResolvedValue(new Set(existing)),
  } as unknown as StripeWebhookEventRepository;
}

describe('runStripeWebhookEventCatchupJob', () => {
  beforeEach(() => {
    isStripeConfiguredMock.mockReset().mockReturnValue(true);
    listRecentStripeEventsMock.mockReset();
    enqueueStripeWebhookByEventIdForReclaimMock.mockReset().mockResolvedValue(undefined);
  });

  it('enqueues only events missing from the ledger', async () => {
    listRecentStripeEventsMock.mockResolvedValue([
      { id: 'evt_present' },
      { id: 'evt_missing_1' },
      { id: 'evt_missing_2' },
    ]);
    const repository = buildRepository(['evt_present']);

    const result = await runStripeWebhookEventCatchupJob(repository);

    expect(result).toEqual({ scannedCount: 3, missingCount: 2, enqueuedCount: 2 });
    expect(enqueueStripeWebhookByEventIdForReclaimMock).toHaveBeenCalledTimes(2);
    expect(enqueueStripeWebhookByEventIdForReclaimMock).toHaveBeenCalledWith(
      'evt_missing_1',
      'stripe-webhook-event-catchup',
    );
    expect(enqueueStripeWebhookByEventIdForReclaimMock).not.toHaveBeenCalledWith(
      'evt_present',
      expect.anything(),
    );
  });

  it('no-ops without a Stripe call when Stripe is not configured', async () => {
    isStripeConfiguredMock.mockReturnValue(false);

    const result = await runStripeWebhookEventCatchupJob(buildRepository([]));

    expect(result).toEqual({ scannedCount: 0, missingCount: 0, enqueuedCount: 0 });
    expect(listRecentStripeEventsMock).not.toHaveBeenCalled();
    expect(enqueueStripeWebhookByEventIdForReclaimMock).not.toHaveBeenCalled();
  });

  it('returns zero counts when the Stripe page is empty', async () => {
    listRecentStripeEventsMock.mockResolvedValue([]);

    const result = await runStripeWebhookEventCatchupJob(buildRepository([]));

    expect(result).toEqual({ scannedCount: 0, missingCount: 0, enqueuedCount: 0 });
    expect(enqueueStripeWebhookByEventIdForReclaimMock).not.toHaveBeenCalled();
  });

  it('skips a failed enqueue without aborting the batch', async () => {
    listRecentStripeEventsMock.mockResolvedValue([{ id: 'evt_a' }, { id: 'evt_b' }]);
    enqueueStripeWebhookByEventIdForReclaimMock
      .mockRejectedValueOnce(new Error('redis-down'))
      .mockResolvedValueOnce(undefined);

    const result = await runStripeWebhookEventCatchupJob(buildRepository([]));

    expect(result).toEqual({ scannedCount: 2, missingCount: 2, enqueuedCount: 1 });
    expect(enqueueStripeWebhookByEventIdForReclaimMock).toHaveBeenCalledTimes(2);
  });
});
