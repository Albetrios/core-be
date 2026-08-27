import '@/shared/config/load-env-files.js';
import {
  LOCAL_DATABASE_NAME,
  REDIS_KEY_PREFIX_STEM,
} from '@/shared/constants/project-identity.constants.js';

const LOCAL_TEST_DATABASE_URL = `postgresql://${LOCAL_DATABASE_NAME}:${LOCAL_DATABASE_NAME}@localhost:5432/${LOCAL_DATABASE_NAME}`;

function isLocalDatabaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const { hostname } = new URL(value);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function forceLocalDatabaseForNonCiTestRun(): void {
  if (process.env.CI === 'true' || process.env.ALLOW_HOSTED_TEST_DATABASE === 'true') return;
  if (isLocalDatabaseUrl(process.env.DATABASE_URL)) return;

  process.env.DATABASE_URL = LOCAL_TEST_DATABASE_URL;
  process.env.DATABASE_MIGRATION_URL = LOCAL_TEST_DATABASE_URL;
}

/**
 * The developer's `.env.local` is loaded before this file (via `load-env-files`, which defaults to
 * `.env.local` when NODE_ENV is unset). Several values that make sense for `pnpm dev` would break the
 * test harness — they MUST mirror CI's `.github/workflows/reusable-vitest-postgres-redis.yml` env, not
 * the developer's `.env.local`. These are hard-overridden (not `??=`) so local test runs are
 * deterministic regardless of what each contributor has in their `.env.local`.
 */
// NODE_ENV is `local` | `development` | `production` (`local` = a developer's machine, the unset
// default). The Vitest suite runs as `development` (there is no separate `test` runtime); test-only
// behaviour is driven by the explicit flags set below.
process.env.NODE_ENV = 'development';
// shutdown.middleware reads this raw (the frozen `env` const predates this override) to skip
// process-level shared-singleton teardown under the per-worker Vitest harness.
process.env.SHUTDOWN_SKIP_SHARED_TEARDOWN = 'true';
// redis.client / bullmq-redis.client / queue/connection read this raw from process.env (the frozen
// `env` const predates this override) to disable the ioredis ready-check under the churned test singletons.
process.env.REDIS_READY_CHECK_ENABLED = 'false';
// Category-B security flags now default to their HARDENED value everywhere; the harness sets the
// relaxed values explicitly (previously implied by the non-production runtime) so e2e behaves as
// before: captcha bypass, Referer-fallback origin check, empty webhook allowlist, and unauthenticated
// metrics all stay permissive under test.
process.env.CAPTCHA_BYPASS_ALLOWED ??= 'true';
process.env.SESSION_ORIGIN_CSRF_REQUIRED ??= 'false';
process.env.WEBHOOK_ALLOWLIST_REQUIRED ??= 'false';
process.env.METRICS_AUTH_REQUIRED ??= 'false';
// Boot-time safety checks default hardened (enforce) outside a local development runtime; the e2e
// harness relaxes them so tests boot against the localhost Docker Postgres/Redis without TLS/RLS/
// budget/proxy enforcement, and permits the destructive wipe helpers + relaxed rate-limit caps.
process.env.DATABASE_TLS_ENFORCED ??= 'false';
process.env.DATABASE_RLS_SAFETY_ENFORCED ??= 'false';
process.env.DATABASE_CONNECTION_BUDGET_ENFORCED ??= 'false';
process.env.REDIS_TLS_ENFORCED ??= 'false';
process.env.TRUST_PROXY_REQUIRED ??= 'false';
// TEST_MODE marks this as a test run — the single gate the test-only affordances (destructive wipe
// helpers, send-code debug echo) require.
process.env.TEST_MODE = 'true';
process.env.RATE_LIMIT_RELAXED_CAPS ??= 'true';
// Category-A behaviour flags now have STATIC production-safe defaults (NODE_ENV no longer selects a
// default); the harness sets the development values so test captcha/shutdown/log/timing behaviour is
// unchanged. CAPTCHA_FAIL_OPEN + SHUTDOWN_DRAIN + SCHEDULER audit are the pass/fail-relevant ones.
process.env.CAPTCHA_FAIL_OPEN ??= 'true';
process.env.SCHEDULER_REGISTRY_AUDIT_STRICT ??= 'false';
process.env.SERVER_TIMING_COARSE ??= 'false';
process.env.SHUTDOWN_DRAIN_ENABLED ??= 'false';
process.env.I18N_REPORT_MISSING_KEYS ??= 'false';
process.env.LOG_PRETTY ??= 'true';
process.env.SENTRY_REDUCED_SAMPLING ??= 'false';
process.env.SENTRY_DEBUG ??= 'true';
forceLocalDatabaseForNonCiTestRun();
process.env.DATABASE_SSL_ENABLED = 'false';
/**
 * Mirror CI (which leaves this unset → schema default `true`). `.env.development` pins it to
 * `false` for the legacy request-pinned RLS transaction mode used by `pnpm dev`, but that mode
 * commits the per-request transaction in an `onResponse` hook — i.e. AFTER `fastify.inject()`
 * resolves. Tests that assert a DB side effect (e.g. an audit row) immediately after an
 * authenticated org request then race the deferred commit and flake. Forcing the scoped-context
 * mode (inline `withOrganizationDatabaseContext` commits) makes local runs deterministic and
 * match CI, the source of truth.
 */
