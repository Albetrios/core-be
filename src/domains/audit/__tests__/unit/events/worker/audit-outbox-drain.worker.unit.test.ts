import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const inner = ((callback: (databaseHandle: unknown) => unknown) =>
    withAuditOutboxDrainDatabaseContextMock(callback)) as unknown as (
    ...parameters: unknown[]
  ) => unknown;
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

const withAuditOutboxDrainDatabaseContextMock = vi.fn();
const runAuditOutboxDrainJobMock = vi.fn();

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
  getDefaultWorkerOptions: () => ({
    lockDuration: 30_000,
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

vi.mock('@/domains/audit/workers/audit-outbox-drain.processor.js', () => ({
  runAuditOutboxDrainJob: (...args: unknown[]) => runAuditOutboxDrainJobMock(...args),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const WORKER_MODULE = '@/domains/audit/workers/audit-outbox-drain.worker.js';

describe('audit-outbox-drain.worker', () => {
  beforeEach(() => {
    workerState.processor = undefined;
    workerState.options = undefined;
    workerState.onHandlers = {};
    withAuditOutboxDrainDatabaseContextMock.mockReset();
    runAuditOutboxDrainJobMock.mockReset();

    withAuditOutboxDrainDatabaseContextMock.mockImplementation(
      async (callback: (databaseHandle: unknown) => Promise<unknown>) =>
        callback({ kind: 'audit-outbox-drain' }),
    );
    runAuditOutboxDrainJobMock.mockResolvedValue({ drainedCount: 5, failedCount: 0 });
  });

  it('creates the BullMQ Worker on the audit-outbox-drain queue', async () => {
    const { createAuditOutboxDrainWorker } = await import(WORKER_MODULE);

    const handle = createAuditOutboxDrainWorker();

    expect(handle.queueName).toBe('audit-outbox-drain');
  });

  it('creates the worker with RETENTION_WORKER_CONCURRENCY of 1', async () => {
    const { createAuditOutboxDrainWorker } = await import(WORKER_MODULE);

    createAuditOutboxDrainWorker();

    expect(workerState.options).toEqual(expect.objectContaining({ concurrency: 1 }));
  });

  it('drains the outbox inside withMaintenanceDatabaseContext', async () => {
    const { createAuditOutboxDrainWorker } = await import(WORKER_MODULE);

    createAuditOutboxDrainWorker();
    const result = await workerState.processor?.();

    expect(withAuditOutboxDrainDatabaseContextMock).toHaveBeenCalledOnce();
    expect(runAuditOutboxDrainJobMock).toHaveBeenCalledWith({ kind: 'audit-outbox-drain' });
    expect(result).toEqual({ drainedCount: 5, failedCount: 0 });
  });

  it('logs a stalled warning with the queue name and jobId', async () => {
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const { createAuditOutboxDrainWorker } = await import(WORKER_MODULE);

    createAuditOutboxDrainWorker();
    workerState.onHandlers.stalled?.('job-audit-001');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { jobId: 'job-audit-001', queue: 'audit-outbox-drain' },
      'audit.outbox.drain.stalled',
    );
  });

  it('propagates errors thrown by the drain job', async () => {
    runAuditOutboxDrainJobMock.mockRejectedValue(new Error('audit-drain-failure'));
    const { createAuditOutboxDrainWorker } = await import(WORKER_MODULE);

    createAuditOutboxDrainWorker();

    await expect(workerState.processor?.()).rejects.toThrow('audit-drain-failure');
  });
});
