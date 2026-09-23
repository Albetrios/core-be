import { Queue } from 'bullmq';
import type { Job, Worker } from 'bullmq';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import { isMetricsEnabled } from '@/infrastructure/observability/metrics/metrics-registry.js';
import {
  recordBullMQJobDuration,
  setBullMQQueueCounts,
} from '@/infrastructure/observability/metrics/prometheus-metrics.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/** Primary job queues scraped for depth gauges (excludes per-source DLQ queues). */
export const MONITORED_BULLMQ_QUEUE_NAMES = [
  'mail',
  'mail-outbox-sweeper',
  'webhook-delivery',
  'notification',
  'stripe-webhook',
  'stripe-webhook-event-reclaim',
  'audit-retention',
  'session-cleanup',
  'webhook-tombstone-retention',
  'organization-notification-policy-tombstone-retention',
  'user-tombstone-retention',
  'organization-tombstone-retention',
  'membership-tombstone-retention',
  'member-role-tombstone-retention',
  'organization-api-key-tombstone-retention',
  'upload-tombstone-retention',
  'idempotency-cardinality',
  'dlq-depth',
] as const;

const queueClientsByName = new Map<string, Queue>();

/**
 * A `Queue` client for `queueName`, created once and reused for the process lifetime.
 *
 * @remarks
 * Exported because the Redis-saturation sampler probes the same queues on its own tick and
 * was opening, script-loading and closing a fresh client per queue per pass. Sharing this
 * pool costs it nothing: every queue it watches is already in
 * {@link MONITORED_BULLMQ_QUEUE_NAMES}. Same reasoning as `getDeadLetterQueueClient`.
 * Released by {@link closeBullMQMetricsQueues} at shutdown.
 */
export function getOrCreateQueueClient(queueName: string): Queue {
  const existing = queueClientsByName.get(queueName);
  if (existing) return existing;
  const queue = new Queue(queueName, { connection: getBullMQConnectionOptions() });
  queueClientsByName.set(queueName, queue);
  return queue;
}

/**
 * Refreshes `bullmq_queue_{waiting,active,delayed,failed}` gauges for every
 * queue in {@link MONITORED_BULLMQ_QUEUE_NAMES}. No-op when metrics are
 * disabled; per-queue Redis errors are logged at warn and do not abort the pass.
 */
export async function refreshBullMQQueueGauges(): Promise<void> {
  if (!isMetricsEnabled()) {
    return;
  }

  await Promise.all(
    MONITORED_BULLMQ_QUEUE_NAMES.map(async (queueName) => {
      try {
        const queue = getOrCreateQueueClient(queueName);
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        setBullMQQueueCounts(queueName, {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
        });
      } catch (error) {
        logger.warn({ queueName, error }, 'metrics.bullmq.queue_counts.failed');
      }
    }),
  );
}

/**
 * Sums the `waiting` (ready-but-unprocessed) job count across the given queues, reusing the
 * pooled queue clients. Used by the worker readiness probe to tell an idle worker (no waiting
 * jobs — healthy) apart from a genuinely stalled one (jobs waiting but heartbeats stale).
 *
 * @remarks
 * Not gated by `isMetricsEnabled()` — readiness must work regardless of `METRICS_ENABLED`.
 * Only `waiting` is counted: `delayed` jobs (future-scheduled backoff retries) are not yet due,
 * and counting them would re-introduce the idle false-positive this lookup exists to avoid.
 */
export async function getQueuesWaitingJobCount(queueNames: readonly string[]): Promise<number> {
  const counts = await Promise.all(
    queueNames.map((queueName) => getOrCreateQueueClient(queueName).getWaitingCount()),
  );
  return counts.reduce((total, count) => total + count, 0);
}

/** Per-queue `waiting`/`delayed` job depth, surfaced on the verbose `/readyz` body. */
export type QueueDepth = { queue: string; waiting: number; delayed: number };

/**
 * Reads `waiting` and `delayed` job counts per queue, reusing the pooled queue clients.
 *
 * @remarks
 * Used by the `/readyz` operational body to report backlog directly (no Prometheus scrape needed).
 * Not gated by `isMetricsEnabled()` — readiness must work regardless of `METRICS_ENABLED`.
 */
export async function getQueueDepths(queueNames: readonly string[]): Promise<QueueDepth[]> {
  return Promise.all(
    queueNames.map(async (queueName) => {
      const counts = await getOrCreateQueueClient(queueName).getJobCounts('waiting', 'delayed');
      return { queue: queueName, waiting: counts.waiting ?? 0, delayed: counts.delayed ?? 0 };
    }),
  );
}

/**
 * Closes every pooled `Queue` client created by {@link refreshBullMQQueueGauges}
 * so the metrics scraper releases its Redis sockets cleanly on shutdown.
 */
export async function closeBullMQMetricsQueues(): Promise<void> {
  const queues = [...queueClientsByName.values()];
  queueClientsByName.clear();
  await Promise.allSettled(queues.map((queue) => queue.close()));
}

function resolveJobDurationSeconds(job: Job): number | null {
  const finishedAt = job.finishedOn;
  const processedAt = job.processedOn;
  if (finishedAt === undefined || processedAt === undefined) {
    return null;
  }
  return Math.max(0, (finishedAt - processedAt) / 1000);
}

/**
 * Records job duration histogram samples on worker `completed` events.
 */
export function attachBullMQJobMetrics(worker: Worker, queueName: string): void {
  if (!isMetricsEnabled()) {
    return;
  }

  worker.on('completed', async (job) => {
    if (!job) return;

    const durationSeconds = resolveJobDurationSeconds(job);
    if (durationSeconds === null) {
      return;
    }
    recordBullMQJobDuration(queueName, job.name, durationSeconds);
  });
}
