/**
 * Must stay free of `@/` path alias — env must be deterministic before Vitest resolves application modules.
 * Loads `.env.${NODE_ENV}` (defaulting to `.env.local`) from project root via the shared
 * loader, same as the API and worker entrypoints.
 */
import '../../shared/config/load-env-files.js';

// Force NODE_ENV=development (mirrors src/tests/setup.ts) so a developer's `.env.local` cannot leak a
// different value through load-env-files. NODE_ENV is `local` | `development` | `production`; the chaos
// suite runs as `development` and drives test-only behaviour (captcha bypass, in-memory rate limiting,
// cleanupDatabase/cleanupTestRedis guards) via the explicit flags below.
process.env.NODE_ENV = 'development';
// Isolate the chaos Redis keyspace from a running `pnpm dev` (both are NODE_ENV=development).
// Literal, not an import: this module must resolve BEFORE Vitest wires `@/` aliases,
// and the import-paths policy forbids `../` in a `from` clause. It is instead a
// generator target (see text-identity-rewrites.ts), so a rebrand rewrites it in place.
process.env.REDIS_KEY_PREFIX ??= 'core:test:';
// Skip process-level shared-singleton teardown under the per-worker Vitest harness.
process.env.SHUTDOWN_SKIP_SHARED_TEARDOWN = 'true';
// Disable the ioredis ready-check (read raw from process.env by the Redis/BullMQ clients).
process.env.REDIS_READY_CHECK_ENABLED = 'false';
// Category-B security flags default hardened; set the relaxed test values (see src/tests/setup.ts).
process.env.CAPTCHA_BYPASS_ALLOWED ??= 'true';
process.env.SESSION_ORIGIN_CSRF_REQUIRED ??= 'false';
process.env.WEBHOOK_ALLOWLIST_REQUIRED ??= 'false';
process.env.METRICS_AUTH_REQUIRED ??= 'false';
// Boot-time safety checks + wipe/rate-limit affordances (see src/tests/setup.ts). The chaos suite
// forces the in-memory rate-limit store (RUN_REDIS_TESTS=0 below), which requires the fallback flag.
process.env.DATABASE_TLS_ENFORCED ??= 'false';
process.env.DATABASE_RLS_SAFETY_ENFORCED ??= 'false';
process.env.DATABASE_CONNECTION_BUDGET_ENFORCED ??= 'false';
process.env.REDIS_TLS_ENFORCED ??= 'false';
process.env.TRUST_PROXY_REQUIRED ??= 'false';
// TEST_MODE marks this as a test run — the single gate the test-only affordances require.
process.env.TEST_MODE = 'true';
process.env.RATE_LIMIT_RELAXED_CAPS ??= 'true';
process.env.RATE_LIMIT_IN_MEMORY_FALLBACK_ALLOWED ??= 'true';
// Category-A behaviour flags now have static production-safe defaults; set the development values.
process.env.CAPTCHA_FAIL_OPEN ??= 'true';
process.env.SCHEDULER_REGISTRY_AUDIT_STRICT ??= 'false';
process.env.SERVER_TIMING_COARSE ??= 'false';
process.env.SHUTDOWN_DRAIN_ENABLED ??= 'false';
process.env.I18N_REPORT_MISSING_KEYS ??= 'false';
process.env.LOG_PRETTY ??= 'true';
process.env.SENTRY_REDUCED_SAMPLING ??= 'false';
process.env.SENTRY_DEBUG ??= 'true';
process.env.VITEST_CHAOS_SUITE = 'true';
/**
 * In-memory rate limiting only: `@fastify/rate-limit` otherwise shares `redisConnection` and can
 * stall requests while other scenarios administratively disable the Redis Toxiproxy listener.
 */
process.env.RUN_REDIS_TESTS = '0';
process.env.RUN_DB_TESTS ||= '1';

process.env.PORT ??= '3000';
process.env.HTTP_BIND_HOST = '127.0.0.1';
process.env.LOG_LEVEL ??= 'warn';
/** Deprecated optional no-op; RS256 keys come from load-env-files / test setup. */
process.env.ALLOWED_ORIGINS ??= 'http://localhost:3000';
process.env.FRONTEND_URL ??= 'http://localhost:3000';

process.env.RATE_LIMIT_MAX ??= '1000';
process.env.RATE_LIMIT_WINDOW_MS ??= '60000';
process.env.ENABLE_QUEUE_DASHBOARD ??= 'true';
process.env.ENABLE_MCP_SERVER ??= 'true';
process.env.BLOCK_DISPOSABLE_EMAIL ??= 'false';

/**
 * Mirrors `src/tests/setup.ts` placeholders so outbound providers stay deterministic under Vitest chaos.
 */
process.env.STRIPE_SECRET_KEY ??= 'sk_test_contract_fixture_key_for_nock_stubs';
process.env.STRIPE_WEBHOOK_SECRET ??=
  'whsec_test_contract_fixture_fallback_when_local_secret_below_32_xx';
process.env.RESEND_API_KEY ??= 're_test_contract_fixture_for_chaos_testing_queue_only';
process.env.EMAIL_FROM_ADDRESS ??= 'noreply@example.com';
process.env.S3_BUCKET ??= 'contract-test-bucket';
process.env.S3_REGION ??= 'us-east-1';
process.env.S3_ACCESS_KEY_ID ??= 'AKIAIOSFODNN7EXAMPLE';
process.env.S3_SECRET_ACCESS_KEY ??= 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

/**
 * Always point at Toxiproxy listener ports for this Vitest profile. A developer `.env` often
 * sets direct `localhost:5432` / `6379` URLs; `||=` would skip the override and chaos traffic
 * would bypass proxies, so toxins and administrative proxy disables would not affect the app.
 * The credentials are Compose's (`core:core`); the CI chaos job's Postgres service creates the
 * same role, so this one URL serves both.
 */
process.env.DATABASE_URL = 'postgresql://core:core@127.0.0.1:25432/core';

process.env.REDIS_URL = 'redis://127.0.0.1:26379';

/**
 * The harness's elevated connection (`DATABASE_OPERATOR_URL`, which `cleanupDatabase()` uses) must
 * go through the proxy too. Left on a developer's direct URL, cleanup bypasses Toxiproxy and the
 * app pool starts every test cold — and a cold pool does not fail fast under a connect-time fault
 * (it keeps reconnecting while the query waits), so an assertion that expects the query to reject
 * waits out the test timeout instead. Pointing it at `DATABASE_URL` makes the operator connection
 * the app pool, as before the harness gained a separate one.
 */
process.env.DATABASE_OPERATOR_URL = process.env.DATABASE_URL;

/**
 * Maintenance contexts (`withMaintenanceDatabaseContext` — retention, audit drain, global admin)
 * open their own pool on `DATABASE_MAINTENANCE_URL` when it is set, which a developer's env file
 * does. That pool would reach Postgres directly, so no toxin could touch a maintenance path. Keep
 * its role and credentials — the scope's grants are what these paths are tested under — and
 * reroute only the host and port through the Toxiproxy listener.
 */
if (process.env.DATABASE_MAINTENANCE_URL) {
  const proxiedMaintenanceUrl = new URL(process.env.DATABASE_MAINTENANCE_URL);
  proxiedMaintenanceUrl.hostname = '127.0.0.1';
  proxiedMaintenanceUrl.port = '25432';
  process.env.DATABASE_MAINTENANCE_URL = proxiedMaintenanceUrl.toString();
}
