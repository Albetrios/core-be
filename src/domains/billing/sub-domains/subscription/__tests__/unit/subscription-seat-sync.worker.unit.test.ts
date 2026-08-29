import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Worker-wiring parity for the seat-sync worker: the queue and the processor each have a suite,
 * but nothing constructed the `Worker` itself. The wiring carries three guarantees no other test
 * covers — the tenant-scoped payload is validated (and poison payloads dead-lettered) *before*
 * the processor sees it, the Stripe concurrency tier is applied so seat pushes cannot fan out
 * past the Stripe worker budget, and the captured trace context is propagated into the job span.
 */
const workerState = vi.hoisted(() => ({
  queueName: undefined as string | undefined,
  processor: undefined as ((job: unknown) => Promise<unknown>) | undefined,
  options: undefined as Record<string, unknown> | undefined,
  listeners: new Map<string, (...arguments_: unknown[]) => void>(),
}));

const parseJobDataOrDeadLetterMock = vi.fn();
const processSubscriptionSeatSyncJobMock = vi.fn();
const runWithPropagatedTraceContextMock = vi.fn();
const loggerWarnMock = vi.fn();
const loggerInfoMock = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn(),
  UnrecoverableError: class UnrecoverableError extends Error {},
  Worker: vi.fn().mockImplementation(function WorkerMock(queueName, processor, options) {
    workerState.queueName = queueName;
    workerState.processor = processor;
    workerState.options = options;
    return {
      on: (event: string, listener: (...arguments_: unknown[]) => void) => {
        workerState.listeners.set(event, listener);
      },
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

vi.mock('@/infrastructure/queue/dlq/poison-job.util.js', () => ({
  parseJobDataOrDeadLetter: (...arguments_: unknown[]) =>
    parseJobDataOrDeadLetterMock(...arguments_),
}));

vi.mock('@/infrastructure/observability/tracing/trace-context.util.js', () => ({
  captureTraceContextForPropagation: () => ({}),
  runWithPropagatedTraceContext: (...arguments_: unknown[]) =>
    runWithPropagatedTraceContextMock(...arguments_),
}));

vi.mock(
  '@/domains/billing/sub-domains/subscription/workers/subscription-seat-sync.processor.js',
  () => ({
    processSubscriptionSeatSyncJob: (...arguments_: unknown[]) =>
      processSubscriptionSeatSyncJobMock(...arguments_),
  }),
);

vi.mock('@/shared/config/env.config.js', () => ({
  env: { WORKER_CONCURRENCY_STRIPE: 3, WORKER_CONCURRENCY: 5, LOG_LEVEL: 'silent' },
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: loggerInfoMock, warn: loggerWarnMock, error: vi.fn(), debug: vi.fn() },
}));

const subscriptionService = { syncSeatQuantity: vi.fn() };
const billingContainer = { subscriptionService };

function makeJob(overrides: Record<string, unknown> = {}) {
  return { id: 'job-1', name: 'sync-subscription-seats', data: {}, ...overrides };
}

describe('subscription-seat-sync.worker', () => {
  let createSubscriptionSeatSyncWorker: typeof import('@/domains/billing/sub-domains/subscription/workers/subscription-seat-sync.worker.js').createSubscriptionSeatSyncWorker;

  beforeAll(async () => {
    ({ createSubscriptionSeatSyncWorker } = await import(
      '@/domains/billing/sub-domains/subscription/workers/subscription-seat-sync.worker.js'
    ));
  }, 60_000);

  beforeEach(() => {
    workerState.queueName = undefined;
    workerState.processor = undefined;
    workerState.options = undefined;
    workerState.listeners.clear();
    parseJobDataOrDeadLetterMock.mockReset();
    processSubscriptionSeatSyncJobMock.mockReset();
    runWithPropagatedTraceContextMock.mockReset();
    loggerWarnMock.mockReset();
    loggerInfoMock.mockReset();
    parseJobDataOrDeadLetterMock.mockResolvedValue({
      organizationPublicId: 'org_a1b2c3d4e5f6g7h8i9j0k',
      requestId: 'req-seat-sync',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      tracestate: 'vendor=value',
    });
    processSubscriptionSeatSyncJobMock.mockResolvedValue(undefined);
    runWithPropagatedTraceContextMock.mockImplementation(
      async (_context: unknown, _name: string, callback: () => Promise<unknown>) => callback(),
    );
  });

  it('binds to the subscription-seat-sync queue at the Stripe concurrency tier', () => {
    const handle = createSubscriptionSeatSyncWorker(billingContainer as never);

    expect(workerState.queueName).toBe('subscription-seat-sync');
    expect(handle.queueName).toBe('subscription-seat-sync');
    // getWorkerConcurrencyStripe() → WORKER_CONCURRENCY_STRIPE, not the generic budget. Seat
    // pushes are Stripe API calls and share that provider's bulkhead.
    expect(workerState.options).toEqual(expect.objectContaining({ concurrency: 3 }));
  });

  it('uses the default runtime options and the shared BullMQ connection', () => {
    createSubscriptionSeatSyncWorker(billingContainer as never);

    expect(workerState.options).toEqual(
      expect.objectContaining({
        connection: { host: 'redis.test' },
        maxStalledCount: 1,
        lockDuration: expect.any(Number),
        stalledInterval: expect.any(Number),
      }),
    );
  });

  it('validates the job payload against the seat-sync schema before running the processor', async () => {
    createSubscriptionSeatSyncWorker(billingContainer as never);
    const job = makeJob({ data: { organizationPublicId: 'org_a1b2c3d4e5f6g7h8i9j0k' } });

    await workerState.processor?.(job);

    expect(parseJobDataOrDeadLetterMock).toHaveBeenCalledOnce();
    const [call] = parseJobDataOrDeadLetterMock.mock.calls as [
      [{ schema: unknown; job: unknown; queueName: string }],
    ];
    expect(call[0].job).toBe(job);
    expect(call[0].queueName).toBe('subscription-seat-sync');
    expect(call[0].schema).toBeDefined();
    // Ordering matters: an unvalidated organization id must never reach the processor, which uses it to
    // re-enter the organization RLS context.
    expect(parseJobDataOrDeadLetterMock.mock.invocationCallOrder[0] as number).toBeLessThan(
      processSubscriptionSeatSyncJobMock.mock.invocationCallOrder[0] as number,
    );
  });

  it('passes the VALIDATED payload and the injected subscription service to the processor', async () => {
    createSubscriptionSeatSyncWorker(billingContainer as never);

    await workerState.processor?.(makeJob({ data: { organizationPublicId: 'raw-untrusted' } }));

    expect(processSubscriptionSeatSyncJobMock).toHaveBeenCalledOnce();
    const [jobData, service] = processSubscriptionSeatSyncJobMock.mock.calls[0] as [
      { organizationPublicId: string },
      unknown,
    ];
    expect(jobData.organizationPublicId).toBe('org_a1b2c3d4e5f6g7h8i9j0k');
    expect(service).toBe(subscriptionService);
  });

  it('propagates the captured trace context into the job span', async () => {
    createSubscriptionSeatSyncWorker(billingContainer as never);

    await workerState.processor?.(makeJob());

    expect(runWithPropagatedTraceContextMock).toHaveBeenCalledOnce();
    const [traceContext, spanName] = runWithPropagatedTraceContextMock.mock.calls[0] as [
      { traceparent?: string; tracestate?: string },
      string,
    ];
    expect(traceContext).toEqual({
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      tracestate: 'vendor=value',
    });
    expect(spanName).toBe('sync-subscription-seats');
  });

  it('never runs the processor when the payload is rejected as poison', async () => {
    createSubscriptionSeatSyncWorker(billingContainer as never);
    parseJobDataOrDeadLetterMock.mockRejectedValue(new Error('poison job dead-lettered'));

    await expect(workerState.processor?.(makeJob({ data: { bogus: true } }))).rejects.toThrow(
      'poison job dead-lettered',
    );
    expect(processSubscriptionSeatSyncJobMock).not.toHaveBeenCalled();
  });

  it('propagates processor errors so BullMQ honours its retry/backoff', async () => {
    createSubscriptionSeatSyncWorker(billingContainer as never);
    processSubscriptionSeatSyncJobMock.mockRejectedValue(new Error('stripe unavailable'));

    await expect(workerState.processor?.(makeJob())).rejects.toThrow('stripe unavailable');
  });

  it('warn-logs stalled jobs with the queue name', () => {
    createSubscriptionSeatSyncWorker(billingContainer as never);

    workerState.listeners.get('stalled')?.('job-77');

    expect(loggerWarnMock).toHaveBeenCalledWith(
      { jobId: 'job-77', queueName: 'subscription-seat-sync' },
      'subscription.seat_sync.worker.stalled',
    );
  });
});
