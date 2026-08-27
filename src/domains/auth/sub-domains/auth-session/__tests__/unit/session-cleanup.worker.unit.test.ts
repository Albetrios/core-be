import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const inner = ((callback: (databaseHandle: unknown) => unknown) =>
    sessionRetentionContextMock(callback)) as unknown as (...parameters: unknown[]) => unknown;
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
}));

const deleteInBatchesByConditionMock = vi.fn();
const sessionRetentionContextMock = vi.fn();

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(function WorkerMock(_queueName, processor, options) {
    workerState.processor = processor;
    workerState.options = options;
    return {
      on: vi.fn(),
      close: vi.fn(),
    };
  }),
}));

vi.mock('@/infrastructure/queue/connection.js', () => ({
  getBullMQConnectionOptions: () => ({ host: 'redis.test' }),
  getBullMQProducerConnectionOptions: () => ({ host: 'redis.test', enableOfflineQueue: false }),
}));

vi.mock('@/infrastructure/queue/worker-runtime/worker-close.util.js', () => ({
  buildWorkerHandle: (worker: unknown, queueName: string) => ({
    worker,
    queueName,
    close: async () => undefined,
  }),
}));

vi.mock('@/infrastructure/database/utils/batch-delete.util.js', () => ({
  deleteInBatchesByCondition: (...parameters: unknown[]) =>
    deleteInBatchesByConditionMock(...parameters),
}));

vi.mock('@/shared/config/env.config.js', () => ({
  env: { AUTH_SESSION_RETENTION_DAYS: 30, LOG_LEVEL: 'silent' },
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('session-cleanup.worker', () => {
  let createSessionCleanupWorker: typeof import('@/domains/auth/sub-domains/auth-session/workers/session-cleanup.worker.js').createSessionCleanupWorker;

  beforeAll(async () => {
    ({ createSessionCleanupWorker } = await import(
      '@/domains/auth/sub-domains/auth-session/workers/session-cleanup.worker.js'
    ));
  }, 60_000);

  beforeEach(() => {
    workerState.processor = undefined;
    workerState.options = undefined;
    deleteInBatchesByConditionMock.mockReset();
    sessionRetentionContextMock.mockReset();
    deleteInBatchesByConditionMock.mockResolvedValue({ deletedCount: 3, blockedCount: 1 });
    sessionRetentionContextMock.mockImplementation(
      async (callback: (databaseHandle: unknown) => Promise<unknown>) =>
        callback({ kind: 'session-retention' }),
    );
  });

  it('runs session cleanup inside the session retention database context', async () => {
    const handle = createSessionCleanupWorker();
    const result = await workerState.processor?.();

    expect(handle.queueName).toBe('session-cleanup');
    expect(workerState.options).toEqual(expect.objectContaining({ concurrency: 1 }));
    expect(sessionRetentionContextMock).toHaveBeenCalledOnce();
    expect(deleteInBatchesByConditionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseHandle: { kind: 'session-retention' },
        logContext: 'session-cleanup',
        tableLabel: 'auth.sessions',
      }),
    );
    expect(result).toEqual({ deletedCount: 3, blockedCount: 1 });
  });
});
