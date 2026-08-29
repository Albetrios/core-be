import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runMailOutboxSweeperJob } from '@/infrastructure/mail/workers/mail-outbox-sweeper.processor.js';

const findStalePendingMailOutboxIdsMock = vi.fn();
const reclaimStaleSendingMailOutboxIdsMock = vi.fn();
const enqueueMailOutboxJobMock = vi.fn();
const resendCircuitGetStateMock = vi.fn();

vi.mock('@/infrastructure/resilience/circuit-breaker.js', () => ({
  resendCircuit: {
    getState: (...arguments_: unknown[]) => resendCircuitGetStateMock(...arguments_),
  },
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
  };
});

vi.mock('@/infrastructure/mail/mail-outbox.repository.js', () => ({
  findStalePendingMailOutboxIds: (...arguments_: unknown[]) =>
    findStalePendingMailOutboxIdsMock(...arguments_),
  reclaimStaleSendingMailOutboxIds: (...arguments_: unknown[]) =>
    reclaimStaleSendingMailOutboxIdsMock(...arguments_),
}));

vi.mock('@/infrastructure/mail/queues/mail.queue.js', () => ({
  enqueueMailOutboxJob: (...arguments_: unknown[]) => enqueueMailOutboxJobMock(...arguments_),
}));

vi.mock('@/shared/config/env.config.js', () => ({
  env: {
    MAIL_OUTBOX_SWEEP_PENDING_MINUTES: 5,
    MAIL_OUTBOX_RECLAIM_SENDING_MINUTES: 10,
    MAIL_OUTBOX_SWEEP_BATCH_SIZE: 50,
    LOG_LEVEL: 'silent',
  },
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('mail-outbox-sweeper.processor', () => {
  beforeEach(() => {
    findStalePendingMailOutboxIdsMock.mockReset();
    reclaimStaleSendingMailOutboxIdsMock.mockReset();
    enqueueMailOutboxJobMock.mockReset();
    reclaimStaleSendingMailOutboxIdsMock.mockResolvedValue([]);
    findStalePendingMailOutboxIdsMock.mockResolvedValue([101, 102]);
    enqueueMailOutboxJobMock.mockResolvedValue(undefined);
    resendCircuitGetStateMock.mockReset();
    resendCircuitGetStateMock.mockResolvedValue('CLOSED');
  });

  it('runMailOutboxSweeperJob re-enqueues stale pending rows', async () => {
    const result = await runMailOutboxSweeperJob();

    expect(reclaimStaleSendingMailOutboxIdsMock).toHaveBeenCalledOnce();
    expect(findStalePendingMailOutboxIdsMock).toHaveBeenCalledOnce();
    expect(enqueueMailOutboxJobMock).toHaveBeenCalledTimes(2);
    expect(enqueueMailOutboxJobMock).toHaveBeenCalledWith(101, {
      requestId: 'mail-outbox-sweeper',
    });
    expect(result).toEqual({
      scannedCount: 2,
      reclaimedSendingCount: 0,
      reEnqueuedCount: 2,
    });
  });

  it('runMailOutboxSweeperJob reclaims stuck sending rows before stale pending', async () => {
    reclaimStaleSendingMailOutboxIdsMock.mockResolvedValue([201]);
    findStalePendingMailOutboxIdsMock.mockResolvedValue([101]);

    const result = await runMailOutboxSweeperJob();

    expect(findStalePendingMailOutboxIdsMock).toHaveBeenCalledWith(expect.any(Date), 49);
    expect(enqueueMailOutboxJobMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      scannedCount: 2,
      reclaimedSendingCount: 1,
      reEnqueuedCount: 2,
    });
  });

  it('widens the sending-reclaim window when the Resend circuit is OPEN', async () => {
    resendCircuitGetStateMock.mockResolvedValue('OPEN');
    const before = Date.now();

    await runMailOutboxSweeperJob();

    const sendingCutoff = reclaimStaleSendingMailOutboxIdsMock.mock.calls[0]?.[0] as Date;
    // CLOSED would put the cutoff ~10 min in the past; OPEN doubles the window to ~20 min, so far
    // fewer rows qualify for reclaim while Resend is down.
    const cutoffAgeMinutes = (before - sendingCutoff.getTime()) / 60_000;
    expect(cutoffAgeMinutes).toBeGreaterThanOrEqual(19);
  });

  it('keeps the normal reclaim window when the Resend circuit is CLOSED', async () => {
    resendCircuitGetStateMock.mockResolvedValue('CLOSED');
    const before = Date.now();

    await runMailOutboxSweeperJob();

    const sendingCutoff = reclaimStaleSendingMailOutboxIdsMock.mock.calls[0]?.[0] as Date;
    const cutoffAgeMinutes = (before - sendingCutoff.getTime()) / 60_000;
    expect(cutoffAgeMinutes).toBeGreaterThanOrEqual(9);
    expect(cutoffAgeMinutes).toBeLessThan(15);
  });
});
