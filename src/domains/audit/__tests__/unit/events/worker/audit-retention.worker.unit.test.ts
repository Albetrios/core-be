import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
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
});

/**
 * BullMQ registration for the audit-retention worker — the sibling of
 * `audit-outbox-drain.worker.unit.test.ts`.
 *
 * This file previously held a single case that actually exercised `runAuditRetentionJob` (the
 * processor), leaving the worker's own wiring — queue name, concurrency, and above all the
 * database context the job runs inside — completely untested. That processor case now lives in
 * `audit-retention.processor.unit.test.ts` where it belongs; this file covers the registration.
 */
const workerState = vi.hoisted(() => ({
  queueName: undefined as string | undefined,
  processor: undefined as (() => Promise<unknown>) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  onHandlers: {} as Record<string, (...args: unknown[]) => void>,
}));

const withGlobalRetentionCleanupDatabaseContextMock = vi.fn();
const runAuditRetentionJobMock = vi.fn();

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
    lockDuration: 300_000,
    stalledInterval: 300_000,
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

vi.mock('@/domains/audit/workers/audit-retention.processor.js', () => ({
  runAuditRetentionJob: (...args: unknown[]) => runAuditRetentionJobMock(...args),
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const WORKER_MODULE = '@/domains/audit/workers/audit-retention.worker.js';

const RETENTION_RESULT = {
  deletedCount: 12,
  blockedCount: 0,
  deadLetterDeletedCount: 3,
  deadLetterBlockedCount: 0,
  verificationTokenDeletedCount: 5,
  verificationTokenBlockedCount: 0,
};

describe('audit-retention.worker', () => {
  beforeEach(() => {
    workerState.queueName = undefined;
    workerState.processor = undefined;
    workerState.options = undefined;
    workerState.onHandlers = {};
    withGlobalRetentionCleanupDatabaseContextMock.mockReset();
    runAuditRetentionJobMock.mockReset();

    withGlobalRetentionCleanupDatabaseContextMock.mockImplementation(
      async (callback: (databaseHandle: unknown) => Promise<unknown>) =>
        callback({ kind: 'global-retention-cleanup' }),
    );
    runAuditRetentionJobMock.mockResolvedValue(RETENTION_RESULT);
  });

  it('creates the BullMQ Worker on the audit-retention queue', async () => {
    const { createAuditRetentionWorker } = await import(WORKER_MODULE);

    const handle = createAuditRetentionWorker();

    expect(workerState.queueName).toBe('audit-retention');
    expect(handle.queueName).toBe('audit-retention');
  });

  /**
   * Retention is a global, cross-tenant purge. Two concurrent passes would race the same batches
   * and double the lock pressure on the hot ledger tables for no throughput gain, so concurrency
   * is pinned at 1 — and the retention (not default) worker options give the job a long enough
   * lock to finish a full sweep without being reclaimed as stalled.
   */
  it('runs at RETENTION_WORKER_CONCURRENCY of 1 with the retention worker options', async () => {
    const { createAuditRetentionWorker } = await import(WORKER_MODULE);

    createAuditRetentionWorker();

    expect(workerState.options).toEqual(
      expect.objectContaining({
        concurrency: 1,
        lockDuration: 300_000,
        stalledInterval: 300_000,
      }),
    );
  });

  /**
   * The load-bearing assertion in this file. `audit.logs` is FORCE RLS with an org-scoped
   * isolation policy; without `app.global_retention_cleanup = true` the purge would see only the
   * rows of whatever org context happened to be set — i.e. none — and every pass would silently
   * delete nothing while reporting success. The context wrapper is the only thing that makes a
   * global purge visible, and the handle it yields must be the one the job runs on.
   */
  it('runs the purge inside withMaintenanceDatabaseContext', async () => {
    const { createAuditRetentionWorker } = await import(WORKER_MODULE);

    createAuditRetentionWorker();
    const result = await workerState.processor?.();

    expect(withGlobalRetentionCleanupDatabaseContextMock).toHaveBeenCalledOnce();
    expect(runAuditRetentionJobMock).toHaveBeenCalledExactlyOnceWith({
      kind: 'global-retention-cleanup',
    });
    expect(result).toEqual(RETENTION_RESULT);
  });

  it('logs a stalled warning with the queue name and jobId', async () => {
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const { createAuditRetentionWorker } = await import(WORKER_MODULE);

    createAuditRetentionWorker();
    workerState.onHandlers.stalled?.('job-audit-retention-001');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { jobId: 'job-audit-retention-001', queue: 'audit-retention' },
      'audit-retention.stalled',
    );
  });

  /**
   * A swallowed error would mark the job complete, skip the DLQ hook, and let a compliance
   * window lapse unnoticed until the next scheduled pass.
   */
  it('propagates errors thrown by the retention job', async () => {
    runAuditRetentionJobMock.mockRejectedValue(new Error('audit-retention-failure'));
    const { createAuditRetentionWorker } = await import(WORKER_MODULE);

    createAuditRetentionWorker();

    await expect(workerState.processor?.()).rejects.toThrow('audit-retention-failure');
  });
});
