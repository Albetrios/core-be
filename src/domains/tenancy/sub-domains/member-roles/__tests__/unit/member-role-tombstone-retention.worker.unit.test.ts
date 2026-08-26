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
const runMemberRoleTombstoneRetentionJobMock = vi.fn();

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
  '@/domains/tenancy/sub-domains/member-roles/workers/member-role-tombstone-retention.processor.js',
  () => ({
    runMemberRoleTombstoneRetentionJob: (...args: unknown[]) =>
      runMemberRoleTombstoneRetentionJobMock(...args),
  }),
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('member-role-tombstone-retention.worker', () => {
  beforeEach(() => {
    workerState.processor = undefined;
    workerState.options = undefined;
    workerState.onHandlers = {};
    withGlobalRetentionCleanupDatabaseContextMock.mockReset();
    runMemberRoleTombstoneRetentionJobMock.mockReset();

    withGlobalRetentionCleanupDatabaseContextMock.mockImplementation(
      async (callback: (databaseHandle: unknown) => Promise<unknown>) =>
        callback({ kind: 'global-retention' }),
    );
    runMemberRoleTombstoneRetentionJobMock.mockResolvedValue({ deletedCount: 3, blockedCount: 1 });
  });

  it('creates BullMQ Worker with the correct member-role-tombstone-retention queue name', async () => {
    const { createMemberRoleTombstoneRetentionWorker } = await import(
      '@/domains/tenancy/sub-domains/member-roles/workers/member-role-tombstone-retention.worker.js'
    );

    const handle = createMemberRoleTombstoneRetentionWorker();

    expect(handle.queueName).toBe('member-role-tombstone-retention');
  });

  it('creates worker with RETENTION_WORKER_CONCURRENCY of 1', async () => {
    const { createMemberRoleTombstoneRetentionWorker } = await import(
      '@/domains/tenancy/sub-domains/member-roles/workers/member-role-tombstone-retention.worker.js'
    );

    createMemberRoleTombstoneRetentionWorker();

    expect(workerState.options).toEqual(expect.objectContaining({ concurrency: 1 }));
  });

  it('processor calls withMaintenanceDatabaseContext and runs job inside it', async () => {
    const { createMemberRoleTombstoneRetentionWorker } = await import(
      '@/domains/tenancy/sub-domains/member-roles/workers/member-role-tombstone-retention.worker.js'
    );

    createMemberRoleTombstoneRetentionWorker();
    const result = await workerState.processor?.();

    expect(withGlobalRetentionCleanupDatabaseContextMock).toHaveBeenCalledOnce();
    expect(runMemberRoleTombstoneRetentionJobMock).toHaveBeenCalledWith({
      kind: 'global-retention',
    });
    expect(result).toEqual({ deletedCount: 3, blockedCount: 1 });
  });

  it('stalled handler logs a warning with queue name and jobId', async () => {
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const { createMemberRoleTombstoneRetentionWorker } = await import(
      '@/domains/tenancy/sub-domains/member-roles/workers/member-role-tombstone-retention.worker.js'
    );

    createMemberRoleTombstoneRetentionWorker();
    workerState.onHandlers.stalled?.('job-xyz-456');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { jobId: 'job-xyz-456', queue: 'member-role-tombstone-retention' },
      'member-role-tombstone-retention.stalled',
    );
  });

  it('buildWorkerHandle is called with worker and queue name', async () => {
    const { createMemberRoleTombstoneRetentionWorker } = await import(
      '@/domains/tenancy/sub-domains/member-roles/workers/member-role-tombstone-retention.worker.js'
    );

    const handle = createMemberRoleTombstoneRetentionWorker();

    expect(handle.worker).toBeDefined();
    expect(handle.queueName).toBe('member-role-tombstone-retention');
  });

  it('processor throws when database context throws — error propagates out', async () => {
    withGlobalRetentionCleanupDatabaseContextMock.mockRejectedValue(
      new Error('db-context-failure'),
    );

    const { createMemberRoleTombstoneRetentionWorker } = await import(
      '@/domains/tenancy/sub-domains/member-roles/workers/member-role-tombstone-retention.worker.js'
    );

    createMemberRoleTombstoneRetentionWorker();

    await expect(workerState.processor?.()).rejects.toThrow('db-context-failure');
  });

  it('processor throws when job function throws — error propagates out', async () => {
    runMemberRoleTombstoneRetentionJobMock.mockRejectedValue(new Error('role-job-failure'));

    const { createMemberRoleTombstoneRetentionWorker } = await import(
      '@/domains/tenancy/sub-domains/member-roles/workers/member-role-tombstone-retention.worker.js'
    );

    createMemberRoleTombstoneRetentionWorker();

    await expect(workerState.processor?.()).rejects.toThrow('role-job-failure');
  });
});
