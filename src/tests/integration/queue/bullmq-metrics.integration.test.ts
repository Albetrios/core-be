import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import { resetEnvCacheForTests } from '@/shared/config/env.config.js';
import type * as BullMQMetricsModule from '@/infrastructure/observability/metrics/bullmq-metrics.js';
import type * as MetricsModule from '@/infrastructure/observability/metrics/metrics.js';

const runRedisTests = process.env.RUN_REDIS_TESTS === '1';

describe.runIf(runRedisTests)('Integration: BullMQ Prometheus metrics', () => {
  const originalMetricsEnabled = process.env.METRICS_ENABLED;
  const queueName = `test-bullmq-metrics-${Date.now()}`;

  let worker: Worker | null = null;
  let queue: Queue | null = null;
  let queueEvents: QueueEvents | null = null;
  let attachBullMQJobMetrics: typeof BullMQMetricsModule.attachBullMQJobMetrics;
  let closeBullMQMetricsQueues: typeof BullMQMetricsModule.closeBullMQMetricsQueues;
  let refreshMetricsBeforeScrape: typeof MetricsModule.refreshMetricsBeforeScrape;
  let renderMetrics: typeof MetricsModule.renderMetrics;

  beforeAll(async () => {
    process.env.METRICS_ENABLED = 'true';
    resetEnvCacheForTests();
    const bullmqMetrics = await import('@/infrastructure/observability/metrics/bullmq-metrics.js');
    const metrics = await import('@/infrastructure/observability/metrics/metrics.js');
    attachBullMQJobMetrics = bullmqMetrics.attachBullMQJobMetrics;
    closeBullMQMetricsQueues = bullmqMetrics.closeBullMQMetricsQueues;
    refreshMetricsBeforeScrape = metrics.refreshMetricsBeforeScrape;
    renderMetrics = metrics.renderMetrics;
  });

  afterAll(async () => {
    if (worker) await worker.close();
    if (queueEvents) await queueEvents.close();
    if (queue) {
      // `removeOnComplete` drops the job, not the queue's meta/id/events keys — obliterate them so
      // every run does not leave another uniquely named queue behind in Redis.
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await closeBullMQMetricsQueues();

    if (originalMetricsEnabled === undefined) {
      delete process.env.METRICS_ENABLED;
    } else {
      process.env.METRICS_ENABLED = originalMetricsEnabled;
    }
    resetEnvCacheForTests();
  });

  it('exports bullmq_job_duration_seconds and bullmq_queue_* gauges on scrape', async () => {
    const connection = getBullMQConnectionOptions();
    queue = new Queue(queueName, { connection });
    queueEvents = new QueueEvents(queueName, { connection });
    worker = new Worker(
      queueName,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      { connection },
    );
    attachBullMQJobMetrics(worker, queueName);
    await worker.waitUntilReady();
    await refreshMetricsBeforeScrape();

    const metricsRecorded = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('bullmq metrics completed handler timed out'));
      }, 10_000);
      worker?.on('completed', () => {
        setTimeout(() => {
          clearTimeout(timeout);
          resolve();
        }, 100);
      });
    });

    const job = await queue.add('metrics-smoke', { ping: 'pong' }, { removeOnComplete: true });
    await job.waitUntilFinished(queueEvents);
    await metricsRecorded;

    await refreshMetricsBeforeScrape();
    const metricsText = await renderMetrics();

    expect(metricsText).toContain('bullmq_job_duration_seconds');
    expect(metricsText).toContain(`queue="${queueName}"`);
    expect(metricsText).toContain('job_name="metrics-smoke"');
    expect(metricsText).toContain('bullmq_queue_waiting');
    expect(metricsText).toContain('bullmq_jobs_waiting');
    expect(metricsText).toContain('bullmq_queue_active');
    expect(metricsText).toContain('bullmq_queue_delayed');
    expect(metricsText).toContain('bullmq_queue_failed');
    expect(metricsText).toMatch(/queue="mail"/);
  }, 30_000);
});
