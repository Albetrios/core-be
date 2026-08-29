import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import fastifyRateLimit from '@fastify/rate-limit';
import type { RateLimitPluginOptions } from '@fastify/rate-limit';
import { env } from '@/shared/config/env.config.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { Sentry } from '@/infrastructure/observability/sentry/sentry.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { createRedisFallbackRateLimitStore } from '@/shared/middlewares/rate-limit/rate-limit-fallback-store.js';
import { shouldEmitRateLimitTelemetry } from '@/shared/middlewares/rate-limit/rate-limit-telemetry-throttle.js';

/**
 * Observes a request that is about to be throttled by the global limiter: emits a structured
 * `rate_limit.exceeded` warning (with the resolved bucket key) and a warning-level Sentry
 * breadcrumb so the next captured error carries the throttle context. Purely additive — it
 * does not alter limiter behavior. Matches the `onExceeding` signature `(request, key)`.
 */
function recordGlobalRateLimitExceeded(request: FastifyRequest, key: string): void {
  // Throttle the WARN + Sentry breadcrumb per key so a single hot IP/NAT cannot flood logs
  // and Sentry under load (see rate-limit-telemetry-throttle.ts). Still allowed to throttle
  // the actual request — this only governs the observability emission.
  if (!shouldEmitRateLimitTelemetry(key)) {
    return;
  }
  const url = request.routeOptions?.url ?? request.url;
  logger.warn({
    event: 'rate_limit.exceeded',
    ip: request.ip,
    method: request.method,
    url,
    key,
  });
  Sentry.addBreadcrumb({
    category: 'rate_limit',
    message: `Rate limit exceeded: ${key}`,
    level: 'warning',
    data: {
      method: request.method,
      url,
      ip: request.ip,
    },
  });
}

/**
 * Liveness/readiness probe paths bypassed by the global limiter. Matched by exact
 * path equality (query string stripped) so deploy probes and load balancers are never
 * throttled, while arbitrary paths sharing a prefix (e.g. `/livezxyz`) are not exempt.
 */
const RATE_LIMIT_ALLOWLISTED_PATHS = new Set(['/livez', '/readyz']);

/**
 * Global rate limiting, keyed strictly on `request.ip`.
 *
 * This limiter runs in the `onRequest` phase, before route authentication (which happens
 * in a later `preHandler` via `app.authenticate`). The only tenant signal available here is
 * any request-asserted organization value, which is NOT verified against
 * the caller's membership. Keying on that value would let an unauthenticated client rotate a
 * fresh organization id per request to mint a new bucket (bypassing the per-IP cap) or reuse a victim
 * org's id to burn its shared bucket (cross-tenant throttling). It is therefore IP-only.
 *
 * Org- and user-scoped quotas are applied per route in a post-auth `preHandler` via the
 * presets in `rate-limit-presets.constants.ts` (e.g. `ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT`),
 * where `request.auth` and route authorization gate access before the key is derived.
 *
 * @remarks
 * **Fail-over to per-process limiting on Redis error (not full fail-open).** The shared Redis
 * client uses `enableOfflineQueue: false`, so during a Redis blip (failover, maintenance, brief
 * network partition) a raw Redis store's `incr` rejects immediately. Rather than `skipOnError`
 * alone — which would leave the API completely unmetered during the outage — the limiter uses
 * {@link createRedisFallbackRateLimitStore}: Redis errors transparently degrade to an in-process
 * fixed-window counter, so a per-instance cap still applies while Redis is down. `skipOnError`
 * remains set as a last-resort guard (the fallback store does not throw, so a Redis blip can
 * never turn `/livez` / `/readyz` and every other request into a 5xx).
 *
 * The trade-off is **reduced precision over availability**: the local fallback caps throughput
 * per process (not cluster-wide), which is preferable to either a blanket outage or unmetered
 * traffic. Defense in depth is preserved by (1) the per-route auth-gated presets, (2) the Redis
 * client's `error` event handler which logs `redis.connection.error` for alerting, the
 * `rate_limit.redis_failover.local` warning emitted while degraded, and (3) the idempotency
 * middleware which intentionally fail-closes for write safety.
 *
 * Wrapped with `fastify-plugin` so `@fastify/rate-limit` decorates the root app rather than an
 * encapsulated child context. This is required for two reasons: (1) the `global: true` limiter's
 * `onRequest` hook must apply to every route (and run before `organizationRlsTransactionMiddleware`
 * so throttled requests never open a DB transaction), and (2) per-route presets that build a second
 * limiter via `app.rateLimit(...)` (e.g. the per-email throttle in `auth.routes.ts`) need the
 * `rateLimit` decorator visible at the instance where routes register.
 */
const rateLimitMiddleware: FastifyPluginAsync = async (app) => {
  const plugin = fastifyRateLimit as unknown as FastifyPluginAsync<RateLimitPluginOptions>;

  const options: RateLimitPluginOptions = {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    // Exact-match the liveness/readiness probe paths so unmetered bypass cannot be
    // smuggled via a prefix collision like `/healthxyz` (the old `startsWith('/health')`).
    allowList: (request) => RATE_LIMIT_ALLOWLISTED_PATHS.has(request.url.split('?', 1)[0] ?? ''),
    keyGenerator: (request) => request.ip,
    // Last-resort guard only — the fallback store below already degrades to in-process limiting
    // on Redis errors, so this should never actually skip. See @remarks above.
    skipOnError: true,
    // Observe-only: surface every throttled request as a structured log + Sentry breadcrumb.
    onExceeding: recordGlobalRateLimitExceeded,
  };

  // Use Redis when configured; the chaos suite sets RUN_REDIS_TESTS=0 to force in-memory
  // limiting. That switch is honored only where RATE_LIMIT_IN_MEMORY_FALLBACK_ALLOWED is true (a
  // schema refine forbids it in production) — a stray RUN_REDIS_TESTS=0 in a prod env must never
  // silently downgrade the cluster-wide Redis limiter to per-process counting. The fallback store
  // keeps counting in-process if Redis becomes unavailable at runtime.
  const redisTestsForcedOff =
    env.RATE_LIMIT_IN_MEMORY_FALLBACK_ALLOWED && process.env.RUN_REDIS_TESTS === '0';
  if (env.REDIS_URL && !redisTestsForcedOff) {
    options.store = createRedisFallbackRateLimitStore(redisConnection) as unknown as NonNullable<
      RateLimitPluginOptions['store']
    >;
  }

  await app.register(plugin, options);
};

export default fp(rateLimitMiddleware, { name: 'rate-limit-middleware' });
