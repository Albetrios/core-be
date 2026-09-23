import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { Queue, Worker, QueueEvents } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import { getDefaultWorkerOptions } from '@/infrastructure/queue/worker-runtime/worker-options.js';
import {
  attachDeadLetterAndAlerting,
  closeDeadLetterQueues,
  getDeadLetterQueueClient,
  getDeadLetterQueueName,
} from '@/infrastructure/queue/dlq/dead-letter.js';

const NOOP_QUEUE_NAME = 'test-noop-smoke';

describe('Integration: BullMQ noop job smoke', () => {
  let worker: Worker | null = null;
  let queue: Queue | null = null;
  let queueEvents: QueueEvents | null = null;

  afterAll(async () => {
    if (worker) await worker.close();
    if (queueEvents) await queueEvents.close();
    if (queue) await queue.close();
  });

  it('should enqueue and process a noop job end-to-end', async () => {
    const connection = getBullMQConnectionOptions();
    const queueName = `${NOOP_QUEUE_NAME}-${randomUUID()}`;
    let processedPayload: { ping: string } | null = null;

    queue = new Queue(queueName, { connection });
    queueEvents = new QueueEvents(queueName, { connection });
    worker = new Worker<{ ping: string }>(
      queueName,
      async (job) => {
        processedPayload = job.data;
      },
      { connection },
    );

    await Promise.all([
      queue.waitUntilReady(),
      queueEvents.waitUntilReady(),
      worker.waitUntilReady(),
    ]);

    const job = await queue.add('noop', { ping: 'pong' }, { removeOnComplete: true });
    await job.waitUntilFinished(queueEvents, 10_000);

    expect(processedPayload).toEqual({ ping: 'pong' });
  }, 30_000);
});

/**
 * The case above proves one job makes it through. These prove the queue runtime holds up under
 * the conditions that actually lose work: a burst larger than the worker's concurrency, a
 * transient failure that must be retried rather than dropped, and a permanent failure that must
 * land in the dead-letter queue rather than vanish.
 *
 * Each case runs the repo's REAL worker options (`getDefaultWorkerOptions`) and its REAL
 * dead-letter hook (`attachDeadLetterAndAlerting`), not BullMQ defaults — a burst that drains
 * under defaults but stalls under the production lock/stall settings would pass a weaker test.
 * Every queue is uniquely named, so cases never share state.
 */
describe('Integration: BullMQ runtime under burst, retry and dead-letter', () => {
  const opened: { close: () => Promise<unknown> }[] = [];

  afterEach(async () => {
    while (opened.length > 0) await opened.pop()?.close();
    await closeDeadLetterQueues();
  });

  async function openQueue<T>(processor: (data: T, attemptsMade: number) => Promise<void>) {
    const connection = getBullMQConnectionOptions();
    const queueName = `test-runtime-${randomUUID()}`;
    const queue = new Queue<T>(queueName, { connection });
    const queueEvents = new QueueEvents(queueName, { connection });
    const worker = new Worker<T>(queueName, (job) => processor(job.data, job.attemptsMade), {
      connection,
      concurrency: 10,
      ...getDefaultWorkerOptions(),
    });
    attachDeadLetterAndAlerting(worker, queueName);
    opened.push(worker, queueEvents, queue);
    await Promise.all([
      queue.waitUntilReady(),
      queueEvents.waitUntilReady(),
      worker.waitUntilReady(),
    ]);
    return { queue, queueEvents, queueName };
  }

  it('drains a burst thirty times larger than the worker concurrency, losing nothing', async () => {
    const JOB_COUNT = 300;
    const processed = new Set<number>();
    const { queue, queueEvents } = await openQueue<{ index: number }>(async ({ index }) => {
      processed.add(index);
    });

    const jobs = await queue.addBulk(
      Array.from({ length: JOB_COUNT }, (_, index) => ({ name: 'burst', data: { index } })),
    );
    await Promise.all(jobs.map((job) => job.waitUntilFinished(queueEvents, 30_000)));

    // Every job ran exactly once, and nothing is left behind in any state.
    expect(processed.size).toBe(JOB_COUNT);
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    expect(counts).toEqual({ waiting: 0, active: 0, delayed: 0, failed: 0 });
  }, 60_000);

  it('retries a transient failure to completion instead of dropping it', async () => {
    const { queue, queueEvents, queueName } = await openQueue<{ id: string }>(
      async (_data, attemptsMade) => {
        // First attempt fails the way a network blip or lock timeout would; the retry succeeds.
        if (attemptsMade === 0) throw new Error('transient: upstream timed out');
      },
    );

    const job = await queue.add(
      'flaky',
      { id: 'x' },
      { attempts: 3, backoff: { type: 'fixed', delay: 50 } },
    );
    await job.waitUntilFinished(queueEvents, 15_000);

    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(2);
    expect(await queue.getFailedCount()).toBe(0);
    // A job that recovered must NOT be dead-lettered — only final failures are.
    const deadLetters = getDeadLetterQueueClient(getDeadLetterQueueName(queueName));
    expect(await deadLetters.getJobCountByTypes('waiting', 'completed', 'failed', 'delayed')).toBe(
      0,
    );
  }, 30_000);

  it('dead-letters a permanent failure after its last attempt instead of losing it', async () => {
    const { queue, queueName } = await openQueue<{ id: string }>(async () => {
      throw new Error('permanent: payload can never be processed');
    });

    await queue.add('doomed', { id: 'y' }, { attempts: 2, backoff: { type: 'fixed', delay: 50 } });

    // The dead-letter write is fire-and-forget from the `failed` handler, so poll for it.
    const deadLetters = getDeadLetterQueueClient(getDeadLetterQueueName(queueName));
    const deadline = Date.now() + 15_000;
    let deadLettered = 0;
    while (Date.now() < deadline) {
      deadLettered = await deadLetters.getJobCountByTypes(
        'waiting',
        'completed',
        'failed',
        'delayed',
      );
      if (deadLettered > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Exactly one dead letter: the job is recoverable from the DLQ, not silently gone, and a
    // non-final attempt did not dead-letter it early.
    expect(deadLettered).toBe(1);
    expect(await queue.getFailedCount()).toBe(1);
  }, 30_000);
});
