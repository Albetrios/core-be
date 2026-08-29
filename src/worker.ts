import '@/shared/config/load-env-files.js';
import {
  initSentry,
  captureException,
  flushSentry,
} from '@/infrastructure/observability/sentry/sentry.js';
import {
  initOpenTelemetry,
  shutdownOpenTelemetry,
} from '@/infrastructure/observability/tracing/otel.js';
import { initPostHog, shutdownPostHog } from '@/infrastructure/observability/posthog/posthog.js';
import { OTEL_SERVICE_NAME_WORKER } from '@/shared/constants/project-identity.constants.js';
import { createUnhandledRejectionHandler } from '@/infrastructure/observability/unhandled-rejection.handler.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { closeRedis, connectRedis } from '@/infrastructure/cache/redis.client.js';
import {
  closeBullMqRedis,
  connectBullMqRedis,
} from '@/infrastructure/cache/bullmq-redis.client.js';
import { warnWhenBullMqSharesCacheRedisHost } from '@/infrastructure/cache/redis-topology-warn.util.js';
import { closeDatabase } from '@/infrastructure/database/connection.js';
import { assertPostgresConnectionBudget } from '@/infrastructure/database/safety/assert-connection-budget.js';
import {
  assertDatabaseRoleRlsSafety,
  assertMaintenanceDatabaseRoleRlsSafety,
} from '@/infrastructure/database/safety/assert-database-rls-safety.js';
import { assertDatabaseTlsVerification } from '@/infrastructure/database/safety/assert-database-tls-safety.js';
import { assertRedisTlsVerification } from '@/infrastructure/cache/assert-redis-tls-safety.js';
import { computeWorkerPostgresPoolDemand } from '@/infrastructure/queue/worker-runtime/worker-connection-budget.js';
import { setWorkerPostgresPoolDemandContext } from '@/infrastructure/queue/worker-runtime/worker-pool-demand-context.js';
import { registerPostgresPoolMetrics } from '@/infrastructure/observability/metrics/db-pool-metrics.js';
import {
  registerDomainWorkers,
  stopRssMonitoring,
  closeDeadLetterQueues,
} from '@/infrastructure/queue/bootstrap.js';
import { closeWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import {
  markWorkerHealthNotReady,
  markWorkerHealthReady,
  startWorkerHealthServer,
  stopWorkerHealthServer,
} from '@/infrastructure/queue/worker-runtime/worker-health.server.js';
import { getShutdownWatchdogMs } from '@/infrastructure/queue/worker-runtime/shutdown-timing.util.js';
import { closeStripeWebhookQueue } from '@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js';
import { closeSubscriptionSeatSyncQueue } from '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.queue.js';
import { closeMailQueue } from '@/infrastructure/mail/queues/mail.queue.js';
import { closeNotificationQueue } from '@/domains/notify/sub-domains/notification/queues/notification.queue.js';
import { closeWebhookDeliveryQueue } from '@/domains/notify/sub-domains/webhook/webhook-delivery/queues/webhook-delivery.queue.js';
import { closeUserDataExportQueue } from '@/domains/user/sub-domains/user-data-export/queues/user-data-export.queue.js';

// Initialize Sentry before anything else
initSentry();
// audit M5: start OpenTelemetry for the worker process (no-op unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set).
initOpenTelemetry(OTEL_SERVICE_NAME_WORKER);
// Product analytics (no-op unless POSTHOG_KEY is set).
initPostHog();

process.on('uncaughtException', (error) => {
  captureException(error, { tags: { source: 'worker_uncaughtException' } });
  logger.fatal({ error }, 'uncaughtException');
  void flushSentry().finally(() => process.exit(1));
});

/**
 * Unhandled-rejection policy: a single un-awaited promise rejection (often from a
 * dependency) should NOT tear down the worker and abandon in-flight jobs, so we
 * meter (`process_unhandled_rejections_total`) + capture + log at error level instead
 * of exiting. We only escalate to a fatal exit if rejections arrive in a sustained
 * burst within a rolling window — a likely systemic failure — letting the supervisor
 * restart a genuinely broken process while tolerating isolated strays. The metric
 * exposes the sub-threshold rate so a persistent failing job path can page before it
 * hides indefinitely. (`uncaughtException` keeps the stricter exit behavior.)
 */
process.on(
  'unhandledRejection',
  createUnhandledRejectionHandler({ process: 'worker', sentrySource: 'worker_unhandledRejection' }),
);

async function main() {
  process.env.CORE_BE_RUNTIME = 'worker';

  /** Fail fast on insecure DB/Redis transport before opening connections. No-op outside hosted. */
  assertDatabaseTlsVerification();
  assertRedisTlsVerification();

  /** Avoids a startup race where the first scheduled job's direct command on the shared
   * `redisConnection` (lazyConnect + enableOfflineQueue:false) fails with
   * "Stream isn't writeable" before the lazy connect completes. */
  await connectRedis();
  await connectBullMqRedis();
  warnWhenBullMqSharesCacheRedisHost();
  setWorkerPostgresPoolDemandContext(computeWorkerPostgresPoolDemand());
  await assertPostgresConnectionBudget({ assertWorkerConcurrency: true });
  await assertDatabaseRoleRlsSafety();
  await assertMaintenanceDatabaseRoleRlsSafety();
  registerPostgresPoolMetrics();

  const { createWorkerContainers } = await import('@/worker-containers.js');
  const workers = await registerDomainWorkers(createWorkerContainers());
  await startWorkerHealthServer();
  markWorkerHealthReady(workers.length);

  const shutdown = async (signal: string) => {
    markWorkerHealthNotReady();
    logger.info({ signal }, 'Worker shutdown requested');
    stopRssMonitoring();

    const watchdogMs = getShutdownWatchdogMs();
    const watchdogTimer = setTimeout(() => {
      logger.error({ watchdogMs }, 'Worker shutdown timeout exceeded');
      process.exit(1);
    }, watchdogMs).unref();

    try {
      /**
       * Order matters: drain workers first so no new DB / Redis work starts, then close
       * DLQ producer queues, then shared infra (Redis, Postgres pool), and finally flush
       * telemetry.
       */
      await stopWorkerHealthServer();
      await Promise.allSettled(workers.map((workerHandle) => closeWorkerHandle(workerHandle)));
      await Promise.allSettled([
        closeDeadLetterQueues(),
        closeStripeWebhookQueue(),
        closeSubscriptionSeatSyncQueue(), // REQ-4: seat-quantity sync producer queue
        closeMailQueue(),
        closeNotificationQueue(),
        closeWebhookDeliveryQueue(),
        closeUserDataExportQueue(), // sec-r4-R1: was missing from shutdown sequence
      ]);
      await Promise.allSettled([closeRedis(), closeBullMqRedis(), closeDatabase()]);
      // audit M5: tear down the OpenTelemetry SDK (no-op when never started)
      // before the Sentry flush so pending OTLP spans flush on shutdown.
      await shutdownOpenTelemetry();
      // Flush pending product-analytics events (no-op when PostHog is disabled).
      await shutdownPostHog();
      await flushSentry();
      clearTimeout(watchdogTimer);
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Worker shutdown failed');
      clearTimeout(watchdogTimer);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info({ workerCount: workers.length }, 'Worker started');
}

main().catch((error) => {
  captureException(error, { tags: { source: 'worker_startup' } });
  // sec-r5-runtime: explicit message/stack/name fields are required because
  // pino's default behaviour serialises `Error` objects as `{}` (non-enumerable
  // properties). Without these, the worker startup error in production logs
  // shows only "Worker failed to start" with no context — leaving an operator
  // unable to diagnose why the worker process is restart-looping. The same
  // pattern is applied in `error-handler.middleware.ts` for the HTTP path.
  logger.error(
    {
      error,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      errorName: error instanceof Error ? error.name : undefined,
    },
    'Worker failed to start',
  );
  void flushSentry().finally(() => process.exit(1));
});
