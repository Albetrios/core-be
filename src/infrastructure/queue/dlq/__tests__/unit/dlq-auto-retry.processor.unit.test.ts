import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
  };
});

const findDeadLetterJobsForAutoRetryMock = vi.fn();
const markDeadLetterJobAutoRetryResolvedMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/infrastructure/queue/dlq/dead-letter.repository.js', () => ({
  findDeadLetterJobsForAutoRetry: (...args: unknown[]) =>
    findDeadLetterJobsForAutoRetryMock(...args),
  markDeadLetterJobAutoRetryResolved: (...args: unknown[]) =>
    markDeadLetterJobAutoRetryResolvedMock(...args),
}));

const isDeadLetterSourceQueueCircuitClosedMock = vi.fn().mockResolvedValue(true);
vi.mock('@/infrastructure/queue/dlq/dlq-auto-retry-circuit.util.js', () => ({
  isDeadLetterSourceQueueCircuitClosed: (...args: unknown[]) =>
    isDeadLetterSourceQueueCircuitClosedMock(...args),
}));

const getDlqAutoRetryStateMock = vi.fn();
const isDeadLetterJobEligibleForAutoRetryMock = vi.fn().mockReturnValue(true);
vi.mock('@/infrastructure/queue/dlq/dlq-auto-retry.store.js', () => ({
  getDlqAutoRetryState: (...args: unknown[]) => getDlqAutoRetryStateMock(...args),
  isDeadLetterJobEligibleForAutoRetry: (...args: unknown[]) =>
    isDeadLetterJobEligibleForAutoRetryMock(...args),
  recordDlqAutoRetryAttempt: vi.fn().mockResolvedValue(undefined),
}));

const autoReplayDeadLetterFromLedgerMock = vi
  .fn()
  .mockResolvedValue({ status: 'replayed', jobId: 'job-1' });
vi.mock('@/infrastructure/queue/dlq/dlq-replay.util.js', () => ({
  autoReplayDeadLetterFromLedger: (...args: unknown[]) =>
    autoReplayDeadLetterFromLedgerMock(...args),
  DLQ_REPLAY_SOURCE_QUEUE_NAMES: ['mail'],
}));

vi.mock('@/shared/config/env.config.js', () => ({
  env: {
    DLQ_AUTO_RETRY_ENABLED: true,
    DLQ_AUTO_RETRY_MAX_COUNT: 3,
    DLQ_AUTO_RETRY_BATCH_SIZE: 20,
    DLQ_AUTO_RETRY_COOLDOWN_MINUTES: 15,
  },
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runDlqAutoRetryJob } from '@/infrastructure/queue/dlq/dlq-auto-retry.processor.js';

const ledgerRow = {
  id: 7,
  source_queue: 'mail',
  dead_letter_queue: 'mail-dlq',
  job_id: 'job-1',
  job_name: 'send-email',
  payload_summary: {},
  failed_at: new Date('2026-01-01T00:00:00.000Z'),
};

describe('runDlqAutoRetryJob — budget exhaustion marks the ledger row resolved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findDeadLetterJobsForAutoRetryMock.mockResolvedValue([ledgerRow]);
    markDeadLetterJobAutoRetryResolvedMock.mockResolvedValue(undefined);
    isDeadLetterSourceQueueCircuitClosedMock.mockResolvedValue(true);
    isDeadLetterJobEligibleForAutoRetryMock.mockReturnValue(true);
    autoReplayDeadLetterFromLedgerMock.mockResolvedValue({ status: 'replayed', jobId: 'job-1' });
  });

  it('stamps the row resolved (and skips replay) when the retry budget is exhausted', async () => {
    getDlqAutoRetryStateMock.mockResolvedValue({ count: 3 }); // == DLQ_AUTO_RETRY_MAX_COUNT

    const result = await runDlqAutoRetryJob();

    expect(result.skippedBudgetCount).toBe(1);
    expect(markDeadLetterJobAutoRetryResolvedMock).toHaveBeenCalledWith(ledgerRow.id);
    // Exhausted rows must not be replayed.
    expect(autoReplayDeadLetterFromLedgerMock).not.toHaveBeenCalled();
  });

  it('does NOT mark the row resolved when budget remains (it stays eligible)', async () => {
    getDlqAutoRetryStateMock.mockResolvedValue({ count: 0 });

    await runDlqAutoRetryJob();

    expect(markDeadLetterJobAutoRetryResolvedMock).not.toHaveBeenCalled();
    expect(autoReplayDeadLetterFromLedgerMock).toHaveBeenCalledTimes(1);
  });
});
