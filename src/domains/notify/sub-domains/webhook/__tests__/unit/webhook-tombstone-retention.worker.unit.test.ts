import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  '@/infrastructure/database/contexts/maintenance-database.context.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const inner = ((callback: (databaseHandle: unknown) => unknown) =>
      withGlobalRetentionCleanupDatabaseContextMock(callback)) as unknown as (
      ...parameters: unknown[]
    ) => unknown;
    return {
      ...actual,
      withMaintenanceDatabaseContext: vi.fn((_scope: unknown, ...parameters: unknown[]) =>
        inner(...parameters),
      ),
    };
  },
);

const workerState = vi.hoisted(() => ({
  processor: undefined as (() => Promise<unknown>) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  onHandlers: {} as Record<string, (...args: unknown[]) => void>,
}));

const withGlobalRetentionCleanupDatabaseContextMock = vi.fn();
const runWebhookTombstoneRetentionJobMock = vi.fn();

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
  '@/domains/notify/sub-domains/webhook/workers/webhook-tombstone-retention.processor.js',
  () => ({
    runWebhookTombstoneRetentionJob: (...args: unknown[]) =>
      runWebhookTombstoneRetentionJobMock(...args),
  }),
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('webhook-tombstone-retention.worker', () => {
  beforeEach(() => {
    workerState.processor = undefined;
    workerState.options = undefined;
    workerState.onHandlers = {};
    withGlobalRetentionCleanupDatabaseContextMock.mockReset();
    runWebhookTombstoneRetentionJobMock.mockReset();

    withGlobalRetentionCleanupDatabaseContextMock.mockImplementation(
      async (callback: (databaseHandle: unknown) => Promise<unknown>) =>
        callback({ kind: 'global-retention' }),
    );
    runWebhookTombstoneRetentionJobMock.mockResolvedValue({ deletedCount: 6, blockedCount: 2 });
  });

  it('creates BullMQ Worker with the correct webhook-tombstone-retention queue name', async () => {
    const { createWebhookTombstoneRetentionWorker } = await import(
      '@/domains/notify/sub-domains/webhook/workers/webhook-tombstone-retention.worker.js'
    );

    const handle = createWebhookTombstoneRetentionWorker();

    expect(handle.queueName).toBe('webhook-tombstone-retention');
  });

  it('creates worker with RETENTION_WORKER_CONCURRENCY of 1', async () => {
    const { createWebhookTombstoneRetentionWorker } = await import(
      '@/domains/notify/sub-domains/webhook/workers/webhook-tombstone-retention.worker.js'
    );

    createWebhookTombstoneRetentionWorker();

    expect(workerState.options).toEqual(expect.objectContaining({ concurrency: 1 }));
  });

  it('processor calls withMaintenanceDatabaseContext and runs job inside it', async () => {
    const { createWebhookTombstoneRetentionWorker } = await import(
      '@/domains/notify/sub-domains/webhook/workers/webhook-tombstone-retention.worker.js'
    );

    createWebhookTombstoneRetentionWorker();
    const result = await workerState.processor?.();

    expect(withGlobalRetentionCleanupDatabaseContextMock).toHaveBeenCalledOnce();
    expect(runWebhookTombstoneRetentionJobMock).toHaveBeenCalledWith({ kind: 'global-retention' });
    expect(result).toEqual({ deletedCount: 6, blockedCount: 2 });
  });

  it('stalled handler logs a warning with queue name and jobId', async () => {
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const { createWebhookTombstoneRetentionWorker } = await import(
      '@/domains/notify/sub-domains/webhook/workers/webhook-tombstone-retention.worker.js'
    );

    createWebhookTombstoneRetentionWorker();
    workerState.onHandlers.stalled?.('job-webhook-001');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { jobId: 'job-webhook-001', queue: 'webhook-tombstone-retention' },
      'webhook-tombstone-retention.stalled',
    );
  });

  it('buildWorkerHandle is called with worker and queue name', async () => {
    const { createWebhookTombstoneRetentionWorker } = await import(
      '@/domains/notify/sub-domains/webhook/workers/webhook-tombstone-retention.worker.js'
    );

    const handle = createWebhookTombstoneRetentionWorker();

    expect(handle.worker).toBeDefined();
    expect(handle.queueName).toBe('webhook-tombstone-retention');
  });

  it('processor throws when database context throws — error propagates out', async () => {
    withGlobalRetentionCleanupDatabaseContextMock.mockRejectedValue(
      new Error('db-context-failure'),
    );

    const { createWebhookTombstoneRetentionWorker } = await import(
      '@/domains/notify/sub-domains/webhook/workers/webhook-tombstone-retention.worker.js'
    );

    createWebhookTombstoneRetentionWorker();

    await expect(workerState.processor?.()).rejects.toThrow('db-context-failure');
  });

  it('processor throws when job function throws — error propagates out', async () => {
    runWebhookTombstoneRetentionJobMock.mockRejectedValue(new Error('webhook-job-failure'));

    const { createWebhookTombstoneRetentionWorker } = await import(
      '@/domains/notify/sub-domains/webhook/workers/webhook-tombstone-retention.worker.js'
    );

    createWebhookTombstoneRetentionWorker();

    await expect(workerState.processor?.()).rejects.toThrow('webhook-job-failure');
  });
});
