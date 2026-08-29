import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const inner = ((callback: (databaseHandle: unknown) => unknown) =>
    globalRetentionContextMock(callback)) as unknown as (...parameters: unknown[]) => unknown;
  return {
    ...actual,
    withMaintenanceDatabaseContext: vi.fn((_scope: unknown, ...parameters: unknown[]) =>
      inner(...parameters),
    ),
  };
});

const workerState = vi.hoisted(() => ({
  processor: undefined as (() => Promise<unknown>) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  onHandlers: {} as Record<string, (...args: unknown[]) => void>,
}));

const globalRetentionContextMock = vi.fn();
const runMembershipTombstoneRetentionJobMock = vi.fn();

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(function WorkerMock(_queueName, processor, options) {
    workerState.processor = processor;
    workerState.options = options;
    return {
      on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        workerState.onHandlers[event] = handler;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock('@/infrastructure/queue/connection.js', () => ({
  getBullMQConnectionOptions: () => ({ host: 'redis.test' }),
}));

vi.mock('@/infrastructure/queue/worker-runtime/worker-options.js', () => ({
  getRetentionWorkerOptions: () => ({
    lockDuration: 120_000,
    stalledInterval: 30_000,
    maxStalledCount: 1,
  }),
  RETENTION_WORKER_CONCURRENCY: 1,
}));

vi.mock('@/infrastructure/queue/worker-runtime/worker-close.util.js', () => ({
  buildWorkerHandle: (worker: unknown, queueName: string) => ({
    worker,
    queueName,
    close: async () => undefined,
  }),
}));

vi.mock(
  '@/domains/tenancy/sub-domains/membership/workers/membership-tombstone-retention.processor.js',
  () => ({
    runMembershipTombstoneRetentionJob: (...args: unknown[]) =>
      runMembershipTombstoneRetentionJobMock(...args),
  }),
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('membership-tombstone-retention.worker', () => {
  beforeEach(() => {
    workerState.processor = undefined;
    workerState.options = undefined;
    workerState.onHandlers = {};
    globalRetentionContextMock.mockReset();
    runMembershipTombstoneRetentionJobMock.mockReset();

    globalRetentionContextMock.mockImplementation(
      async (callback: (databaseHandle: unknown) => Promise<unknown>) =>
        callback({ kind: 'global-retention' }),
    );
    runMembershipTombstoneRetentionJobMock.mockResolvedValue({ deletedCount: 5, blockedCount: 0 });
  });

  it('creates BullMQ Worker with the correct membership-tombstone-retention queue name', async () => {
    const { createMembershipTombstoneRetentionWorker } = await import(
      '@/domains/tenancy/sub-domains/membership/workers/membership-tombstone-retention.worker.js'
    );

    const handle = createMembershipTombstoneRetentionWorker();

    expect(handle.queueName).toBe('membership-tombstone-retention');
  });

  it('creates worker with RETENTION_WORKER_CONCURRENCY of 1', async () => {
    const { createMembershipTombstoneRetentionWorker } = await import(
      '@/domains/tenancy/sub-domains/membership/workers/membership-tombstone-retention.worker.js'
    );

    createMembershipTombstoneRetentionWorker();

    expect(workerState.options).toEqual(expect.objectContaining({ concurrency: 1 }));
  });

  it('processor calls withMaintenanceDatabaseContext and runs job inside it', async () => {
    const { createMembershipTombstoneRetentionWorker } = await import(
      '@/domains/tenancy/sub-domains/membership/workers/membership-tombstone-retention.worker.js'
    );

    createMembershipTombstoneRetentionWorker();
    const result = await workerState.processor?.();

    expect(globalRetentionContextMock).toHaveBeenCalledOnce();
    expect(runMembershipTombstoneRetentionJobMock).toHaveBeenCalledWith({
      kind: 'global-retention',
    });
    expect(result).toEqual({ deletedCount: 5, blockedCount: 0 });
  });

  it('stalled handler logs a warning with queue name and jobId', async () => {
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const { createMembershipTombstoneRetentionWorker } = await import(
      '@/domains/tenancy/sub-domains/membership/workers/membership-tombstone-retention.worker.js'
    );

    createMembershipTombstoneRetentionWorker();
    workerState.onHandlers.stalled?.('job-abc-123');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { jobId: 'job-abc-123', queue: 'membership-tombstone-retention' },
      'membership-tombstone-retention.stalled',
    );
  });

  it('buildWorkerHandle is called with worker and queue name', async () => {
    const { createMembershipTombstoneRetentionWorker } = await import(
      '@/domains/tenancy/sub-domains/membership/workers/membership-tombstone-retention.worker.js'
    );

    const handle = createMembershipTombstoneRetentionWorker();

    expect(handle.worker).toBeDefined();
    expect(handle.queueName).toBe('membership-tombstone-retention');
  });

  it('processor throws when database context throws — error propagates out', async () => {
    globalRetentionContextMock.mockRejectedValue(new Error('db-context-failure'));

    const { createMembershipTombstoneRetentionWorker } = await import(
      '@/domains/tenancy/sub-domains/membership/workers/membership-tombstone-retention.worker.js'
    );

    createMembershipTombstoneRetentionWorker();

    await expect(workerState.processor?.()).rejects.toThrow('db-context-failure');
  });

  it('processor throws when job function throws — error propagates out', async () => {
    globalRetentionContextMock.mockImplementation(
      async (callback: (databaseHandle: unknown) => Promise<unknown>) =>
        callback({ kind: 'global-retention' }),
    );
    runMembershipTombstoneRetentionJobMock.mockRejectedValue(new Error('job-failure'));

    const { createMembershipTombstoneRetentionWorker } = await import(
      '@/domains/tenancy/sub-domains/membership/workers/membership-tombstone-retention.worker.js'
    );

    createMembershipTombstoneRetentionWorker();

    await expect(workerState.processor?.()).rejects.toThrow('job-failure');
  });
});