/**
 * Feature flags asserted by route registration and auth tests. `.env.development` sets
 * several of these to `'false'` for local dev ergonomics, but the test harness needs the
 * corresponding routes/handlers wired so each suite can assert its real-world behavior.
 * Individual tests that exercise the disabled path flip the flag back inside `beforeAll`
 * (e.g. `mcp-disabled.security.test.ts`, `queue-dashboard-readonly.security.test.ts`).
 */
process.env.ENABLE_MCP_SERVER = 'true';
process.env.ENABLE_QUEUE_DASHBOARD = 'true';
process.env.ENABLE_QUEUE_DASHBOARD_MUTATIONS = 'true';
/**
 * Metrics mirror CI (`reusable-vitest-postgres-redis.yml`) and the env-schema default (`true`).
 * `.env.development` pins `METRICS_ENABLED=false` for local `pnpm dev` ergonomics, which
 * de-registers `GET /metrics`. But `docs/routes.txt` catalogues `/metrics` as a TOKEN route, so
 * `auth-enforcement.security.test.ts` (which drives every catalogued protected route) expects it
 * registered — and a full `pnpm test:coverage` run otherwise fails locally even though it is green
 * in CI. Hard-override both (the token is required when metrics are enabled — see env-schema's
 * `METRICS_ENABLED → METRICS_SCRAPE_TOKEN` refinement, min 32 chars). Tests that exercise the
 * disabled path set `METRICS_ENABLED=false` themselves inside `beforeEach`/`beforeAll` and restore it.
 */
process.env.METRICS_ENABLED = 'true';
process.env.METRICS_SCRAPE_TOKEN = 'test-metrics-token-min-32-characters';
// Global-admin allowlist for ROLE-guarded route tests (auth middleware re-derives
// SUPER_ADMIN from this email list per request). CI sets the same value via the
// test-env action; `??=` keeps any explicit value.
process.env.GLOBAL_ADMIN_EMAILS ??= 'ops@example.com';
// Fake OAuth client credentials so GET /auth/oauth/:provider builds its authorize
// URL (pure string work, no outbound call) deterministically on CI runners that
// have no sandbox apps configured. `??=` keeps real local sandbox values.
process.env.OAUTH_GOOGLE_CLIENT_ID ??= 'test-google-client-id';
process.env.OAUTH_GOOGLE_CLIENT_SECRET ??= 'test-google-client-secret';
process.env.OAUTH_GITHUB_CLIENT_ID ??= 'test-github-client-id';
process.env.OAUTH_GITHUB_CLIENT_SECRET ??= 'test-github-client-secret';
// The schema requires a redirect URI wherever a client ID is set — a client ID alone is an
// invalid configuration that fails closed at boot rather than misdirecting the provider. The
// fixture must therefore model a COMPLETE provider, not a half-configured one.
process.env.OAUTH_GOOGLE_REDIRECT_URI ??= 'http://localhost:5173/callback';
process.env.OAUTH_GITHUB_REDIRECT_URI ??= 'http://localhost:5173/callback';
// Isolate the test Redis keyspace from a running `pnpm dev` (both are NODE_ENV=development); a hard
// set (not the developer's `.env.local` value) keeps the test prefix deterministic and isolated.
process.env.REDIS_KEY_PREFIX = `${REDIS_KEY_PREFIX_STEM}:test:`;
delete process.env.WEBHOOK_URL_ALLOWLIST;
// CAPTCHA mirrors CI (`reusable-vitest-postgres-redis.yml` leaves CAPTCHA_PROVIDER unset →
// schema default `disabled`). A developer `.env.local` that enables Cloudflare Turnstile
// (CAPTCHA_PROVIDER=turnstile + CAPTCHA_SECRET, e.g. from a local dashboards bring-up) would
// otherwise make `captchaPreHandler` enforce a token on every public auth form and fail the
// whole auth/e2e suite with 401 `errors:captchaRequired`. Hard-disable so local matches CI; the
// captcha route tests assert the prehandler is registered statically, not enforced at runtime.
process.env.CAPTCHA_PROVIDER = 'disabled';

