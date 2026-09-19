import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Worker } from 'bullmq';

const queueAddMock = vi.fn().mockResolvedValue(undefined);
const queueCloseMock = vi.fn().mockResolvedValue(undefined);
const queueConstructorArgsMock: { name: string; options: unknown }[] = [];
const sentryCaptureExceptionMock = vi.fn();
const insertDeadLetterJobMock = vi.fn().mockResolvedValue(undefined);

vi.mock('bullmq', () => ({
  // P0-#6 regression: capture every Queue() constructor call so we can lock in the
  // retention bounds applied to `*-dlq` queues. A regression here (removing the age
  // bound, or making it absurdly large) silently turns the DLQ into an unbounded
  // Redis sink — exactly the failure mode the recon flagged.
  Queue: class MockQueue {
    constructor(name: string, options: unknown) {
      queueConstructorArgsMock.push({ name, options });
    }

    add = queueAddMock;

    close = queueCloseMock;
  },
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

vi.mock('@/infrastructure/queue/dlq/dead-letter.repository.js', () => ({
  insertDeadLetterJob: (...arguments_: unknown[]) => insertDeadLetterJobMock(...arguments_),
}));

vi.mock('@/infrastructure/observability/sentry/sentry.js', () => ({
  isSentryInitialized: () => true,
  Sentry: {
    withScope: (callback: (scope: unknown) => void) => {
      callback({
        setLevel: vi.fn(),
        setFingerprint: vi.fn(),
        setTag: vi.fn(),
      });
    },
    captureException: (...arguments_: unknown[]) => sentryCaptureExceptionMock(...arguments_),
  },
}));

describe('dead-letter helpers', () => {
  afterEach(async () => {
    queueAddMock.mockClear();
    queueCloseMock.mockClear();
    queueConstructorArgsMock.length = 0;
    sentryCaptureExceptionMock.mockClear();
    insertDeadLetterJobMock.mockClear();
    insertDeadLetterJobMock.mockResolvedValue(undefined);
    const { closeDeadLetterQueues } = await import('@/infrastructure/queue/dlq/dead-letter.js');
    await closeDeadLetterQueues();
    vi.resetModules();
  });

  describe('isFinalJobFailure', () => {
    it('returns false when job is undefined', async () => {
      const { isFinalJobFailure } = await import('@/infrastructure/queue/dlq/dead-letter.js');
      expect(isFinalJobFailure(undefined)).toBe(false);
    });

    it('returns false when attempts remain', async () => {
      const { isFinalJobFailure } = await import('@/infrastructure/queue/dlq/dead-letter.js');
      const job = {
        attemptsMade: 1,
        opts: { attempts: 3 },
      } as Job;
      expect(isFinalJobFailure(job)).toBe(false);
    });

    it('returns true when attempts are exhausted', async () => {
      const { isFinalJobFailure } = await import('@/infrastructure/queue/dlq/dead-letter.js');
      const job = {
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as Job;
      expect(isFinalJobFailure(job)).toBe(true);
    });

    it('treats missing opts.attempts as 1', async () => {
      const { isFinalJobFailure } = await import('@/infrastructure/queue/dlq/dead-letter.js');
      const job = {
        attemptsMade: 1,
        opts: {},
      } as Job;
      expect(isFinalJobFailure(job)).toBe(true);
    });

    // BullMQ stores `attempts: 0` on jobs added without the option (cron/repeatable jobs from the
    // scheduler included) — that is its "no retries" encoding, i.e. exactly one attempt.
    it('treats opts.attempts 0 (BullMQ default) as a single attempt', async () => {
      const { isFinalJobFailure, resolveJobMaxAttempts } = await import(
        '@/infrastructure/queue/dlq/dead-letter.js'
      );
      const job = { attemptsMade: 1, opts: { attempts: 0 } } as Job;
      expect(resolveJobMaxAttempts(job)).toBe(1);
      expect(isFinalJobFailure(job)).toBe(true);
    });
  });

  describe('getDeadLetterQueueName', () => {
    it('appends -dlq suffix', async () => {
      const { getDeadLetterQueueName } = await import('@/infrastructure/queue/dlq/dead-letter.js');
      expect(getDeadLetterQueueName('mail')).toBe('mail-dlq');
    });
  });

  // P0-#6 regression: the DLQ queue itself must have bounded retention. Without
  // queue-level `defaultJobOptions`, a DLQ job that never transitions out of
  // `waiting` would sit in Redis forever — silently turning the dead-letter sink
  // into an unbounded memory leak. The per-add removal options only fire on the
  // complete/failed state transition, so they alone are not enough.
  describe('DLQ retention bounds (P0-#6)', () => {
    it('enqueueDeadLetter opens a *-dlq queue with bounded age + count defaults', async () => {
      const { enqueueDeadLetter } = await import('@/infrastructure/queue/dlq/dead-letter.js');
      const { THIRTY_DAYS_SECONDS } = await import('@/shared/constants/ttl.constants.js');

      const job = {
        id: 'job-retention',
        name: 'dispatch-test',
        data: {},
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as Job;

      await enqueueDeadLetter('mail', job, new Error('boom'));

      const dlqConstructorCall = queueConstructorArgsMock.find((call) => call.name === 'mail-dlq');
      expect(dlqConstructorCall).toBeDefined();
      const options = dlqConstructorCall!.options as {
        defaultJobOptions?: {
          removeOnComplete?: { age?: number; count?: number };
          removeOnFail?: { age?: number; count?: number };
        };
      };

      // Both arms (complete + fail) bounded by age AND count so a sustained burst
      // cannot exhaust Redis even within the age window.
      expect(options.defaultJobOptions?.removeOnComplete?.age).toBe(THIRTY_DAYS_SECONDS);
      expect(options.defaultJobOptions?.removeOnComplete?.count).toBeGreaterThan(0);
      expect(options.defaultJobOptions?.removeOnComplete?.count).toBeLessThanOrEqual(10_000);
      expect(options.defaultJobOptions?.removeOnFail?.age).toBe(THIRTY_DAYS_SECONDS);
      expect(options.defaultJobOptions?.removeOnFail?.count).toBeGreaterThan(0);
      expect(options.defaultJobOptions?.removeOnFail?.count).toBeLessThanOrEqual(10_000);
    });

    it('audit-#W2: redacts URL/query-embedded secrets in failed_reason/error_stack before the Redis mirror', async () => {
      const { enqueueDeadLetter } = await import('@/infrastructure/queue/dlq/dead-letter.js');

      const secretUrl = 'https://api.example.com/hook?api_key=live_sk_supersecret&id=42';
      const error = new Error(`outbound POST failed for ${secretUrl}`);
      error.stack = `Error: outbound POST failed for ${secretUrl}\n    at foo (bar.ts:1:1)`;
      const job = {
        id: 'job-secret',
        name: 'dispatch-test',
        data: {},
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as Job;

      await enqueueDeadLetter('webhook-delivery', job, error);

      const addCall = queueAddMock.mock.calls.at(-1)!;
      const data = addCall[1] as { failed_reason: string; error_stack: string };
      expect(data.failed_reason).toContain('api_key=[REDACTED]');
      expect(data.failed_reason).not.toContain('live_sk_supersecret');
      expect(data.error_stack).toContain('api_key=[REDACTED]');
      expect(data.error_stack).not.toContain('live_sk_supersecret');
    });

    it('audit-retention queue is in the canonical scheduler list so the Postgres DLQ ledger is bounded', async () => {
      const { getScheduledJobs } = await import('@/infrastructure/queue/scheduler.js');
      const { AUDIT_RETENTION_QUEUE_NAME } = await import(
        '@/domains/audit/workers/audit-retention.constants.js'
      );

      const scheduled = getScheduledJobs().map((job) => job.queueName);
      expect(scheduled).toContain(AUDIT_RETENTION_QUEUE_NAME);
    });
  });

  describe('attachDeadLetterAndAlerting', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('does not enqueue or alert on transient failure', async () => {
      const { attachDeadLetterAndAlerting } = await import(
        '@/infrastructure/queue/dlq/dead-letter.js'
      );
      const fakeWorker = new EventEmitter() as unknown as Worker;
      attachDeadLetterAndAlerting(fakeWorker, 'notification');

      const job = {
        id: 'job-1',
        name: 'dispatch-notification',
        data: { notificationId: 1 },
        attemptsMade: 1,
        opts: { attempts: 3 },
      } as Job;

      fakeWorker.emit('failed', job, new Error('transient'), 'active');

      await Promise.resolve();
      await Promise.resolve();

      expect(queueAddMock).not.toHaveBeenCalled();
      expect(insertDeadLetterJobMock).not.toHaveBeenCalled();
      expect(sentryCaptureExceptionMock).not.toHaveBeenCalled();
    });

    it('persists to Postgres, enqueues dead letter, and captures Sentry on final failure', async () => {
      const { attachDeadLetterAndAlerting } = await import(
        '@/infrastructure/queue/dlq/dead-letter.js'
      );
      const fakeWorker = new EventEmitter() as unknown as Worker;
      attachDeadLetterAndAlerting(fakeWorker, 'notification');

      const finalError = new Error('permanent');
      const job = {
        id: 'job-2',
        name: 'dispatch-notification',
        data: { notificationId: 2 },
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as Job;

      fakeWorker.emit('failed', job, finalError, 'active');

      await vi.waitFor(() => {
        expect(insertDeadLetterJobMock).toHaveBeenCalledTimes(1);
        expect(queueAddMock).toHaveBeenCalledTimes(1);
      });

      expect(insertDeadLetterJobMock).toHaveBeenCalledWith(
        expect.objectContaining({
          source_queue: 'notification',
          dead_letter_queue: 'notification-dlq',
          job_id: 'job-2',
          job_name: 'dispatch-notification',
          failed_reason: 'permanent',
          attempts_made: 3,
          max_attempts: 3,
          payload_summary: { notification_id: 2 },
        }),
      );
      expect(sentryCaptureExceptionMock).toHaveBeenCalledWith(finalError);
    });

    it('still mirrors to Redis after a Postgres persist failure is captured to Sentry', async () => {
      const persistError = new Error('postgres-down');
      insertDeadLetterJobMock.mockRejectedValueOnce(persistError);

      const { attachDeadLetterAndAlerting } = await import(
        '@/infrastructure/queue/dlq/dead-letter.js'
      );
      const fakeWorker = new EventEmitter() as unknown as Worker;
      attachDeadLetterAndAlerting(fakeWorker, 'notification');

      const finalError = new Error('permanent');
      const job = {
        id: 'job-3',
        name: 'dispatch-notification',
        data: { notificationId: 3 },
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as Job;

      fakeWorker.emit('failed', job, finalError, 'active');

      await vi.waitFor(() => {
        expect(queueAddMock).toHaveBeenCalledTimes(1);
      });

      // One Sentry capture for the persist failure, one for the final-failure alert.
      expect(sentryCaptureExceptionMock).toHaveBeenCalledWith(persistError);
      expect(sentryCaptureExceptionMock).toHaveBeenCalledWith(finalError);
    });
  });

  // Regression: `audit.dead_letter_jobs` has CHECK (max_attempts >= 1). A cron job's terminal
  // failure used to be persisted with max_attempts = 0 (BullMQ's default), the insert violated the
  // constraint, and the durable ledger silently missed every scheduled-job dead-letter.
  describe('recordDeadLetterFailure ledger row', () => {
    it('never writes max_attempts below 1 for a job with attempts 0', async () => {
      const { recordDeadLetterFailure } = await import('@/infrastructure/queue/dlq/dead-letter.js');
      const job = {
        id: 'repeat:stripe-webhook-event-catchup:1',
        name: 'catchup-missing-stripe-webhook-events',
        data: {},
        attemptsMade: 1,
        opts: { attempts: 0 },
      } as unknown as Job;

      await recordDeadLetterFailure('stripe-webhook-event-catchup', job, new Error('boom'));

      expect(insertDeadLetterJobMock).toHaveBeenCalledTimes(1);
      const row = insertDeadLetterJobMock.mock.calls[0]?.[0] as {
        max_attempts: number;
        attempts_made: number;
      };
      expect(row.max_attempts).toBe(1);
      expect(row.attempts_made).toBe(1);
    });
  });
});
