import { PostHog } from 'posthog-node';
import { env } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * Default ingestion host used when `POSTHOG_KEY` is configured but `POSTHOG_HOST`
 * is omitted. US cloud; set `POSTHOG_HOST=https://eu.i.posthog.com` for EU.
 */
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * Long-lived server processes should not hold events in memory for long, so the
 * client flushes after this many queued events or once {@link FLUSH_INTERVAL_MS}
 * elapses — whichever comes first. Values mirror posthog-node defaults but are
 * set explicitly so the batching posture is visible at the call site.
 */
const FLUSH_AT = 20;
const FLUSH_INTERVAL_MS = 10_000;

let client: PostHog | null = null;

/**
 * Initialize the PostHog product-analytics client for server-side event capture.
 *
 * Call this **after** {@link initSentry} / {@link initOpenTelemetry} when building
 * the API or worker entrypoint. No-op when `POSTHOG_KEY` is not configured, so
 * deployments without analytics simply run with capture disabled.
 */
export function initPostHog(): void {
  if (client) return;

  const apiKey = env.POSTHOG_KEY;
  if (!apiKey) {
    logger.info('POSTHOG_KEY not configured — PostHog product analytics disabled');
    return;
  }

  const host = env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST;
  client = new PostHog(apiKey, {
    host,
    flushAt: FLUSH_AT,
    flushInterval: FLUSH_INTERVAL_MS,
  });

  logger.info({ host }, 'PostHog initialized');
}

/**
 * Returns the live PostHog client, or `null` when analytics is disabled
 * (`POSTHOG_KEY` unset / {@link initPostHog} not called). Callers that need the
 * raw client (e.g. feature-flag evaluation) must null-check the result.
 */
export function getPostHogClient(): PostHog | null {
  return client;
}

/** Whether the PostHog client has been initialized (i.e. `POSTHOG_KEY` was set). */
export function isPostHogInitialized(): boolean {
  return client !== null;
}

/**
 * Capture a server-side product-analytics event. No-op when PostHog is disabled,
 * so call sites never need to guard on configuration.
 *
 * @param params.distinctId Stable per-user identifier (e.g. user id).
 * @param params.event Event name (e.g. `subscription_activated`).
 * @param params.properties Optional event properties.
 * @param params.groups Optional group analytics keys (e.g. `{ organization: organizationId }`).
 */
export function capturePostHogEvent(params: {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
  groups?: Record<string, string>;
}): void {
  if (!client) return;

  client.capture({
    distinctId: params.distinctId,
    event: params.event,
    ...(params.properties ? { properties: params.properties } : {}),
    ...(params.groups ? { groups: params.groups } : {}),
  });
}

/**
 * Flush pending PostHog events and release the client (call in graceful-shutdown
 * paths before `process.exit`). No-op when PostHog is disabled; flush failures are
 * logged best-effort and never block shutdown.
 */
export async function shutdownPostHog(): Promise<void> {
  if (!client) return;

  try {
    await client.flush();
  } catch (error) {
    logger.warn({ error }, 'PostHog flush during shutdown failed');
  } finally {
    client = null;
  }
}