/**
 * Placeholder smell — `.env.example` (and the seeded `.env.development`) use `host` as a
 * literal hostname placeholder for connection URLs (e.g. `redis://host:6379`,
 * `postgresql://user:pass@host:5432/core`). When a contributor copies the template but hasn't
 * filled in real values, `host` is not resolvable and tests hang on ENOTFOUND. Drop these so
 * the `??=` fallbacks below point at the Docker Compose defaults.
 */
function clearIfPlaceholderHost(name: string): void {
  const value = process.env[name];
  /** Matches either `://host:` / `://host/` (no auth) or `@host:` / `@host/` (with auth). */
  if (value && /(?:\/\/|@)host(?:[:/]|$)/.test(value)) {
    delete process.env[name];
  }
}
clearIfPlaceholderHost('DATABASE_URL');
clearIfPlaceholderHost('DATABASE_MIGRATION_URL');
clearIfPlaceholderHost('REDIS_URL');
clearIfPlaceholderHost('REDIS_BULLMQ_URL');

const TEST_JWT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDJp33Skforij0b
cb5iPkuY7IeTw+X6NuKmkadoCS7aRaQgkon9u/s1Lj05tRuZTgw0VqfYiIbud2z1
PWJtl4niSyG8cjNdglpUkNW1f7oaDC9YoGfup5telmZy5vK5IVieT0fn5ePLRdlk
bMkOf2fHcx/rRf4Vl+ff9E9BXLmYg1yqkKPxHBBwZPcqmQ2DW3An7DEUS/ZDw8AE
UIBHRurFQOYZ1xzov/w21a0l+qT911yk5TJKl+ffeeQQ5twiiDMQEQQoJDKJOXo3
UsuFycfSgkJV2KnzK9QsHrHYrM44cD08yIctf1/I3Z3xwVms8Bof6pv0q96Lueh1
D+ECdd4BAgMBAAECggEABUwGhJT8Ds+7SjDDMP506ufvqcSAEoIFkx2JWbTAC9C/
fnGK+WTKNPvpdM4akvzXWjqafxga/0GY1ZpOrxVHdG/Hy5TuX3rwl38UdgeMYmnG
hpv0DvNNI/9sYoFJh+5lzwbDG0bRJIJJsxcecuiK19Tg1kPI6FVMrHfU6yEd6PEi
d5/igyxkxxcPr96BlNkKl+7CAYqY88t5uwXbnbxAmxLIMQ6f26T+1vCCJnHpRakS
UygAQLJFXJzOTV2j1mMIyZi28DNR7+QRYzHeYTBe+e3dsaxC14+veVMjKpWS+AIX
eqoCbyZhDPtYowR9iAO/P1jGPAv9EnEKJZxDCdt65wKBgQDts2fuTmxAFNZg3umt
hpUXuxmnzKdkrU8Vtqmwet3MdETIBAUbWnP+l4LgMj1N3CB77/DGWGiSpLKyXWZf
oQFEv4XVf6ikKzl11ILouCsaiiR7y5Xqjt2Q1tm7fXZ3ntzsX4jGJ3X8H1KRet63
/JP/lPsQqcbZSi8kdrDIvX71HwKBgQDZLa6stFKU4IaEA9SiLxgRpOhBtQB4i+iB
L5l7UZkGn5fscNtQG5c9NFnZ0n6NslsNlShCgGuNAyL1mQph4iG1ozmJYeHruWFO
CA/3wyxL1alzCPdZxtIDPRZ+F+LnzPHlT4hPA/uHmIgOkQn1HPMAul7D5wEby6y7
a69f7b6o3wKBgDiAPqIcrgqFaXfZRL5kkSf052JFeTyrHXNR2gADFJm2wWqx2ezo
kU3hAdD84CmTu3z6Scc72I+S6o8POHheswh+ZfebwqBTTfM+MmfS7xv93jI28Emy
7+Ovzk2Mww4oCud8xewkER1+7Id8J1ighyVnak5JrOSVh6MpO1hcAsONAoGAerRY
0LNBRWRmHAieBtRc4PsvTpCZp4JE51ihew9rSla5W5mYD/bGyInfijZn0l9HGrF/
gbNVEOMIyYKiXxOIwDtssrZfEvQ2igP8IZxgVqhtiNU0C8FNvw6wuqV8SkN9GHaL
KTmyz7XaiYBhA+BLW8nw6PaHpdC501rQR37oDjkCgYAUYS5GwaSz9O6UQAN3/TxS
cpwfpB+Vt5zOcukuHOw0IWNjxI3DGglfjeipNJSXMAlUfoMrXuTpt2YjYs2gJH1U
caaEEWY15kCKLmEjbKIIechhSi5FUlyJ118JbioPVgXDhvxara1wGITfk6APhvCL
LjeTy3MMidIN1gyTCnBPWQ==
-----END PRIVATE KEY-----
`;

const TEST_JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyad90pH6K4o9G3G+Yj5L
mOyHk8Pl+jbippGnaAku2kWkIJKJ/bv7NS49ObUbmU4MNFan2IiG7nds9T1ibZeJ
4kshvHIzXYJaVJDVtX+6GgwvWKBn7qebXpZmcubyuSFYnk9H5+Xjy0XZZGzJDn9n
x3Mf60X+FZfn3/RPQVy5mINcqpCj8RwQcGT3KpkNg1twJ+wxFEv2Q8PABFCAR0bq
xUDmGdcc6L/8NtWtJfqk/ddcpOUySpfn33nkEObcIogzEBEEKCQyiTl6N1LLhcnH
0oJCVdip8yvULB6x2KzOOHA9PMiHLX9fyN2d8cFZrPAaH+qb9Kvei7nodQ/hAnXe
AQIDAQAB
-----END PUBLIC KEY-----
`;

