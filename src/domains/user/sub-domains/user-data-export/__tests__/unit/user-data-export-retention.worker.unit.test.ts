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

/**
 * Worker-level suite for the `user-data-export-retention` scheduled cleanup.
 *
 * The invariant that matters here is the database context: expired export bundles are deleted
 * across every tenant, so the job must run inside `withMaintenanceDatabaseContext`
 * (which strips per-tenant RLS) and must receive that wrapper's handle — never a request-scoped one.
 */
const workerState = vi.hoisted(() => ({
  queueName: undefined as string | undefined,
  processor: undefined as (() => Promise<unknown>) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  onHandlers: {} as Record<string, (...args: unknown[]) => void>,
}));

const globalRetentionContextMock = vi.fn();
const runUserDataExportRetentionJobMock = vi.fn();

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(function WorkerMock(queueName, processor, options) {
    workerState.queueName = queueName;
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
  '@/domains/user/sub-domains/user-data-export/workers/user-data-export-retention.processor.js',
  () => ({
    runUserDataExportRetentionJob: (...args: unknown[]) =>
      runUserDataExportRetentionJobMock(...args),
  }),
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function importWorkerFactory() {
  const module = await import(
    '@/domains/user/sub-domains/user-data-export/workers/user-data-export-retention.worker.js'
  );
  return module.createUserDataExportRetentionWorker;
}

describe('user-data-export-retention.worker', () => {
  beforeEach(() => {
    workerState.queueName = undefined;
    workerState.processor = undefined;
    workerState.options = undefined;
    workerState.onHandlers = {};
    globalRetentionContextMock.mockReset();
    runUserDataExportRetentionJobMock.mockReset();

    globalRetentionContextMock.mockImplementation(
      async (callback: (databaseHandle: unknown) => Promise<unknown>) =>
        callback({ kind: 'global-retention' }),
    );
    runUserDataExportRetentionJobMock.mockResolvedValue({ deletedCount: 3, objectsDeleted: 3 });
  });

  it('creates the BullMQ Worker on the user-data-export-retention queue', async () => {
    const createUserDataExportRetentionWorker = await importWorkerFactory();

    const handle = createUserDataExportRetentionWorker();

    expect(workerState.queueName).toBe('user-data-export-retention');
    expect(handle.queueName).toBe('user-data-export-retention');
    expect(handle.worker).toBeDefined();
  });

  it('runs at RETENTION_WORKER_CONCURRENCY with the retention worker options', async () => {
    const createUserDataExportRetentionWorker = await importWorkerFactory();

    createUserDataExportRetentionWorker();

    expect(workerState.options).toEqual(
      expect.objectContaining({ concurrency: 1, lockDuration: 120_000, maxStalledCount: 1 }),
    );
  });

  it('runs the job inside the global retention context and returns its result', async () => {
    const createUserDataExportRetentionWorker = await importWorkerFactory();

    createUserDataExportRetentionWorker();
    const result = await workerState.processor?.();

    expect(globalRetentionContextMock).toHaveBeenCalledOnce();
    expect(runUserDataExportRetentionJobMock).toHaveBeenCalledWith({ kind: 'global-retention' });
    expect(result).toEqual({ deletedCount: 3, objectsDeleted: 3 });
  });

  it('logs a warning with queue name and jobId when a job stalls', async () => {
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const createUserDataExportRetentionWorker = await importWorkerFactory();

    createUserDataExportRetentionWorker();
    workerState.onHandlers.stalled?.('job-export-retention-001');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { jobId: 'job-export-retention-001', queue: 'user-data-export-retention' },
      'user-data-export-retention.stalled',
    );
  });

  it('propagates a database-context failure instead of reporting a clean sweep', async () => {
    globalRetentionContextMock.mockRejectedValue(new Error('retention-context-failure'));

    const createUserDataExportRetentionWorker = await importWorkerFactory();
    createUserDataExportRetentionWorker();

    await expect(workerState.processor?.()).rejects.toThrow('retention-context-failure');
  });

  it('propagates a job failure so BullMQ can retry or dead-letter it', async () => {
    runUserDataExportRetentionJobMock.mockRejectedValue(new Error('export-retention-failed'));

    const createUserDataExportRetentionWorker = await importWorkerFactory();
    createUserDataExportRetentionWorker();

    await expect(workerState.processor?.()).rejects.toThrow('export-retention-failed');
  });
});
