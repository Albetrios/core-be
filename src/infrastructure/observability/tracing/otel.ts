import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { getEnv } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

let sdk: NodeSDK | null = null;
let initialized = false;

/**
 * Optional OpenTelemetry export to OTLP. Coexists with Sentry (errors + optional Sentry traces).
 * When OTEL_EXPORTER_OTLP_ENDPOINT is unset, this is a no-op.
 */
export function initOpenTelemetry(serviceName: string): void {
  if (initialized) return;

  const environment = getEnv();
  const otlpEndpoint = environment.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!otlpEndpoint) {
    logger.info('OTEL_EXPORTER_OTLP_ENDPOINT not configured — OpenTelemetry disabled');
    initialized = true;
    return;
  }

  const resolvedServiceName = environment.OTEL_SERVICE_NAME ?? serviceName;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: resolvedServiceName,
      'deployment.environment': environment.SENTRY_ENVIRONMENT ?? environment.NODE_ENV,
    }),
    traceExporter: new OTLPTraceExporter({
      url: otlpEndpoint.endsWith('/v1/traces')
        ? otlpEndpoint
        : `${otlpEndpoint.replace(/\/$/, '')}/v1/traces`,
    }),
    instrumentations: [new HttpInstrumentation()],
  });

  try {
    sdk.start();
  } catch (error) {
    // Tracing must never take the process down. Since the Sentry v10 bump the
    // Sentry SDK registers the OpenTelemetry globals itself (trace/context/
    // propagation), so our NodeSDK.start() can throw "Attempted duplicate
    // registration" — on the first Neon deploy that unhandled throw at module
    // top level killed the container before /readyz ever answered (issue
    // #1129, layer 3). Sentry's OTel then owns tracing; our helpers use the
    // global API and keep working against it.
    sdk = null;
    initialized = true;
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'OpenTelemetry NodeSDK start skipped — globals already registered (Sentry-owned tracing)',
    );
    return;
  }
  initialized = true;
  logger.info({ serviceName: resolvedServiceName, otlpEndpoint }, 'OpenTelemetry initialized');
}

/**
 * Flushes pending OTLP spans and tears down the `NodeSDK` instance. Called from
 * the graceful shutdown middleware; safe to call when OTEL was never initialised.
 */
export async function shutdownOpenTelemetry(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = null;
  initialized = false;
}

/** Test-only reset so init/shutdown can be exercised in isolation. */
export function resetOpenTelemetryStateForTests(): void {
  sdk = null;
  initialized = false;
}