function normalizeTestPem(value: string | undefined, marker: string, fallback: string): string {
  if (!value?.includes(marker)) {
    return fallback;
  }
  return value.replaceAll('\\n', '\n');
}

process.env.JWT_PRIVATE_KEY = normalizeTestPem(
  process.env.JWT_PRIVATE_KEY,
  'BEGIN PRIVATE KEY',
  TEST_JWT_PRIVATE_KEY,
);
process.env.JWT_PUBLIC_KEY = normalizeTestPem(
  process.env.JWT_PUBLIC_KEY,
  'BEGIN PUBLIC KEY',
  TEST_JWT_PUBLIC_KEY,
);
// Suppress BullMQ Redis eviction policy warning in tests (local/CI Redis often uses volatile-lru)
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const message = typeof args[0] === 'string' ? args[0] : String(args[0]);
  if (message.includes('Eviction policy is') && message.includes('noeviction')) return;
  originalWarn.apply(console, args);
};
process.env.LOG_LEVEL ??= 'info';
process.env.PORT ??= '3000';
process.env.HTTP_BIND_HOST = '127.0.0.1';
// Local fallback — tests run against the same Docker Postgres dev uses (see docker-compose.yml).
// CI overrides DATABASE_URL to its ephemeral service-container Postgres.
process.env.DATABASE_URL ??= LOCAL_TEST_DATABASE_URL;
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.RUN_REDIS_TESTS ??= '1';
/** Deprecated optional no-op; RS256 keys below are authoritative for JWT. */
process.env.SECRETS_ENCRYPTION_KEY ??= 'a'.repeat(64);
process.env.METRICS_SCRAPE_TOKEN ??= 'test-metrics-bearer-token-min-32-chars';
process.env.COOKIE_SECURE ??= 'false';
/** Local `.env` may set a short Stripe webhook signing secret — HMAC helpers require plausible length under test */
if (
  process.env.STRIPE_WEBHOOK_SECRET !== undefined &&
  process.env.STRIPE_WEBHOOK_SECRET.length > 0 &&
  process.env.STRIPE_WEBHOOK_SECRET.length < 32
) {
  process.env.STRIPE_WEBHOOK_SECRET =
    'whsec_test_contract_fixture_fallback_when_local_secret_below_32_xx';
}

