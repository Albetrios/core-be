import type { FastifyInstance } from 'fastify';
import requestLifecycleMiddleware from './core/request-lifecycle.middleware.js';
import compressMiddleware from './core/compress.middleware.js';
import cookieMiddleware from './session/cookie.middleware.js';
import helmetMiddleware from './security/helmet.middleware.js';
import corsMiddleware from './security/cors.middleware.js';
import rateLimitMiddleware from './rate-limit/rate-limit.middleware.js';
import errorHandlerMiddleware from './core/error-handler.middleware.js';
import overloadGuardMiddleware from './core/overload-guard.middleware.js';
import responseFormatMiddleware from './core/response-format.middleware.js';
import apiVersioningMiddleware from './core/api-versioning.middleware.js';
import requestContextMiddleware from './core/request-context.middleware.js';
import serverTimingMiddleware from './core/server-timing.middleware.js';
import i18nMiddleware from './core/i18n.middleware.js';
import idempotencyMiddleware from './core/idempotency.middleware.js';
import encryptionMiddleware from './security/encryption.middleware.js';
import authMiddleware from './core/auth.middleware.js';
import zodTypeProviderMiddleware from './core/zod-type-provider.middleware.js';
import tenantMiddleware from './tenant/tenant.middleware.js';
import organizationRlsTransactionMiddleware from './tenant/organization-rls-transaction.middleware.js';
import requestStatementTimeoutMiddleware from './core/request-statement-timeout.middleware.js';
import healthMiddleware from './core/health.middleware.js';
import httpMetricsPlugin from '@/infrastructure/observability/metrics/http-metrics.plugin.js';
import metricsMiddleware from './core/metrics.middleware.js';
import opsMiddleware from './core/ops.middleware.js';
import shutdownMiddleware from './core/shutdown.middleware.js';

/**
 * Ordered Fastify plugin list registered by {@link registerMiddleware}. Order
 * is significant: `requestLifecycleMiddleware` MUST be first to own the
 * `onResponse` orchestration of RLS-settle → idempotency-cache → outbox-flush
 * (Fastify `onResponse` hooks run FIFO).
 *
 * @remarks
 * sec-M4: the prior version of this block said `rateLimitMiddleware` had to
 * stay before `organizationRlsTransactionMiddleware` "so throttled requests
 * never open a DB transaction". That justification has been stale since
 * `organization-rls-transaction.middleware.ts` became a no-op stub that
 * returns `'no_transaction'` immediately — no HTTP-side transaction is opened
 * anywhere now; organization-scoped work runs inside `withAppDatabaseContext`.
 * The no-op is kept registered because `request-lifecycle.middleware.ts`
 * imports its settlement-outcome type as part of the lifecycle contract; a
 * future drop must update both files together. See the no-op's own TSDoc.
 */
export const middlewarePlugins = [
  // MUST be first: registers the only `onResponse` hook that orchestrates
  // RLS-settle → idempotency-cache → outbox-flush in the correct order
  // (Fastify onResponse hooks run FIFO).
  requestLifecycleMiddleware,
  compressMiddleware,
  cookieMiddleware,
  helmetMiddleware,
  corsMiddleware,
  errorHandlerMiddleware,
  // Load-shed valve: 503 fast when the event loop is saturated so the tail latency stays bounded
  // instead of growing an unbounded queue. Early (right after the error handler that formats its
  // thrown ServiceUnavailableError) so it sheds before auth / tenant / DB work.
  overloadGuardMiddleware,
  responseFormatMiddleware,
  apiVersioningMiddleware,
  requestContextMiddleware,
  // Emits the `Server-Timing` response header (server-side processing ms); wrapped in
  // fastify-plugin so its onSend hook applies to every route.
  serverTimingMiddleware,
  i18nMiddleware,
  idempotencyMiddleware,
  encryptionMiddleware,
  zodTypeProviderMiddleware,
  authMiddleware,
  tenantMiddleware,
  // `tenantMiddleware` stays AFTER `i18nMiddleware` because it throws a
  // translated `ValidationError` on header/path mismatch.
  // `rateLimitMiddleware` runs after auth + tenant so per-user / per-organization keys
  // are available (the global limiter is keyed on `request.ip`, so it does
  // not strictly require either, but per-route limits do). Order is otherwise
  // irrelevant against `organizationRlsTransactionMiddleware`, which is a
  // no-op stub (sec-M4).
  rateLimitMiddleware,
  organizationRlsTransactionMiddleware,
  requestStatementTimeoutMiddleware,
  healthMiddleware,
  httpMetricsPlugin,
  metricsMiddleware,
  opsMiddleware,
  shutdownMiddleware,
] as const;

/** Sequentially registers {@link middlewarePlugins} on the Fastify app; order matters. */
export async function registerMiddleware(application: FastifyInstance): Promise<void> {
  for (const plugin of middlewarePlugins) {
    await application.register(plugin);
  }
}
