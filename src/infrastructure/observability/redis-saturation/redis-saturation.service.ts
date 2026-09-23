import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { getOrCreateQueueClient } from '@/infrastructure/observability/metrics/bullmq-metrics.js';
import { captureMessage } from '@/infrastructure/observability/sentry/sentry.js';
import { MAIL_QUEUE_NAME } from '@/infrastructure/mail/queues/mail.queue.js';
import { WEBHOOK_DELIVERY_QUEUE_NAME } from '@/domains/notify/sub-domains/webhook/webhook-delivery/queues/webhook-delivery.queue.js';
import { NOTIFICATION_QUEUE_NAME } from '@/domains/notify/sub-domains/notification/queues/notification.queue.js';
import { STRIPE_WEBHOOK_QUEUE_NAME } from '@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js';
import { env } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * Throughput / event-driven BullMQ queues whose backlog grows fastest during a worker
 * outage. A runaway `waiting + delayed` depth on a shared Redis can fill memory and, under
 * `maxmemory-policy=noeviction`, start rejecting the write-critical cache / idempotency /
 * rate-limit commands — turning a worker problem into an API write outage.
 */
const SOURCE_QUEUE_NAMES_FOR_WAITING_DEPTH_MONITORING = [
  MAIL_QUEUE_NAME,
  WEBHOOK_DELIVERY_QUEUE_NAME,
  NOTIFICATION_QUEUE_NAME,
  STRIPE_WEBHOOK_QUEUE_NAME,
] as const;

/**
 * Parsed subset of Redis `INFO memory` — `usedMemory` and the configured `maxMemory`
 * (`0` means unbounded, i.e. no eviction/rejection ceiling).
 *
 * @remarks
 * - **Algorithm:** scans the INFO text for `used_memory:` and `maxmemory:` lines.
 * - **Failure modes:** missing fields default to `0`, surfaced as `ratio = null` upstream.
 * - **Side effects:** none — pure string parsing.
 * - **Notes:** consumed by {@link sampleRedisMemorySaturation}.
 */
export interface ParsedRedisMemoryInfo {
  usedMemory: number;
  maxMemory: number;
}

/**
 * Parses the `used_memory` and `maxmemory` byte counts out of a Redis `INFO memory` payload.
 *
 * @remarks
 * - **Algorithm:** matches `^used_memory:` and `^maxmemory:` lines and coerces the integer
 *   value; absent or non-numeric fields fall back to `0`.
 * - **Failure modes:** never throws — malformed input yields `{ usedMemory: 0, maxMemory: 0 }`.
 * - **Side effects:** none.
 * - **Notes:** `maxmemory:0` denotes an unbounded instance (no saturation ceiling).
 */
export function parseRedisMemoryInfo(info: string): ParsedRedisMemoryInfo {
  const readField = (field: string): number => {
    const match = new RegExp(`^${field}:(\\d+)`, 'm').exec(info);
    if (!match?.[1]) return 0;
    const value = Number.parseInt(match[1], 10);
    return Number.isFinite(value) ? value : 0;
  };
  return { usedMemory: readField('used_memory'), maxMemory: readField('maxmemory') };
}

/**
 * Result of {@link sampleRedisMemorySaturation} — observed memory ratio, or `null` when the
 * instance is unbounded (`maxmemory=0`) or the probe failed.
 *
 * @remarks
 * - **Algorithm:** `ratio = usedMemory / maxMemory` when `maxMemory > 0`.
 * - **Failure modes:** `ratio = null` when unbounded or the INFO probe errored.
 * - **Side effects:** none from the type itself.
 * - **Notes:** consumed by the observability worker for structured logging.
 */
export interface RedisMemorySaturationSampleResult {
  usedMemory: number;
  maxMemory: number;
  ratio: number | null;
}

/**
 * Samples the cache Redis `used_memory / maxmemory` ratio and raises a Sentry alert when it
 * crosses the warn / critical thresholds.
 *
 * @remarks
 * - **Algorithm:** runs `INFO memory`, parses {@link parseRedisMemoryInfo}, computes the
 *   ratio when `maxmemory > 0`, then compares against `REDIS_MEMORY_CRITICAL_RATIO` /
 *   `REDIS_MEMORY_WARN_RATIO`.
 * - **Failure modes:** an INFO error is logged at warn and returns a `ratio: null` result
 *   (never throws, so the observability tick continues to its other samplers).
 * - **Side effects:** Redis `INFO memory`; Sentry `captureMessage('redis.memory.saturation.*')`
 *   plus a structured log when over threshold.
 * - **Notes:** unbounded instances (`maxmemory=0`) skip alerting — there is no rejection
 *   ceiling, but the absolute `usedMemory` is still logged.
 */
