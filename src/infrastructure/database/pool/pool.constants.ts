/**
 * Default postgres.js pool size per Node process when `DATABASE_POOL_MAX` is unset.
 *
 * Single source of truth: both the live pool (`buildPostgresOptions` in `connection.ts`) and the
 * pool-exhaustion alerter (`evaluatePoolExhaustionAndAlert`) resolve their max from this constant,
 * so the saturation thresholds can never silently drift from the connections actually available.
 * Kept in a dependency-free module so the alerter does not transitively instantiate the pg pool.
 *
 * Raised 10 → 20 to lift the per-process in-flight DB concurrency ceiling (each RLS request holds
 * one pooled connection for its lifetime). Kept in lockstep with the `DATABASE_POOL_MAX` env-schema
 * default; the cluster-wide budget is still enforced fail-closed at boot by
 * `assertPostgresConnectionBudget`.
 */
export const DEFAULT_DATABASE_POOL_MAX = 20;

/** Default seconds an idle pooled connection is kept before postgres.js closes it (`idle_timeout`). */
export const DEFAULT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS = 300;

/** Default seconds to wait for a new connection before failing (`connect_timeout`). */
export const DEFAULT_DATABASE_POOL_CONNECT_TIMEOUT_SECONDS = 10;

/**
 * `Retry-After` (seconds) on the 503 a unit of work gets when no pooled connection arrives before
 * `DATABASE_POOL_ACQUIRE_TIMEOUT_MS`: long enough for a failover or a cold start to finish, short
 * enough that a client retries soon after the database is back.
 */
export const DATABASE_ACQUIRE_RETRY_AFTER_SECONDS = 5;

/** Default max lifetime (seconds) of a pooled connection before recycling (`max_lifetime`, 30 min). */
export const DEFAULT_DATABASE_POOL_MAX_LIFETIME_SECONDS = 1_800;
