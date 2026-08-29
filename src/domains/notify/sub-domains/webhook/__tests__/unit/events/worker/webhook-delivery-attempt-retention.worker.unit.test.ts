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
const runWebhookDeliveryAttemptRetentionJobMock = vi.fn();

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
  '@/domains/notify/sub-domains/webhook/workers/webhook-delivery-attempt-retention.processor.js',
  () => ({
    runWebhookDeliveryAttemptRetentionJob: (...args: unknown[]) =>
      runWebhookDeliveryAttemptRetentionJobMock(...args),
  }),
);

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const WORKER_MODULE =
  '@/domains/notify/sub-domains/webhook/workers/webhook-delivery-attempt-retention.worker.js';

describe('webhook-delivery-attempt-retention.worker', () => {
  beforeEach(() => {
    workerState.processor = undefined;
    workerState.options = undefined;
    workerState.onHandlers = {};
    globalRetentionContextMock.mockReset();
    runWebhookDeliveryAttemptRetentionJobMock.mockReset();

    globalRetentionContextMock.mockImplementation(
      async (callback: (databaseHandle: unknown) => Promise<unknown>) =>
        callback({ kind: 'global-retention' }),
    );
    runWebhookDeliveryAttemptRetentionJobMock.mockResolvedValue({
      deletedCount: 7,
      blockedCount: 0,
    });
  });

  it('creates the BullMQ Worker on the webhook-delivery-attempt-retention queue', async () => {
    const { createWebhookDeliveryAttemptRetentionWorker } = await import(WORKER_MODULE);

    const handle = createWebhookDeliveryAttemptRetentionWorker();

    expect(handle.queueName).toBe('webhook-delivery-attempt-retention');
  });

  it('creates the worker with RETENTION_WORKER_CONCURRENCY of 1', async () => {
    const { createWebhookDeliveryAttemptRetentionWorker } = await import(WORKER_MODULE);

    createWebhookDeliveryAttemptRetentionWorker();

    expect(workerState.options).toEqual(expect.objectContaining({ concurrency: 1 }));
  });

  it('runs the retention job inside withMaintenanceDatabaseContext', async () => {
    const { createWebhookDeliveryAttemptRetentionWorker } = await import(WORKER_MODULE);

    createWebhookDeliveryAttemptRetentionWorker();
    const result = await workerState.processor?.();

    expect(globalRetentionContextMock).toHaveBeenCalledOnce();
    expect(runWebhookDeliveryAttemptRetentionJobMock).toHaveBeenCalledWith({
      kind: 'global-retention',
    });
    expect(result).toEqual({ deletedCount: 7, blockedCount: 0 });
  });

  it('logs a stalled warning with the queue name and jobId', async () => {
    const { logger } = await import('@/shared/utils/infrastructure/logger.util.js');
    const { createWebhookDeliveryAttemptRetentionWorker } = await import(WORKER_MODULE);

    createWebhookDeliveryAttemptRetentionWorker();
    workerState.onHandlers.stalled?.('job-webhook-001');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { jobId: 'job-webhook-001', queue: 'webhook-delivery-attempt-retention' },
      'webhook-delivery-attempt-retention.stalled',
    );
  });

  it('propagates errors thrown by the retention job', async () => {
    runWebhookDeliveryAttemptRetentionJobMock.mockRejectedValue(new Error('webhook-job-failure'));
    const { createWebhookDeliveryAttemptRetentionWorker } = await import(WORKER_MODULE);

    createWebhookDeliveryAttemptRetentionWorker();

    await expect(workerState.processor?.()).rejects.toThrow('webhook-job-failure');
  });
});