export async function sampleRedisMemorySaturation(): Promise<RedisMemorySaturationSampleResult> {
  let parsed: ParsedRedisMemoryInfo;
  try {
    const info = await redisConnection.info('memory');
    parsed = parseRedisMemoryInfo(info);
  } catch (error) {
    logger.warn({ error }, 'redis.memory.saturation.probe.failed');
    return { usedMemory: 0, maxMemory: 0, ratio: null };
  }

  const { usedMemory, maxMemory } = parsed;
  if (maxMemory <= 0) {
    logger.debug({ usedMemory }, 'redis.memory.saturation.unbounded');
    return { usedMemory, maxMemory, ratio: null };
  }

  const ratio = usedMemory / maxMemory;
  const warnRatio = env.REDIS_MEMORY_WARN_RATIO;
  const criticalRatio = env.REDIS_MEMORY_CRITICAL_RATIO;

  if (ratio >= criticalRatio) {
    logger.error(
      { usedMemory, maxMemory, ratio, warnRatio, criticalRatio },
      'redis.memory.saturation.critical',
    );
    captureMessage('redis.memory.saturation.critical', {
      level: 'error',
      extra: { usedMemory, maxMemory, ratio, warnRatio, criticalRatio },
    });
  } else if (ratio >= warnRatio) {
    logger.warn(
      { usedMemory, maxMemory, ratio, warnRatio, criticalRatio },
      'redis.memory.saturation.high',
    );
    captureMessage('redis.memory.saturation.high', {
      level: 'warning',
      extra: { usedMemory, maxMemory, ratio, warnRatio, criticalRatio },
    });
  }

  return { usedMemory, maxMemory, ratio };
}

/**
 * One-pass BullMQ source-queue backlog snapshot returned by
 * {@link sampleBullMqSourceQueueWaitingDepth} — `waiting + delayed` per monitored queue.
 *
 * @remarks
 * - **Algorithm:** the `depths` array preserves the order of
 *   `SOURCE_QUEUE_NAMES_FOR_WAITING_DEPTH_MONITORING`.
 * - **Failure modes:** a per-queue probe error is logged and recorded as depth `0`, so one
 *   unreachable queue does not abort the others.
 * - **Side effects:** none from the type itself.
 * - **Notes:** consumed by the observability worker for structured logging.
 */
export interface QueueWaitingDepthSampleResult {
  readonly depths: ReadonlyArray<{
    readonly queueName: string;
    readonly waiting: number;
    readonly delayed: number;
    readonly total: number;
  }>;
}

/**
 * Samples `waiting + delayed` depth on each throughput source queue and raises a Sentry
 * warning whenever a single queue crosses `QUEUE_WAITING_DEPTH_WARN_THRESHOLD`.
 *
 * @remarks
 * - **Algorithm:** opens a short-lived `Queue` per monitored name, reads
 *   `getJobCounts('waiting','delayed')`, and aggregates totals.
 * - **Failure modes:** a per-queue error is logged at warn and counted as `0`; the queue
 *   client is always closed in `finally`. The function never throws.
 * - **Side effects:** transient BullMQ `Queue` open/close; Sentry
 *   `captureMessage('queue.waiting.depth.high', ...)` and a structured log over threshold.
 * - **Notes:** runs from the observability worker tick alongside DLQ depth sampling.
 */
export async function sampleBullMqSourceQueueWaitingDepth(): Promise<QueueWaitingDepthSampleResult> {
  const warnThreshold = env.QUEUE_WAITING_DEPTH_WARN_THRESHOLD;
  const depths: QueueWaitingDepthSampleResult['depths'][number][] = [];

  // Probed together on pooled clients rather than one at a time on throwaway ones. Every queue
  // here is already in `MONITORED_BULLMQ_QUEUE_NAMES`, so sharing that pool adds no Redis
  // connection — it removes a connect + script-load + close per queue per pass, which is the
  // same cost `getDeadLetterQueueClient` pools to avoid (sec-DLQ-scrape). Each probe keeps its
  // own try/catch, so one failing queue still reports 0 without aborting the others.
  const sampled = await Promise.all(
    SOURCE_QUEUE_NAMES_FOR_WAITING_DEPTH_MONITORING.map(async (queueName) => {
      try {
        const counts = await getOrCreateQueueClient(queueName).getJobCounts('waiting', 'delayed');
        const waiting = counts.waiting ?? 0;
        const delayed = counts.delayed ?? 0;
        return { queueName, waiting, delayed, total: waiting + delayed };
      } catch (error) {
        logger.warn({ error, queueName }, 'queue.waiting.depth.probe.failed');
        return { queueName, waiting: 0, delayed: 0, total: 0 };
      }
    }),
  );

  // Alerting stays sequential and in list order so the logs and Sentry breadcrumbs read the same
  // way they did when the probes themselves were sequential.
  for (const depth of sampled) {
    depths.push(depth);
    if (depth.total >= warnThreshold) {
      logger.warn({ ...depth, warnThreshold }, 'queue.waiting.depth.high');
      captureMessage('queue.waiting.depth.high', {
        level: 'warning',
        extra: { ...depth, warnThreshold },
      });
    }
  }

  return { depths };
}
