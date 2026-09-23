import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { env } from '@/shared/config/env.config.js';
import { closeDatabase } from '@/infrastructure/database/connection.js';
import { closeBullMqRedis } from '@/infrastructure/cache/bullmq-redis.client.js';
import { closeRedis } from '@/infrastructure/cache/redis.client.js';
import { closeMailQueue } from '@/infrastructure/mail/queues/mail.queue.js';
import { closeNotificationQueue } from '@/domains/notify/sub-domains/notification/queues/notification.queue.js';
import { closeWebhookDeliveryQueue } from '@/domains/notify/sub-domains/webhook/webhook-delivery/queues/webhook-delivery.queue.js';
import { closeSubscriptionSeatSyncQueue } from '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.queue.js';
import { closeStripeWebhookQueue } from '@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js';
import { closeUserDataExportQueue } from '@/domains/user/sub-domains/user-data-export/queues/user-data-export.queue.js';
import { flushSentry } from '@/infrastructure/observability/sentry/sentry.js';
import { shutdownPostHog } from '@/infrastructure/observability/posthog/posthog.js';
import { closeBullMQMetricsQueues } from '@/infrastructure/observability/metrics/bullmq-metrics.js';
import { shutdownOpenTelemetry } from '@/infrastructure/observability/tracing/otel.js';
import { THREE_SECONDS_MS } from '@/shared/constants/index.js';
import { setApplicationDraining } from '@/shared/utils/infrastructure/application-lifecycle.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

import { getShutdownWatchdogMs } from '@/infrastructure/queue/worker-runtime/shutdown-timing.util.js';

/**
 * Pause between flipping `/readyz` to 503 (draining) and closing the server, so an
 * external load balancer observes the unhealthy state on its next probe and stops
 * routing new connections before sockets close.
 *
 * @remarks
 * Sized at roughly 1.5–2× a typical 1.5–2s load-balancer health-probe interval so at
 * least one probe reliably lands inside the draining window. Without this pause a
 * Railway/LB redeploy (SIGTERM) races `app.close()`: `/readyz` only reports 503 once
 * the LB next polls, and any traffic sent in between resets → connection errors / 502s
 * on every deploy. The delay is added on top of the shutdown watchdog budget (see
 * {@link getShutdownDrainDelayMs}) so it never eats into the in-flight drain budget or
 * trips the force-exit watchdog.
 */
export const SHUTDOWN_DRAIN_DELAY_MS = THREE_SECONDS_MS;

/** Drain pause for the current runtime: {@link SHUTDOWN_DRAIN_DELAY_MS} when SHUTDOWN_DRAIN_ENABLED, else 0. */
function getShutdownDrainDelayMs(): number {
  return env.SHUTDOWN_DRAIN_ENABLED ? SHUTDOWN_DRAIN_DELAY_MS : 0;
}

const shutdownMiddleware: FastifyPluginAsync = async (app) => {
  app.addHook('onClose', async () => {
    // #786: under test, many apps are built per Vitest worker and all share the process-level
    // singletons (the Redis cache client, BullMQ producer queues, the DB pool). Closing them on
    // every app.close() and reviving them in the next file churns the BullMQ/ioredis connections,
    // whose re-init / reconnect INFO probe (BullMQ getRedisVersionAndType / ioredis readyCheck)
    // then rejects against a closing stream at worker teardown — a flaky unhandled rejection that
    // fails an otherwise-green run. The worker owns those singletons and reaps them at process
    // exit, so skip the process-level teardown when SHUTDOWN_SKIP_SHARED_TEARDOWN is set (default
    // under the per-worker test harness). Production/dev (one app per process) still tears
    // everything down below. Reads raw `process.env` (always current; the `env` const is frozen
    // before the harness sets the flag) so no env-config mock is required.
    if (process.env.SHUTDOWN_SKIP_SHARED_TEARDOWN === 'true') {
      return;
    }
    /**
     * Order: stop accepting jobs (producer queues) → close shared infra (Redis, DB) →
     * flush telemetry. Each close is independent of the others and is awaited via
     * allSettled so a slow Redis does not abort the DB drain.
     */
    await Promise.allSettled([
      closeMailQueue(),
      closeNotificationQueue(),
      closeWebhookDeliveryQueue(),
      // REQ-4: producer queue used by change-plan + member add/remove on the request path.
      closeSubscriptionSeatSyncQueue(),
      // #786: stripe-webhook ingress and user-data-export (POST /users/me/data-export) are also
      // request-path producer queues — close them too so no BullMQ producer connection leaks at
      // graceful shutdown (previously only 4 of the 6 producer queues were drained here).
      closeStripeWebhookQueue(),
      closeUserDataExportQueue(),
    ]);
    // The same pooled BullMQ clients the readiness probe uses — released before the shared
    // connections so the API does not leave Redis sockets open on the way out.
    await closeBullMQMetricsQueues();
    await Promise.allSettled([closeRedis(), closeBullMqRedis(), closeDatabase()]);
    // audit M5: flush + tear down the OpenTelemetry SDK (no-op when never started)
    // before the Sentry flush so pending OTLP spans are not dropped on shutdown.
    await shutdownOpenTelemetry();
    // Flush pending product-analytics events (no-op when PostHog is disabled).
    await shutdownPostHog();
    await flushSentry();
  });

  const shutdown = async (signal: string) => {
    setApplicationDraining(true);
    logger.info({ signal }, 'Shutdown requested');

    const drainDelayMs = getShutdownDrainDelayMs();
    /** Add the drain pause on top of the close budget so the watchdog cannot kill the drain. */
    const watchdogMs = getShutdownWatchdogMs() + drainDelayMs;
    const timer = setTimeout(() => {
      logger.error({ watchdogMs }, 'Shutdown timeout exceeded');
      process.exit(1);
    }, watchdogMs).unref();

    try {
      if (drainDelayMs > 0) {
        logger.info({ drainDelayMs }, 'Draining: waiting for load balancer to observe 503');
        await new Promise<void>((resolve) => setTimeout(resolve, drainDelayMs).unref());
      }
      await app.close();
      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Shutdown failed');
      clearTimeout(timer);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
};

export default fp(shutdownMiddleware, { name: 'shutdown-middleware' });