/**
 * Isolated outbound contract slice (`pnpm test:contract`): force placeholders so `.env`
 * sandbox keys / bucket names / regions never leak into mocks (or vice versa).
 */
if (process.env.CONTRACT_TESTS_ENABLED === 'true') {
  process.env.STRIPE_SECRET_KEY = 'sk_test_contract_fixture_key_for_nock_stubs';
  process.env.STRIPE_WEBHOOK_SECRET =
    'whsec_test_contract_fixture_webhook_signing_must_be_minimum_32characters';
  process.env.RESEND_API_KEY = 're_test_contract_fixture_key';
  process.env.EMAIL_FROM_ADDRESS = 'noreply@example.com';
  process.env.S3_BUCKET = 'contract-test-bucket';
  process.env.S3_REGION = 'us-east-1';
  process.env.S3_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
  process.env.S3_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
}

/**
 * Offline contract tests — infra wrappers require env before nock stubs network (non-overriding baseline).
 */
process.env.STRIPE_SECRET_KEY ??= 'sk_test_contract_fixture_key';
process.env.STRIPE_WEBHOOK_SECRET ??=
  'whsec_test_contract_fixture_secret_minimum_length_32_chars_xx';
process.env.RESEND_API_KEY ??= 're_test_contract_fixture_key';
// EMAIL_FROM_ADDRESS is required by env-schema whenever RESEND_API_KEY is set (no hardcoded
// sender fallback in mail.service); provide a baseline so the parsed `env` validates in tests.
process.env.EMAIL_FROM_ADDRESS ??= 'noreply@example.com';
process.env.S3_BUCKET ??= 'contract-test-bucket';
process.env.S3_REGION ??= 'us-east-1';
process.env.S3_ACCESS_KEY_ID ??= 'AKIAIOSFODNN7EXAMPLE';
process.env.S3_SECRET_ACCESS_KEY ??= 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

// Hard-set (not `??=`) so a developer's `.env.local` ALLOWED_ORIGINS (e.g. a dashboards / core-fe
// origin) cannot break the auth origin/CSRF e2e tests, which assert against `http://localhost:3000`.
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
process.env.RATE_LIMIT_MAX ??= '1000';
process.env.RATE_LIMIT_WINDOW_MS ??= '60000';
process.env.AUDIT_RETENTION_DAYS ??= '90';
process.env.AUTH_SESSION_RETENTION_DAYS ??= '30';
process.env.ENABLE_QUEUE_DASHBOARD ??= 'true';
process.env.ENABLE_MCP_SERVER ??= 'true';
// Allow disposable emails in tests so flows using yopmail/mailinator etc. can run
process.env.BLOCK_DISPOSABLE_EMAIL = 'false';
const { resetEnvCacheForTests } = await import('@/shared/config/env.config.js');
const { resetJwtCachesForTests } = await import('@/shared/utils/security/jwt.util.js');
resetJwtCachesForTests();
resetEnvCacheForTests();
