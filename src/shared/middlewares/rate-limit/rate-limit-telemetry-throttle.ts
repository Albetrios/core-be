/**
 * Per-key throttle for rate-limit `onExceeded` telemetry (the global + per-route observers).
 *
 * @remarks
 * - **Algorithm:** keeps a bounded `Map<key, lastEmittedAtMs>`; returns `true` at most once per
 *   {@link RATE_LIMIT_TELEMETRY_THROTTLE_MS} per key. When the map reaches
 *   {@link RATE_LIMIT_TELEMETRY_MAX_TRACKED_KEYS} it is cleared wholesale (cheap, bounded memory)
 *   rather than evicted LRU — telemetry sampling tolerates the occasional reset.
 * - **Why:** a caller that has hit its limit keeps hitting it. One key under a sustained burst
 *   would otherwise emit a Pino WARN **and** a Sentry breadcrumb for every rejected request, for
 *   the whole window — burning CPU and log volume exactly when the process is hottest, and for a
 *   fact already established by the first line. Throttling preserves the security signal (you
 *   still see which bucket is being hit, and when) without the per-request flood.
 * - **Side effects:** mutates the module-level map. Process-local (not cluster-wide); each replica
 *   throttles independently, which is the desired behavior for log/breadcrumb volume control.
 * - **Notes:** the observers used to be wired to `onExceeding`, which `@fastify/rate-limit` calls
 *   on every request it ALLOWS — so this throttle was originally capping a flood of warnings
 *   "for requests that still returned 200". That was the symptom; the hook was the cause. The
 *   throttle is still worth having on the corrected `onExceeded` path, for the reason above.
 */
const RATE_LIMIT_TELEMETRY_THROTTLE_MS = 10_000;
const RATE_LIMIT_TELEMETRY_MAX_TRACKED_KEYS = 10_000;
const rateLimitTelemetryLastEmittedAtMsByKey = new Map<string, number>();

/**
 * Returns `true` when rate-limit telemetry for `key` should be emitted now, applying the per-key
 * time throttle described in the module remarks. See module-level `@remarks` for the algorithm.
 */
export function shouldEmitRateLimitTelemetry(key: string): boolean {
  const nowMs = Date.now();
  const lastEmittedAtMs = rateLimitTelemetryLastEmittedAtMsByKey.get(key);
  if (lastEmittedAtMs !== undefined && nowMs - lastEmittedAtMs < RATE_LIMIT_TELEMETRY_THROTTLE_MS) {
    return false;
  }
  if (rateLimitTelemetryLastEmittedAtMsByKey.size >= RATE_LIMIT_TELEMETRY_MAX_TRACKED_KEYS) {
    rateLimitTelemetryLastEmittedAtMsByKey.clear();
  }
  rateLimitTelemetryLastEmittedAtMsByKey.set(key, nowMs);
  return true;
}
