/**
 * Env Zod schema and key list only. Safe to import from scripts that must not run getEnv()
 * (e.g. sync-env-example). Application code should use env.config.ts for getEnv() and env.
 *
 * @remarks
 * `.env.example` is the documented template. Keys whose empty state is intentional
 * (disabled providers, optional features, deploy-time placeholders) carry a
 * `# OPTIONAL — <condition>` marker in `.env.example`. `pnpm github:sync` correctly
 * skips empty OPTIONAL keys rather than pushing `KEY=""` to GitHub Environments.
 * When you add a new env key that's conditionally required, mark it OPTIONAL in
 * `.env.example` and pair it with a corresponding `.optional()` / refinement here.
 */
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { validateProductionRedisTopology } from '@/infrastructure/cache/redis-url.parse.util.js';
import { type EnvVarSpec, envVar, toSchemaShape } from '@/shared/config/env-var-registry.js';
import { DEFAULT_ANTI_ENUMERATION_MINIMUM_DURATION_MS } from '@/shared/constants/security.constants.js';
import { PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS } from '@/shared/constants/ttl.constants.js';
import { z } from 'zod';

/** Minimum accepted RSA modulus (bits) for the RS256 signing keys (audit #8). */
const MIN_JWT_RSA_MODULUS_BITS = 2048;

/**
 * Returns true when `pem` parses as an RSA key (of `kind`) whose modulus is at
 * least {@link MIN_JWT_RSA_MODULUS_BITS} bits. Used by the boot-time refine so a
 * truncated PEM or an accidental sub-2048-bit / non-RSA key fails fast instead of
 * issuing forgeable tokens or failing opaquely at first sign/verify (audit #8).
 */
const isStrongRsaPem = (pem: string, kind: 'private' | 'public'): boolean => {
  try {
    const key = kind === 'private' ? createPrivateKey(pem) : createPublicKey(pem);
    return (
      key.asymmetricKeyType === 'rsa' &&
      (key.asymmetricKeyDetails?.modulusLength ?? 0) >= MIN_JWT_RSA_MODULUS_BITS
    );
  } catch {
    return false;
  }
};

/**
 * SHA-256 fingerprints of the committed test RSA keypair's base64 bodies (`src/tests/setup.ts`),
 * used by the production refine so the well-known test key can never sign or verify real tokens
 * (audit-#L1). Recompute with the snippet in that refine's message if the test key is ever rotated.
 */
const FORBIDDEN_TEST_JWT_KEY_FINGERPRINTS = new Set<string>([
  '68cfe10636b1315e7c1eb340d593f2b46408cf0a56263adc816c119e9c05a854', // test JWT_PRIVATE_KEY
  'c3289b311fdd666237778b2d1d186832b7fb9acdb97aadd3d167600808ec8dd4', // test JWT_PUBLIC_KEY
]);

/** SHA-256 of a PEM block's base64 body (headers + all whitespace stripped) — stable across newline encodings. */
const pemBodyFingerprint = (pemBlock: string): string =>
  createHash('sha256')
    .update(pemBlock.replace(/-----(?:BEGIN|END)[^-]*-----/g, '').replace(/[^A-Za-z0-9+/=]/g, ''))
    .digest('hex');

/**
 * True when `value` contains a PEM block whose body matches a forbidden test-key fingerprint.
 * Checks `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` so the committed test keypair can never sign or verify
 * production tokens.
 */
const containsForbiddenTestJwtKey = (value: string | undefined): boolean => {
  if (!value) return false;
  const pemBlocks = value.match(/-----BEGIN[\s\S]*?-----END[^-]*-----/g) ?? [value];
  return pemBlocks.some((block) =>
    FORBIDDEN_TEST_JWT_KEY_FINGERPRINTS.has(pemBodyFingerprint(block)),
  );
};

// Runtime environment name — `local | development | production`. `local` is the developer's
// machine (primary file `.env.local`); `development` / `production` are the two DEPLOY targets
// (deploy-target enums in `tooling/setup/` stay `development | production` — you never deploy to
// `local`). Default is `local` — an unset NODE_ENV is a developer's machine (a stock `pnpm dev`, a
// local `pnpm db:*`); every DEPLOY and CI context sets NODE_ENV explicitly (workflows, both Docker
// stages, the Vitest harness pin it), so the default never reaches a deployed or CI runtime. An
// out-of-enum value (e.g. `staging`) makes `envSchema.parse` fail loudly at boot (env.config.ts).
const nodeEnvSchema = z.enum(['local', 'development', 'production']).default('local');

// Every policy flag below has a STATIC default (a hardcoded 'true'/'false'). NODE_ENV is NOT read to
// choose a default — the module never branches on it. Each flag defaults to its PRODUCTION-safe value;
// development and the test harness set the relaxed values explicitly in `.env` (see `.env.example`).
// NODE_ENV appears only in the enum above and in the `.refine()` constraints below (parsed `data`),
// which forbid an unsafe flag value when `data.NODE_ENV === 'production'`. Every switch lives in env.

// DATABASE_URL / REDIS_URL / ALLOWED_ORIGINS are required in every runtime (no NODE_ENV-derived
// localhost default): each environment sets them in its own `.env` (`pnpm setup:local` scaffolds a
// local `.env.local` with localhost values). This keeps the required-vars contract independent of
// the module-load NODE_ENV, so an explicit `production` parse fails loudly when they are missing.

const booleanString = (defaultValue: 'true' | 'false') =>
  z
    .string()
    .optional()
    .default(defaultValue)
    .transform((value) => value === 'true' || value === '1');

const MAX_TRUST_PROXY_HOPS = 10;

const trustProxyHopCountSchema = z
  .string()
  .optional()
  .transform((value, context) => {
    const normalizedValue = value?.trim().toLowerCase();
    if (!normalizedValue || normalizedValue === 'false' || normalizedValue === '0') {
      return false;
    }

    const hopCount = Number(normalizedValue);
    if (Number.isInteger(hopCount) && hopCount >= 1 && hopCount <= MAX_TRUST_PROXY_HOPS) {
      return hopCount;
    }

    context.addIssue({
      code: 'custom',
      message:
        'TRUST_PROXY must be false/0 or an integer proxy hop count from 1 to 10; do not use bare true',
    });
    return z.NEVER;
  });

/**
 * Server & process variables — the first section migrated to the {@link EnvVarSpec} registry.
 * Each entry pairs its inline Zod field (validation unchanged) with an allowed-values summary and a
 * one-line description; {@link toSchemaShape} spreads them into {@link envSchemaBase}, and the same
 * registry drives `pnpm env:catalog`. Migrating a field is a mechanical wrap — the Zod is untouched.
 */
const SERVER_VARS = {
  PORT: envVar(z.coerce.number().int().min(1).max(65535).default(3000), {
    allowed: 'integer 1–65535',
    description: 'HTTP port the API server binds to.',
  }),
  HTTP_BIND_HOST: envVar(z.string().min(1).default('0.0.0.0'), {
    allowed: 'non-empty string (host or IP)',
    description: 'Fastify HTTP bind address (the worker health server also binds here).',
  }),
  NODE_ENV: envVar(nodeEnvSchema, {
    allowed: 'local | development | production',
    description:
      'Runtime environment name; names the .env file and gates the production-only refines.',
  }),
  // sec-C9: enum-constrained so a typo (`info ` with trailing whitespace, `dbug`) fails at boot
  // instead of silently degrading pino. Default `info`; a `debug` template value would 10–100x log
  // volume in any environment scaffolded from it — including production.
  LOG_LEVEL: envVar(
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    {
      allowed: 'fatal | error | warn | info | debug | trace | silent',
      description:
        'Pino log level. Enum-constrained so a typo fails at boot instead of silently degrading.',
    },
  ),
  TRUST_PROXY: envVar(trustProxyHopCountSchema, {
    allowed: 'false | 0, or integer 1–10',
    description: 'Number of reverse-proxy hops Fastify may trust for X-Forwarded-* headers.',
  }),
  FASTIFY_KEEP_ALIVE_TIMEOUT_MS: envVar(
    z.coerce.number().int().min(1_000).max(600_000).optional(),
    {
      allowed: 'integer 1000–600000 (optional)',
      description: 'Fastify keep-alive timeout in milliseconds.',
    },
  ),
  FASTIFY_HEADERS_TIMEOUT_MS: envVar(z.coerce.number().int().min(1_000).max(600_000).optional(), {
    allowed: 'integer 1000–600000 (optional)',
    description: 'Fastify headers timeout in milliseconds.',
  }),
  FASTIFY_REQUEST_TIMEOUT_MS: envVar(z.coerce.number().int().min(1_000).max(600_000).optional(), {
    allowed: 'integer 1000–600000 (optional)',
    description: 'Fastify request timeout in milliseconds.',
  }),
  FASTIFY_CONNECTION_TIMEOUT_MS: envVar(
    z.coerce.number().int().min(1_000).max(600_000).optional(),
    {
      allowed: 'integer 1000–600000 (optional)',
      description: 'Fastify connection timeout in milliseconds.',
    },
  ),
  // Network-independent latency for load tools (k6, curl) and browser devtools without scraping
  // /metrics. Default on; set false to suppress the header (it is coarsened in production).
  HTTP_SERVER_TIMING_ENABLED: envVar(booleanString('true'), {
    allowed: 'true | false (or 1 | 0)',
    description: 'Emit a Server-Timing response header carrying total server-side processing time.',
  }),
  // Dormant until the loop truly stalls (a long sync op / GC pause), since 250 ms is well above the
  // tens-of-ms of normal load. Lower to shed sooner; raise to tolerate longer stalls.
  OVERLOAD_MAX_EVENT_LOOP_DELAY_MS: envVar(
    z.coerce.number().int().min(1).max(60_000).default(250),
    {
      allowed: 'integer 1–60000',
      description:
        'Overload-guard shed threshold: p99 event-loop delay (ms) above which requests get a 503.',
    },
  ),
  // DB-pool exhaustion shows as awaiting-promise time (the loop stays idle), so the event-loop valve
  // never trips on it; shedding at pool saturation bounds that tail. Set 0 to disable (loop valve stays on).
  OVERLOAD_DB_POOL_SHED_RATIO: envVar(z.coerce.number().min(0).max(1).default(0.9), {
    allowed: 'number 0–1',
    description:
      'Fraction of DATABASE_POOL_MAX in-flight RLS checkouts at which the overload guard sheds requests.',
  }),
} satisfies Record<string, EnvVarSpec>;

const envSchemaBase = z.object({
  // Server & process — declared in the SERVER_VARS registry above (allowed values + description).
  ...toSchemaShape(SERVER_VARS),

  // Database (managed service)
  DATABASE_URL: z.string().min(1),
  DATABASE_MIGRATION_URL: z.string().min(1).optional(), // elevated-privilege user for migrations

  // Redis (managed service)
  REDIS_URL: z.string().min(1),
  /**
   * Dedicated Redis endpoint for BullMQ queues. Recommended in production so a queue
   * backlog (e.g. during a worker outage) cannot exhaust the write-critical cache /
   * idempotency / rate-limit store on REDIS_URL. Defaults to REDIS_URL when unset
   * (single-instance local development).
   */
  REDIS_BULLMQ_URL: z.string().min(1).optional(),
  /**
   * Redis key prefix for cache, idempotency, rate limits, and BullMQ (default `core:<NODE_ENV>:`).
   * Override to isolate environments on a shared Redis cluster.
   */
  REDIS_KEY_PREFIX: z
    .string()
    .max(64)
    .regex(/^[a-zA-Z0-9:_-]+$/)
    .optional(),

  // Auth
  /** RS256 PEM private key. Required in every runtime; NODE_ENV is metadata only. */
  JWT_PRIVATE_KEY: z.string().min(1),
  /** RS256 PEM public key. Required in every runtime; NODE_ENV is metadata only. */
  JWT_PUBLIC_KEY: z.string().min(1),
  /** Key id stamped in the JWT header when signing with RS256 (default: `default`). Informational — single-key model, not used to select a verification key. */
  JWT_SIGNING_KID: z.string().min(1).optional().default('default'),
  /** Comma-separated emails that receive super_admin in JWT on login/refresh (platform ops). */
  GLOBAL_ADMIN_EMAILS: z.string().optional(),
  /** Shorter access-token TTL (seconds) for GLOBAL_ADMIN_EMAILS super_admin JWTs. Default 300 (5 min). */
  GLOBAL_ADMIN_ACCESS_TOKEN_EXPIRY_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),

  // Session
  // sec-r4-C4: cap session lifetime at one year. Without an upper bound, an
  // operator typo (`AUTH_SESSION_MAX_AGE_DAYS=3650`) or stale config could
  // produce sessions that effectively never expire — extending the breach
  // window after a credential compromise indefinitely. 365 is well clear of
  // any realistic "stay signed in" UX (Slack / GitHub / GMail all rotate
  // long-lived sessions inside this window) and bounds the worst-case impact
  // of a stolen refresh token to a known interval.
  AUTH_SESSION_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  /** Secure flag for session + CSRF cookies. Set false only for plaintext local loops. */
  COOKIE_SECURE: booleanString('true'),
  /**
   * `SameSite` for the session + CSRF cookies. Defaults `strict`, which assumes the SPA reaches
   * this API same-site — same registrable domain, or proxied through the SPA's own origin.
   *
   * When the SPA is served from a DIFFERENT site than the API (e.g. `*.netlify.app` calling
   * `*.railway.app`) the browser strips a `strict` cookie from every cross-site request, so the
   * cookie-authenticated routes under `/api/v1/auth` — refresh, logout, switch-to-organization —
   * return 401 even though login succeeded. `none` is the only value a browser sends cross-site,
   * and it requires `COOKIE_SECURE=true` (enforced by a refine below).
   *
   * Prefer same-site hosting and leave this `strict`: `none` widens CSRF exposure to whatever the
   * double-submit CSRF token catches on its own.
   */
  COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),

  // ── Policy flags (replace former `NODE_ENV === …` comparisons in runtime code) ──────────────
  // Runtime modules read one of these flags, never NODE_ENV. Two kinds:
  //  • Category-A (behaviour): default selected per environment above; freely overridable.
  //  • Category-B (security): default to the HARDENED value everywhere; a `.refine()` below rejects
  //    an unsafe override in production. Relaxed dev/test values are set explicitly (env
  //    file / test harness) so nothing silently weakens on a deployed environment.
  /**
   * Category-A. Safety valve for the TURNSTILE path only: when CAPTCHA_PROVIDER=turnstile but
   * verification cannot complete (CAPTCHA_SECRET unset, or the verify call errors), fail OPEN (skip)
   * instead of blocking auth. Defaults false (fail closed, production-safe); development and the
   * test harness set it true in `.env`. `CAPTCHA_PROVIDER=disabled` turns captcha off on its own and
   * does NOT require this flag (one behaviour, one variable).
   */
  CAPTCHA_FAIL_OPEN: booleanString('false'),
  /**
   * Category-B. Permits the `CAPTCHA_BYPASS_HEADER` dev affordance. Defaults false (bypass off);
   * the refine rejects `true` in production. Dev/test opt in explicitly.
   */
  CAPTCHA_BYPASS_ALLOWED: booleanString('false'),
  /**
   * Category-B. Require CSRF double-submit on cookie-session routes when the Origin header is
   * absent (else fall back to Referer). Defaults true (hardened); the refine keeps it true in
   * production. Dev may set false for Referer-fallback tooling.
   */
  SESSION_ORIGIN_CSRF_REQUIRED: booleanString('true'),
  /**
   * Category-B. Reject outbound webhook targets when `WEBHOOK_URL_ALLOWLIST` is empty (SSRF guard).
   * Defaults true (hardened); the refine keeps it true in production. Dev may set false for testing.
   */
  WEBHOOK_ALLOWLIST_REQUIRED: booleanString('true'),
  /**
   * Category-B. Require a valid bearer token on the worker `/metrics` endpoint when metrics are
   * enabled. Defaults true (hardened); the refine keeps it true in production.
   */
  METRICS_AUTH_REQUIRED: booleanString('true'),
  /**
   * Category-A. Fail boot on scheduler/worker registry drift instead of warning. Defaults true
   * (fail fast, production-safe); development sets it false in `.env` so split-worker dev/test does
   * not trip on drift.
   */
  SCHEDULER_REGISTRY_AUDIT_STRICT: booleanString('true'),
  /** Category-A. Coarsen the `Server-Timing` header to 5 ms (timing side-channel guard). Defaults true; development sets false in `.env`. */
  SERVER_TIMING_COARSE: booleanString('true'),
  /** Category-A. Apply the pre-close drain pause (for runtimes behind a load balancer). Defaults true; development sets false in `.env`. */
  SHUTDOWN_DRAIN_ENABLED: booleanString('true'),
  /** Category-A. Skip process-level shared-singleton teardown on app close (per-worker Vitest harness). */
  SHUTDOWN_SKIP_SHARED_TEARDOWN: booleanString('false'),
  /** Category-A. Report missing i18n keys for non-default locales to Sentry (else debug-log). Defaults true; development sets false in `.env`. */
  I18N_REPORT_MISSING_KEYS: booleanString('true'),
  /** Category-A. Pretty-print logs via pino-pretty. Defaults false (JSON, production-safe); development sets true in `.env`. */
  LOG_PRETTY: booleanString('false'),
  /** Category-A. Reduced Sentry sampling defaults (production volume) when SENTRY_*_SAMPLE_RATE unset. Defaults true; development sets false in `.env`. */
  SENTRY_REDUCED_SAMPLING: booleanString('true'),
  /** Category-A. Enable Sentry SDK debug logging. Defaults false (production-safe); development sets true in `.env`. */
  SENTRY_DEBUG: booleanString('false'),

  // ── Boot-time safety checks (former isHostedDeployment() gate → explicit per-check flags) ──────
  // Each flag replaces the single auto-detected HOSTED_DEPLOYMENT signal. Defaults are HARDENED
  // (enforced) everywhere, and a refine below locks each ENFORCED flag on in production so an explicit
  // production PARSE always satisfies it by default. Development relaxes them via `.env` (see the
  // Policy-flags section of `.env.example`); the test harness (src/tests/setup.ts) sets the relaxed
  // values explicitly. A deployed environment keeps the hardened defaults unless it opts out in `.env`.
  /** Category-B. Fail boot when the Postgres server TLS certificate is not verified. */
  DATABASE_TLS_ENFORCED: booleanString('true'),
  /** Category-B. Fail boot when DATABASE_URL connects as a superuser / BYPASSRLS role (collapses RLS). */
  DATABASE_RLS_SAFETY_ENFORCED: booleanString('true'),
  /** Category-B. Require explicit deployment replica counts to validate the Postgres connection budget. */
  DATABASE_CONNECTION_BUDGET_ENFORCED: booleanString('true'),
  /** Category-B. Fail boot on plaintext redis:// to a public host (private/internal hosts stay allowed). */
  REDIS_TLS_ENFORCED: booleanString('true'),
  /** Category-B. Fail boot when TRUST_PROXY is unset/false (behind a load balancer the client IP collapses). */
  TRUST_PROXY_REQUIRED: booleanString('true'),
  /**
   * Category-B. Marks the process as a test run — the master gate for test-only affordances (today the
   * destructive DB/Redis wipe helpers). Defaults false; a refine forbids `true` in production; the
   * test harness sets it true. A test-only capability must additionally check `env.TEST_MODE`.
   */
  TEST_MODE: booleanString('false'),
  /**
   * Category-B. A fixed email verification code accepted by `POST /auth/email/login` for any
   * EXISTING user, in place of the one-time code that `send-code` issues.
   *
   * Exists so local work and load tests can authenticate without the `send-code` round trip —
   * which carries a per-email resend cooldown, its own rate limit, and the 300 ms
   * anti-enumeration floor, none of which say anything useful about the app under test.
   *
   * Unset by default, so the feature does not exist unless a developer opts in. A refine
   * forbids any value in production, so a deployed runtime fails to boot rather than silently
   * accepting a master code. It never creates accounts, never skips the account-active check,
   * and never bypasses the per-user attempt cap — an unknown email still 401s exactly as before.
   */
  AUTH_FIXED_VERIFICATION_CODE: z
    .string()
    .regex(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/, {
      message:
        'must be 6 characters from the verification-code charset (ABCDEFGHJKMNPQRSTUVWXYZ23456789)',
    })
    .optional(),
  /**
   * Category-B. Wall-clock floor (ms) that the silent-success auth endpoints hold every response
   * to, so the known-account and unknown-account branches cannot be told apart by latency.
   *
   * Defaults to the hardened 300 ms, and a refine forbids anything below that in production — the
   * floor only works while it exceeds the slower (known-account) branch, so a deployed runtime may
   * raise it but never lower it. Exists as a knob purely so local work and load tests can drop it
   * and measure what these endpoints actually cost, instead of measuring the padding.
   */
  AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(DEFAULT_ANTI_ENUMERATION_MINIMUM_DURATION_MS),
  /**
   * Category-B. ioredis ready-check on the cache / BullMQ connections. Defaults true (on); the test
   * harness sets `REDIS_READY_CHECK_ENABLED=false` (the per-worker singletons churn across
   * createTestApp instances and a reconnect ready-check rejects against a closing stream). Read via
   * raw `process.env` in the clients for load-order safety; a refine keeps it enabled in production.
   */
  REDIS_READY_CHECK_ENABLED: booleanString('true'),
  /**
   * Category-B. Lift the strict public/authenticated rate-limit caps to 5000 so loopback E2E and
   * dev UX are not throttled. Defaults false (hardened); development sets it true in `.env` and the
   * test harness sets it true; a refine forbids `true` in production where credential-stuffing
   * protection must stay on.
   */
  RATE_LIMIT_RELAXED_CAPS: booleanString('false'),
  /**
   * Category-B. Allow the chaos suite's `RUN_REDIS_TESTS=0` to force the in-memory rate-limit store.
   * Defaults false (hardened); the chaos harness sets it true; a refine forbids `true` in production
   * so a stray RUN_REDIS_TESTS=0 can never silently downgrade the cluster-wide Redis limiter to
   * per-process counting.
   */
  RATE_LIMIT_IN_MEMORY_FALLBACK_ALLOWED: booleanString('false'),
  /**
   * sec-M5: HSTS `preload` is operationally irreversible (weeks to remove
   * from the preload list). Default false so we never advertise preload
   * without operator opt-in confirming registration at
   * https://hstspreload.org has been completed.
   */
  HSTS_PRELOAD_REGISTERED: booleanString('false'),
  /**
   * sec-M5: HSTS `includeSubDomains` locks every subdomain to HTTPS for the
   * full max-age — destructive if the apex hosts non-HTTPS subdomains.
   * Default false; operator opts in once subdomain inventory is audited.
   */
  HSTS_INCLUDE_SUBDOMAINS: booleanString('false'),
  /**
   * sec-C4: when true, `/readyz` returns the verbose operational body
   * (`migration_version`, `mail_outbox_pending`, `dlq_depth`,
   * `worker_queue_manifest`). Default false — unauthenticated callers see
   * only dependency status, not topology / patch level / queue depth.
   * Enable only for trusted internal ingress (LB-internal probes behind ACLs).
   */
  HEALTH_VERBOSE_BODY_ENABLED: booleanString('false'),
  /**
   * Opt-in (default off): when true, `/readyz` returns 503 if any managed external circuit breaker
   * (Stripe/S3/Resend/Turnstile) is OPEN. Off by default so an external-dependency blip is reported
   * as `degraded` in the body without pulling the API out of load-balancer rotation.
   */
  READYZ_503_ON_OPEN_CIRCUIT: booleanString('false'),
  /**
   * Opt-in (default 0 = disabled): when > 0, `/readyz` returns 503 if any throughput queue's
   * `waiting` depth exceeds this value. Off by default — queue depth is reported as `degraded`
   * without affecting load-balancer routing.
   */
  READYZ_QUEUE_DEPTH_503_THRESHOLD: z.coerce.number().int().min(0).default(0),
  /**
   * RSS (resident memory) warning threshold in MB for both the API and worker processes. When a
   * process exceeds it, a `process.rss.exceeds.threshold` warning is logged (sampled every 30s) —
   * an early leak signal alongside the Prometheus `process_resident_memory_bytes` gauge.
   */
  PROCESS_RSS_WARN_THRESHOLD_MB: z.coerce.number().int().min(64).default(512),

  // CORS (comma-separated origins; required in every runtime)
  ALLOWED_ORIGINS: z.string().min(1),

  /** WebAuthn RP ID (hostname). Defaults to first ALLOWED_ORIGINS hostname or localhost. */
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  /** WebAuthn relying party display name shown in passkey prompts. */
  WEBAUTHN_RP_NAME: z.string().min(1).optional(),

  // App URLs
  FRONTEND_URL: z.url().optional(),
  API_DOCS_BASE_URL: z.url().optional(),

  // Rate limiting
  // Upper bound (audit #34) catches a fat-fingered value that would silently disable global
  // throttling. NOTE: during a Redis failover the fallback store counts PER PROCESS, so the
  // effective cluster-wide ceiling while degraded is RATE_LIMIT_MAX × instance count.
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1).default(60_000),
  /** Comma-separated hostnames allowed for outbound webhooks (optional; empty = no extra restriction). */
  WEBHOOK_URL_ALLOWLIST: z
    .string()
    .optional()
    .refine(
      (value) => {
        if (value === undefined) return true;
        // audit #32: reject an over-broad wildcard (`*.com`, `*.io`) that whitelists nearly the
        // entire internet and silently neutralizes the production allowlist. Require at least a
        // registrable domain (>= 2 labels) after `*.`.
        return value
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean)
          .every((entry) => !entry.startsWith('*.') || entry.slice(2).split('.').length >= 2);
      },
      {
        message:
          'WEBHOOK_URL_ALLOWLIST wildcard entries must target at least a registrable domain (e.g. `*.example.com`, not `*.com`).',
      },
    ),
  /**
   * Per-organization cap on active webhook subscribers (sec-N4). The service
   * rejects further creates beyond this number with a 409. The fan-out loop
   * uses the same value as a defense-in-depth backstop so a drift between
   * create-cap and runtime list cannot turn one event into an unbounded
   * signed-POST amplifier.
   */
  WEBHOOK_MAX_PER_ORG: z.coerce.number().int().min(1).max(1000).default(25),
  /**
   * Max number of active (not revoked) API keys allowed per organization
   * (sec-r5-followup-ratelimit-dos-1). Parity with `WEBHOOK_MAX_PER_ORG`. The
   * route already has `ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT` to bound the
   * RATE at which mutations are accepted; this caps the COUNT so a long-running
   * Admin role-holder cannot accumulate unbounded auth-amplifying credentials
   * over time. Default 25 matches realistic CI / service-account needs; raise
   * deliberately for tenants with many micro-service callers.
   */
  ORGANIZATION_API_KEY_MAX_PER_ORG: z.coerce.number().int().min(1).max(1000).default(25),
  /**
   * Max number of active (not deleted) custom roles allowed per organization
   * (sec-r5-followup-ratelimit-dos-2). Parity with `WEBHOOK_MAX_PER_ORG`. The
   * sec-r4-D4 `.limit(256)` on `findByRoleId` already caps the per-role
   * permission read; this caps the per-org role count so a churning Admin
   * cannot unbound the role table itself. Default 50 fits realistic RBAC
   * granularity (admin/editor/viewer + a few custom flavours).
   */
  MEMBER_ROLE_MAX_PER_ORG: z.coerce.number().int().min(1).max(500).default(50),
  /**
   * Max number of active notification policies allowed per organization
   * (sec-r5-followup-ratelimit-dos-3). Parity with `WEBHOOK_MAX_PER_ORG`. The
   * `notification_type` column is free-form varchar(50) with no enum, so
   * without a cap an Admin could churn policies and flap downstream routing.
   * Default 100 — enough for a fine-grained notification matrix (≈ 25 event
   * types × 4 channels) but bounded.
   */
  ORGANIZATION_NOTIFICATION_POLICY_MAX_PER_ORG: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100),
  /**
   * Max number of live pending (not accepted, not revoked, not expired) member invitations allowed
   * per organization. Parity with `WEBHOOK_MAX_PER_ORG`. Invitations are otherwise only seat-bounded,
   * and a PERSONAL / free-tier org has no seat ceiling (null), so without this cap an Admin could
   * enqueue an unbounded backlog of outstanding invites — each sending an email (amplification) and
   * growing the table. Default 100 is a generous ceiling for real onboarding while bounding abuse;
   * raise it deliberately for large orgs bulk-inviting more than 100 people at once.
   */
  INVITATION_MAX_PENDING_PER_ORG: z.coerce.number().int().min(1).max(1000).default(100),
  /**
   * Window (hours) during which outbound webhook deliveries dual-sign with
   * the previous secret too (sec-N8). After this window the worker stops
   * sending `X-Webhook-Signature-Previous`. Default 24h covers a one-day
   * verifier rollout for most customers.
   */
  WEBHOOK_SECRET_ROTATION_OVERLAP_HOURS: z.coerce.number().int().min(1).max(720).default(24),

  // Email (Resend)
  RESEND_API_KEY: z.string().min(1).optional(),
  /** Outbound Resend API request timeout (ms). Forwarded to fetch via AbortSignal. */
  RESEND_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180_000).default(30_000),
  EMAIL_FROM_ADDRESS: z.email().optional(),
  EMAIL_FROM_NAME: z.string().min(1).optional(),
  // Category-B (security). Block disposable/temporary email domains. Defaults to the HARDENED value
  // (true) everywhere; the `.refine()` below rejects `false` in production. The relaxed `false` is a
  // dev/test affordance only (set explicitly in the env file / test harness).
  BLOCK_DISPOSABLE_EMAIL: z
    .string()
    .optional()
    .default('true')
    .transform((value) => value !== 'false' && value !== '0'),

  // OAuth
  OAUTH_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_GOOGLE_REDIRECT_URI: z.url().optional(),
  OAUTH_GITHUB_CLIENT_ID: z.string().min(1).optional(),
  OAUTH_GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  OAUTH_GITHUB_REDIRECT_URI: z.url().optional(),

  // Stripe
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  // STRIPE_PUBLISHABLE_KEY is intentionally NOT in this schema: it is public, browser-only, and the
  // backend never reads it. Provisioning writes it to `.env.<environment>` and surfaces it to core-fe.
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** Stripe Node client per-request HTTP timeout (ms). */
  STRIPE_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180_000).default(30_000),
  /**
   * Tolerance (seconds) for the Stripe webhook signature timestamp check. A wider window lets
   * Stripe's retries — which carry the original event timestamp — still verify after a short API
   * outage instead of being rejected as stale. Stripe's SDK default is 300s; bounded to [150, 600].
   * audit #22: default to 150 (half the Stripe default) to halve the signature-replay window — the
   * `stripe_webhook_events` ledger dedup is the primary replay defense, this is defense-in-depth and
   * now matches the documented posture in `constructStripeWebhookEvent`.
   */
  STRIPE_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(150).max(600).default(150),
  /**
   * Grace window (days) after a subscription enters a dunning status (PAST_DUE / UNPAID /
   * INCOMPLETE) during which it retains its full plan seat ceiling. Anchored at
   * `current_period_end`; once `now > current_period_end + this`, the org's entitlement lapses to
   * the Free-tier ceiling (F4). Keeps the standard dunning UX (a failed payment does not instantly
   * revoke collaborators) while preventing indefinite premium headcount on an unpaid subscription.
   */
  BILLING_DUNNING_GRACE_DAYS: z.coerce.number().int().min(0).max(120).default(14),

  // Sentry
  SENTRY_DSN: z.url().optional(),
  // SENTRY_FRONTEND_DSN is intentionally NOT in this schema: it is the public core-fe project DSN,
  // never read by the backend. Provisioning writes it to `.env.<environment>` and surfaces it to core-fe.
  SENTRY_ENVIRONMENT: z.string().min(1).optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
  SENTRY_PROFILE_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
  /** Always trace transactions at or above this duration (ms); head + tail sampling. */
  SENTRY_SLOW_TRANSACTION_MS: z.coerce.number().int().min(100).max(300_000).default(3000),
  RAILWAY_GIT_COMMIT_SHA: z.string().min(1).optional(),

  // PostHog (product analytics)
  /** PostHog project API key (`phc_…`). When unset, server-side PostHog capture is disabled (no-op). */
  POSTHOG_KEY: z.string().min(1).optional(),
  /**
   * PostHog ingestion host (e.g. https://us.i.posthog.com — or https://eu.i.posthog.com for EU).
   * Defaults to US cloud when POSTHOG_KEY is set but this is omitted.
   */
  POSTHOG_HOST: z.url().optional(),

  /**
   * When true, exposes GET /metrics (Prometheus text format).
   * NODE_ENV is metadata only; disable explicitly with METRICS_ENABLED=false.
   */
  METRICS_ENABLED: booleanString('true'),
  /** Bearer token a Prometheus scraper sends when scraping /metrics. Required when METRICS_ENABLED=true (min 32 chars). */
  METRICS_SCRAPE_TOKEN: z.string().min(32).optional(),
  /** OTLP HTTP traces endpoint base URL (e.g. https://otel.example.com). Appends /v1/traces when omitted. */
  /**
   * sec-C3: in production the OTLP exporter MUST use https://. The
   * runtime accepts both http:// and https://; spans carry SQL fragments,
   * request paths, and request ids that should not traverse the network in
   * plaintext. Refine enforced below.
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  /** OpenTelemetry service.name override (defaults to the generated API / worker service names). */
  OTEL_SERVICE_NAME: z.string().min(1).optional(),

  // S3 / Object Storage
  /** Allow image/svg+xml uploads; sanitized with DOMPurify on confirm (default false). */
  UPLOAD_ALLOW_SVG: z
    .string()
    .optional()
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
  /**
   * Use presigned POST (with an S3-enforced content-length-range) instead of presigned PUT
   * for direct client uploads. On by default; the response carries `upload_method` and,
   * for POST, the policy `fields` clients must submit with the file.
   */
  UPLOAD_USE_PRESIGNED_POST: booleanString('true'),
  /**
   * Per-user cap on concurrent PENDING uploads (rows awaiting confirm). Stops a single
   * authenticated user from exhausting storage by repeatedly requesting presigned URLs
   * and never calling confirm. Reconciled lazily by the PENDING sweeper worker. Default 100.
   */
  UPLOAD_MAX_PENDING_PER_USER: z.coerce.number().int().min(1).default(100),
  /**
   * Per-organization cap on concurrent PENDING uploads across ALL members
   * (sec-UP4). Without this, a 200-member org sitting at the per-user cap
   * could mint 20,000 in-flight uploads — ~200 GB per org at the 10 MB
   * default limit. Default 2000 (4× expected 500-member org × 4 in-flight).
   * The PENDING sweeper reconciles eventually.
   */
  UPLOAD_MAX_PENDING_PER_ORGANIZATION: z.coerce.number().int().min(1).max(100_000).default(2_000),
  /**
   * Per-statement timeout (ms) for worker context wrappers (retention,
   * GDPR export, DLQ scans, etc.) — separate from the HTTP timeout so
   * background jobs scanning large tables are not killed at the 5 s cap
   * the HTTP path uses (sec-D2). Default 5 minutes — large enough for
   * cascading FK deletes / audit scans, small enough to prevent runaway
   * queries holding pool checkouts indefinitely.
   */
  DATABASE_WORKER_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(300_000),
  S3_BUCKET: z.string().min(1).optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** AWS SDK maxAttempts for S3 (each attempt bounded by service/client timeouts). */
  S3_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  /**
   * Per-attempt socket-inactivity timeout (ms) for S3 requests, so a stalled S3 call can't hang a
   * worker or request indefinitely. Bounds each of the `S3_MAX_ATTEMPTS` attempts.
   */
  S3_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  /** TCP connection-establishment timeout (ms) for S3 requests. */
  S3_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(500).max(60000).default(5000),
  /**
   * Custom S3-compatible endpoint (MinIO / Cloudflare R2 / LocalStack) for local dev or non-AWS
   * storage. Unset in production → the AWS SDK targets the standard AWS S3 endpoint for `S3_REGION`.
   * Both API calls and presigned URLs sign against this endpoint automatically when set.
   */
  S3_ENDPOINT: z.url().optional(),
  /**
   * Force path-style S3 addressing (`<endpoint>/<bucket>/<key>` instead of virtual-hosted
   * `<bucket>.<endpoint>/<key>`). Most S3-compatible endpoints (MinIO, LocalStack) require it;
   * ignored unless `S3_ENDPOINT` is set.
   */
  S3_FORCE_PATH_STYLE: booleanString('false'),
  /**
   * audit-#13: public base URL (e.g. a CloudFront distribution) for PUBLIC media only
   * (avatars, organization logos). When set, `getObjectUrl` builds links from this base instead
   * of the raw `https://<bucket>.s3.<region>.amazonaws.com/<key>` form, so the S3 bucket can keep
   * "Block all public access" enabled (the documented production posture) while public media is
   * still reachable through a distribution scoped to the public prefixes. Leave unset in local/dev
   * to fall back to the direct S3 URL. NEVER point this at a base that exposes private prefixes
   * (`user-files/`, `organization-files/`) — `getObjectUrl` additionally refuses non-public keys.
   */
  PUBLIC_MEDIA_BASE_URL: z.url().optional(),

  // Ops knobs
  /** BullMQ worker concurrency fallback when per-queue overrides are unset (default 4). */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  WORKER_CONCURRENCY_MAIL: z.coerce.number().int().min(1).max(20).optional(),
  WORKER_CONCURRENCY_NOTIFY: z.coerce.number().int().min(1).max(20).optional(),
  WORKER_CONCURRENCY_WEBHOOK: z.coerce.number().int().min(1).max(20).optional(),
  WORKER_CONCURRENCY_STRIPE: z.coerce.number().int().min(1).max(20).optional(),
  /** HTTP port for worker GET /livez, /readyz, and optional /metrics (default 9090). */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(9090),
  /** Max age of throughput queue heartbeats before /readyz returns 503 (default 5 min). */
  WORKER_HEALTH_STALL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(3_600_000)
    .default(300_000),
  /**
   * Comma-separated BullMQ queue families this worker process runs: `mail`, `notify`,
   * `webhook`, `stripe`, `retention`, `observability`, or `all` (default monolithic worker).
   * Use split services in production so each process pool budget matches its registered workers.
   */
  WORKER_QUEUE_FAMILIES: z.string().min(1).default('all'),
  /**
   * Postgres pool size per Node process (postgres-js `max`). Not the cluster-wide total. Default 20.
   *
   * Each HTTP request runs in its own RLS transaction holding one pooled connection for its
   * duration, so the pool size is the per-process in-flight DB concurrency ceiling. The default
   * was raised 10 → 20 to lift that ceiling under burst; the cluster-wide budget
   * `(api + worker replicas) × DATABASE_POOL_MAX ≤ max_connections − reserved` is still enforced
   * fail-closed at boot by `assertPostgresConnectionBudget`. Raise further on larger Postgres
   * instances; see docs/deployment/runbooks/resource-limits.md.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(20),
  /** Connections reserved for admin, migrations, and monitoring (subtracted from Postgres max_connections). */
  POSTGRES_RESERVED_CONNECTIONS: z.coerce.number().int().min(1).default(10),
  /** Override when SHOW max_connections is unavailable or wrong (e.g. behind pooler). */
  POSTGRES_MAX_CONNECTIONS: z.coerce.number().int().min(1).optional(),
  /** Shorthand: api_replicas + worker_replicas. Used when split counts (API/WORKER) are not set. */
  DEPLOYMENT_TOTAL_REPLICA_COUNT: z.coerce.number().int().min(1).optional(),
  /** API service replica count for the Postgres connection budget. */
  DEPLOYMENT_API_REPLICA_COUNT: z.coerce.number().int().min(1).optional(),
  /** Worker service replica count for the Postgres connection budget. */
  DEPLOYMENT_WORKER_REPLICA_COUNT: z.coerce.number().int().min(1).optional(),
  /** postgres-js `idle_timeout` (seconds). */
  DATABASE_POOL_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(1).optional(),
  /** postgres-js `connect_timeout` (seconds). */
  DATABASE_POOL_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).optional(),
  /** postgres-js `max_lifetime` (seconds). */
  DATABASE_POOL_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(60).optional(),
  /** Per-connection statement_timeout (ms). Caps runaway queries; 0 disables. Default: 30000. */
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).optional(),
  /**
   * Connection-level statement_timeout (ms) for HTTP handlers. Scoped RLS contexts hold
   * checkouts only for the unit-of-work, so this caps runaway autocommit queries. Default: 5000.
   * 0 falls back to `DATABASE_STATEMENT_TIMEOUT_MS`.
   */
  DATABASE_HTTP_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(5_000),
  /**
   * Per-connection idle_in_transaction_session_timeout (ms). Caps a transaction that opened,
   * stalled, and still holds its pooled connection. Default: 30000.
   *
   * Minimum 1000 — unlike the statement timeouts, 0 is NOT accepted here. Postgres reads 0 as
   * "no bound", so a single misconfiguration would silently remove the only ceiling on an
   * abandoned transaction, with nothing failing at boot to say so.
   */
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).optional(),
  /**
   * Per-connection lock_timeout (ms). Caps how long a statement waits for someone else's lock
   * before failing. Default: 3000.
   *
   * Distinct from the other two timeouts and NOT substitutable: a statement blocked on a lock is
   * neither idle (so `idle_in_transaction_session_timeout` never fires) nor executing (so
   * `statement_timeout` has nothing to cut short) — yet it holds its pooled connection for the
   * whole wait. Without a bound, concurrent waiters on one row convert lock contention directly
   * into pool exhaustion. Minimum 1000; 0 ("wait forever") is deliberately not accepted.
   */
  DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(3_000),
  /**
   * Per-transaction lock_timeout (ms) for WORKER contexts. Default: 30000.
   *
   * The connection-level `DATABASE_LOCK_TIMEOUT_MS` is tuned for HTTP, where a caller is waiting
   * and the statement budget is 5s anyway. Background work has a 5-minute statement budget
   * (`DATABASE_WORKER_STATEMENT_TIMEOUT_MS`) and retries safely, so giving up on a lock after 3s
   * is needlessly impatient — it converts contention into DLQ churn. Applied with `SET LOCAL`
   * alongside the worker statement timeout, so it lifts the HTTP-tuned cap for that transaction
   * only. Mirrors the `HTTP vs WORKER` split already used for `statement_timeout`.
   */
  DATABASE_WORKER_LOCK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  /** Warn when in-process org RLS checkouts reach this fraction of DATABASE_POOL_MAX (default 0.8). */
  DATABASE_POOL_ACTIVE_WARN_RATIO: z.coerce.number().min(0).max(1).default(0.8),
  /** Critical alert when in-process org RLS checkouts reach this fraction of DATABASE_POOL_MAX (default 0.95). */
  DATABASE_POOL_ACTIVE_CRITICAL_RATIO: z.coerce.number().min(0).max(1).default(0.95),
  /** Warn when cluster-wide active connections (pg_stat_activity) reach this fraction of allowed budget. */
  DATABASE_POOL_CLUSTER_WARN_RATIO: z.coerce.number().min(0).max(1).default(0.8),
  /** Critical cluster pool pressure ratio (default 0.95). */
  DATABASE_POOL_CLUSTER_CRITICAL_RATIO: z.coerce.number().min(0).max(1).default(0.95),
  /** Poll interval for pool exhaustion sampling and optional Prometheus gauges (ms). Default: 5000. */
  DATABASE_POOL_ALERT_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .default(5_000),
  /** Consecutive over-threshold polls before emitting pool exhaustion alerts (default 2). */
  DATABASE_POOL_ALERT_CONSECUTIVE_POLLS: z.coerce.number().int().min(1).max(10).default(2),
  /** Enable Postgres TLS by default. Set false only for plaintext local Docker/test databases. */
  DATABASE_SSL_ENABLED: booleanString('true'),
  /**
   * When true, Postgres client verifies server TLS certificate (strict). Ignored when
   * `DATABASE_URL` uses `sslmode=verify-ca|verify-full` (always strict).
   *
   * @remarks Parses `"true"`/`"1"` as `true` and everything else as `false`. Uses an explicit
   * transform — NOT `z.coerce.boolean()`, which is `Boolean(String)` and silently treats
   * `"false"`/`"0"` as `true` (the same foot-gun as DLQ_AUTO_RETRY_ENABLED — sec-C1).
   */
  DATABASE_SSL_REJECT_UNAUTHORIZED: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true' || value === '1')),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).optional(),

  // Data retention (days to keep audit logs / revoked sessions before cleanup)
  /**
   * sec-U10: cap retention at 2 years and default to 1 year. The previous
   * `min(1)` with no max + no default meant a typo (365 → 36500) silently
   * disabled retention; once audit.logs is unbounded the table becomes the
   * largest in the DB and trips autovacuum / search-path bloat thresholds.
   */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(730).default(365),
  /**
   * audit-#14: every retention knob carries a defensible MAX as well as a min. Without an
   * upper bound a deployment typo (e.g. `90` → `90000`) silently disables cleanup, so the
   * high-volume tables (notifications, sessions, tombstones, Stripe ledger, webhook attempts)
   * grow unbounded, retain PII far beyond policy, and eventually degrade autovacuum + query
   * performance. Exceptional longer retention must be a reviewed policy/migration change, not
   * an arbitrary env value.
   */
  NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  AUTH_SESSION_RETENTION_DAYS: z.coerce.number().int().min(1).max(730).default(30),
  /** Tombstoned-row TTL before purge workers hard-delete (default avoids mandatory deploy secret). */
  TOMBSTONE_RETENTION_DAYS: z.coerce.number().int().min(1).max(730).default(90),
  /** Terminal Stripe webhook ledger rows older than this are purged (failed rows kept for replay). */
  STRIPE_WEBHOOK_EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(730).default(90),
  /**
   * Webhook delivery-attempt rows older than this are purged (audit-#3). These rows retain the
   * full event payload + response body, so a shorter default than tombstone retention bounds both
   * storage growth and PII retention for long-lived active webhooks. Capped at 180 days
   * (audit-#14) so a misconfiguration cannot retain payloads/response bodies indefinitely.
   */
  WEBHOOK_DELIVERY_ATTEMPT_RETENTION_DAYS: z.coerce.number().int().min(1).max(180).default(30),

  // BullMQ repeatable jobs (retention / cleanup schedules)
  SCHEDULER_ENABLED: z
    .string()
    .optional()
    .default('true')
    .transform((value) => value !== 'false' && value !== '0'),
  /** Interpret cron patterns in this IANA timezone; omit for server default. */
  SCHEDULER_TIMEZONE: z.string().min(1).optional(),
  AUDIT_RETENTION_CRON: z.string().min(1).optional(),
  NOTIFICATION_RETENTION_CRON: z.string().min(1).optional(),
  AUTH_SESSION_CLEANUP_CRON: z.string().min(1).optional(),
  STRIPE_WEBHOOK_EVENT_RETENTION_CRON: z.string().min(1).optional(),
  /** Cron for the webhook delivery-attempt retention sweep (audit-#3); omit to use the default. */
  WEBHOOK_DELIVERY_ATTEMPT_RETENTION_CRON: z.string().min(1).optional(),
  STRIPE_WEBHOOK_EVENT_RECLAIM_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  STRIPE_WEBHOOK_EVENT_RECLAIM_CRON: z.string().min(1).optional(),
  /** Lookback window (minutes) for the Stripe catch-up worker's `events.list` poll. */
  STRIPE_WEBHOOK_EVENT_CATCHUP_WINDOW_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  /** Max events fetched per Stripe catch-up `events.list` page (Stripe caps at 100). */
  STRIPE_WEBHOOK_EVENT_CATCHUP_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  /** Cron for the Stripe catch-up sweep; omit to use the default (every 15 min). */
  STRIPE_WEBHOOK_EVENT_CATCHUP_CRON: z.string().min(1).optional(),
  /** Daily audit cold export to S3 (disabled when S3_BUCKET unset). */
  AUDIT_EXPORT_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform((value) => value === 'true' || value === '1'),
  AUDIT_EXPORT_S3_PREFIX: z.string().min(1).default('audit/export'),
  AUDIT_EXPORT_BATCH_SIZE: z.coerce.number().int().min(100).max(50_000).default(5_000),
  AUDIT_EXPORT_CRON: z.string().min(1).optional(),
  MAIL_OUTBOX_SWEEP_PENDING_MINUTES: z.coerce.number().int().min(1).default(15),
  /**
   * Minimum age (minutes) before a row stuck in `sending` is reclaimed to
   * `pending`. Must sit comfortably above worst-case Resend delivery time
   * (BullMQ retry/backoff + circuit cooldown) so a still-in-flight send is not
   * reclaimed prematurely; Resend idempotency keys de-duplicate any overlap.
   */
  MAIL_OUTBOX_RECLAIM_SENDING_MINUTES: z.coerce.number().int().min(1).default(30),
  MAIL_OUTBOX_SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  MAIL_OUTBOX_SWEEPER_CRON: z.string().min(1).optional(),
  WEBHOOK_TOMBSTONE_RETENTION_CRON: z.string().min(1).optional(),
  ORGANIZATION_NOTIFICATION_POLICY_TOMBSTONE_RETENTION_CRON: z.string().min(1).optional(),
  USER_TOMBSTONE_RETENTION_CRON: z.string().min(1).optional(),
  ORGANIZATION_TOMBSTONE_RETENTION_CRON: z.string().min(1).optional(),
  MEMBERSHIP_TOMBSTONE_RETENTION_CRON: z.string().min(1).optional(),
  MEMBER_ROLE_TOMBSTONE_RETENTION_CRON: z.string().min(1).optional(),
  ORGANIZATION_API_KEY_TOMBSTONE_RETENTION_CRON: z.string().min(1).optional(),
  UPLOAD_TOMBSTONE_RETENTION_CRON: z.string().min(1).optional(),
  /** sec-new-Q1: cron override for GDPR export artifact purge. */
  USER_DATA_EXPORT_RETENTION_CRON: z.string().min(1).optional(),
  /** Cron for the PENDING upload sweeper (auto-confirm matches, hard-delete orphans). */
  UPLOAD_PENDING_SWEEP_CRON: z.string().min(1).optional(),
  /**
   * Extra grace beyond `PRESIGNED_URL_EXPIRY_SECONDS` before a PENDING upload row becomes
   * eligible for sweeping. Prevents reconciling rows whose presigned URL has only just
   * expired and whose client confirm call is still in flight. Default 1 hour.
   */
  UPLOAD_PENDING_SWEEP_GRACE_SECONDS: z.coerce.number().int().min(60).default(3600),

  /**
   * P0-#2 audit outbox drain — rows claimed per drain pass. Higher values amortise
   * resolution lookups but increase per-pass duration; the worker's `lockDuration`
   * (default 30s) is the hard upper bound. Default 500 keeps a typical pass under
   * a second on a small DB and well under the lock window.
   */
  AUDIT_OUTBOX_DRAIN_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).optional(),
  /**
   * P0-#2 audit outbox drain — per-row attempt cap. After this many failed drain
   * attempts the row is marked `FAILED` for operator triage. Default 5 mirrors
   * BullMQ default attempts on side-effecting jobs.
   */
  AUDIT_OUTBOX_DRAIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).optional(),
  /** Cron pattern for the audit-outbox drain. Default every 30 seconds. */
  AUDIT_OUTBOX_DRAIN_CRON: z.string().min(1).optional(),

  /** Bounded SCAN cap for idempotency Redis key cardinality sampling (worker). */
  IDEMPOTENCY_CARDINALITY_SCAN_MAX: z.coerce.number().int().min(1).default(200_000),
  IDEMPOTENCY_CARDINALITY_WARN_THRESHOLD: z.coerce.number().int().min(1).default(50_000),
  IDEMPOTENCY_CARDINALITY_CRITICAL_THRESHOLD: z.coerce.number().int().min(1).default(200_000),
  IDEMPOTENCY_CARDINALITY_CRON: z.string().min(1).optional(),

  /**
   * P0-#4: per-actor (user / API key) idempotency-key claim cap over
   * {@link IDEMPOTENCY_PER_ACTOR_CAP_WINDOW_SECONDS}. A single misbehaving client sending
   * unique keys per request would otherwise fill Redis with ~24h-lived entries. When an
   * actor exceeds this cap inside the window, new claims respond 429 with `Retry-After`;
   * cached replays of already-completed work are unaffected (they hit before this check).
   * Default 1_000/hour leaves headroom for legitimate retry storms while bounding the
   * worst-case memory footprint per actor to ~10 MB / hour.
   */
  IDEMPOTENCY_PER_ACTOR_CAP: z.coerce.number().int().min(1).default(1_000),
  IDEMPOTENCY_PER_ACTOR_CAP_WINDOW_SECONDS: z.coerce.number().int().min(60).default(3_600),

  /** Alert when a dead-letter queue has at least this many waiting + failed jobs. */
  DLQ_DEPTH_WARN_THRESHOLD: z.coerce.number().int().min(1).default(10),
  DLQ_DEPTH_CRON: z.string().min(1).optional(),

  /**
   * When true, the `dlq-auto-retry` sweeper re-enqueues replayable ledger rows after cooldown.
   *
   * @remarks Uses the shared `booleanString('true')` helper so operator-facing kill-switches
   * actually work: `"false"`/`"0"` parses to `false`. Previously used `z.coerce.boolean()`
   * which is `Boolean(String)` and turns every non-empty string (including `"false"`) into
   * `true` — operators trying to disable the sweeper during an incident found it kept firing
   * (sec-C1).
   */
  DLQ_AUTO_RETRY_ENABLED: booleanString('true'),
  /** Maximum automated replays per `audit.dead_letter_jobs` row (Redis counter). */
  DLQ_AUTO_RETRY_MAX_COUNT: z.coerce.number().int().min(0).default(3),
  /** Minimum minutes between failure (or last auto-retry) and the next automated replay. */
  DLQ_AUTO_RETRY_COOLDOWN_MINUTES: z.coerce.number().int().min(1).default(30),
  /** Maximum ledger rows inspected per sweeper tick. */
  DLQ_AUTO_RETRY_BATCH_SIZE: z.coerce.number().int().min(1).default(20),
  DLQ_AUTO_RETRY_CRON: z.string().min(1).optional(),
  /** sec-new-Q1: cron override for the commit-dispatch recovery sweep. */
  COMMIT_DISPATCH_RECOVERY_CRON: z.string().min(1).optional(),

  /**
   * Alert when a single BullMQ source queue's waiting + delayed backlog reaches this many
   * jobs. A growing backlog (e.g. a worker outage) on a shared Redis can fill memory and,
   * with `maxmemory-policy=noeviction`, reject the write-critical store — so the backlog is
   * sampled alongside DLQ depth. See docs/deployment/runbooks/redis-topology.md.
   */
  QUEUE_WAITING_DEPTH_WARN_THRESHOLD: z.coerce.number().int().min(1).default(1000),
  /**
   * Warn / critical `used_memory / maxmemory` ratios for the cache Redis (0–1). The
   * observability tick samples `INFO memory` + `CONFIG GET maxmemory`; a high ratio under
   * `noeviction` means writes (idempotency/rate-limit) are about to start failing.
   * Skipped when Redis reports `maxmemory=0` (unbounded).
   */
  REDIS_MEMORY_WARN_RATIO: z.coerce.number().min(0).max(1).default(0.85),
  REDIS_MEMORY_CRITICAL_RATIO: z.coerce.number().min(0).max(1).default(0.95),
  ENABLE_QUEUE_DASHBOARD: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /**
   * When false, Bull Board mutation APIs return 403; GET remains available.
   * Enable explicitly for trusted local/admin-only environments.
   */
  ENABLE_QUEUE_DASHBOARD_MUTATIONS: booleanString('false'),

  // CAPTCHA (Cloudflare Turnstile on public auth routes)
  /** `turnstile` enforces X-Captcha-Token; `disabled` skips verification. */
  CAPTCHA_PROVIDER: z.enum(['turnstile', 'disabled']).default('disabled'),
  /** Turnstile secret key — required when CAPTCHA_PROVIDER=turnstile. */
  CAPTCHA_SECRET: z.string().min(1).optional(),
  // CAPTCHA_SITE_KEY is intentionally NOT in this schema: it is the public Turnstile widget key,
  // used only by the browser. Provisioning writes it to `.env.<environment>` and surfaces it to core-fe.
  /**
   * Dev/test only: request header name that bypasses CAPTCHA when value is true/1.
   * Ignored in production.
   */
  CAPTCHA_BYPASS_HEADER: z.string().min(1).optional(),

  // MCP server (Model Context Protocol) at POST /api/v1/mcp — exposes APIs as tools for frontends/agents
  ENABLE_MCP_SERVER: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  // R14: the `call_api` MCP tool is an admin-authority in-process API proxy. It defaults to
  // READ-ONLY (GET); set this to allow mutating methods (POST/PATCH/PUT/DELETE). Off by default
  // so enabling MCP cannot, on its own, expose destructive admin mutations through the tool.
  MCP_CALL_API_ALLOW_MUTATIONS: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  // R14: optional operator allowlist of path prefixes the `call_api` tool may target (CSV). When
  // unset/empty the existing `/api/v1/` (+ /livez, /readyz) gate applies; when set, the path must
  // ALSO match one of these prefixes — a defense-in-depth narrowing of the admin proxy's reach.
  MCP_CALL_API_ALLOWED_PATH_PREFIXES: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
        : [],
    ),
  ENABLE_API_REFERENCE: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /**
   * Deliberate override (audit #7) allowing the unauthenticated `/reference` UI in production.
   * Off by default; the cross-field refine on {@link envSchema} rejects
   * `ENABLE_API_REFERENCE=true` in production unless this is also set.
   */
  API_REFERENCE_ALLOW_PRODUCTION: booleanString('false'),
  /**
   * Deliberate override (re-audit A1) allowing the Bull-Board queue dashboard (`/admin/queues`)
   * in production. Off by default; the cross-field refine on {@link envSchema} rejects
   * `ENABLE_QUEUE_DASHBOARD=true` in production unless this is also set. The dashboard is still
   * SUPER_ADMIN-gated at runtime — this is a boot-time safety net so the protection does not rest
   * solely on a single preHandler wiring.
   */
  QUEUE_DASHBOARD_ALLOW_PRODUCTION: booleanString('false'),
  OPENAPI_SPEC_PATH: z.string().min(1).optional(),

  // Organization capability flags — toggle the two organization kinds independently so one
  // codebase serves a B2C (personal-only), B2B (team-only), or hybrid product. At least one
  // MUST be enabled (enforced in the cross-field refine on envSchema). They gate route
  // registration, signup auto-provisioning, and the organization switcher — never the core
  // scoping path (token claim → RLS), which is identical in every mode.
  PERSONAL_ORGANIZATION_ENABLED: booleanString('true'),
  TEAM_ORGANIZATION_ENABLED: booleanString('true'),
  /** Per-owner cap on TEAM organizations a single user may create (anti-abuse). Personal exempt. */
  MAX_TEAM_ORGANIZATIONS_PER_OWNER: z.coerce.number().int().min(1).max(1000).default(20),

  // Response encryption (obfuscation layer — AES-256-GCM; hides JSON from DevTools Network tab)
  ENABLE_RESPONSE_ENCRYPTION: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  RESPONSE_ENCRYPTION_KEY: z.string().length(64).optional(), // 64 hex chars = 32 bytes for AES-256
  /**
   * Optional version→hex keyring (JSON object, e.g. `{"v1":"<hex>","v2":"<hex>"}`) enabling
   * zero-downtime rotation of the response-encryption key. Each envelope carries its `kid`, so the
   * client decrypts with the matching key; unset preserves the single `RESPONSE_ENCRYPTION_KEY`
   * (`v1`) path exactly.
   */
  RESPONSE_ENCRYPTION_KEYS: z.string().min(1).optional(),
  /**
   * Response-encryption version used when ENCRYPTING responses (default `v1`). Decryption is keyed by
   * the envelope's own `kid`, so this only selects the write key during a keyring rotation.
   */
  RESPONSE_ENCRYPTION_CURRENT_VERSION: z.enum(['v1', 'v2']).optional().default('v1'),
  /** AES-256-GCM key for MFA/webhook secrets at rest (64 hex chars). Required in every runtime. */
  SECRETS_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'SECRETS_ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  /**
   * Optional version→hex keyring (JSON object, e.g. `{"v1":"<hex>","v2":"<hex>"}`) enabling
   * zero-downtime rotation of field-secret encryption keys. Stored values decrypt by their own
   * version prefix; unset preserves the single `SECRETS_ENCRYPTION_KEY` (`v1`) path exactly.
   */
  SECRETS_ENCRYPTION_KEYS: z.string().min(1).optional(),
  /**
   * Field-secret version used when ENCRYPTING new secrets (default `v1`). Decryption always uses
   * the stored value's own version prefix, so this only selects the write key during rotation.
   */
  SECRETS_ENCRYPTION_CURRENT_VERSION: z.enum(['v1', 'v2']).optional().default('v1'),

  // Monthly database restore drill (GitHub Actions only — not loaded by API/worker at runtime)
  /** Neon API key for scheduled monthly PITR restore drill. GitHub Environment secret via `pnpm github:sync`. */
  MONTHLY_DATABASE_RESTORE_DRILL_NEON_API_KEY: z.string().min(1).optional(),

  // Railway deploy (GitHub Actions only — consumed by .github/workflows/reusable-railway-deploy.yml)
  /** Railway project token used by the deploy job to call `railway redeploy`. GitHub Environment secret via `pnpm github:sync`. */
  RAILWAY_TOKEN: z.string().min(1).optional(),
  /** Railway API service ID for the API service (target of `railway redeploy --service`). */
  RAILWAY_SERVICE_ID: z.string().min(1).optional(),
  /** Railway worker service ID for the worker service (target of `railway redeploy --service`). */
  RAILWAY_WORKER_SERVICE_ID: z.string().min(1).optional(),

  // Postman API documentation publishing (GitHub Actions only — consumed by .github/workflows/reusable-openapi-postman-publish.yml and `pnpm docs:upload`)
  /** Postman API key used by `pnpm docs:upload` to push the generated collection. GitHub Environment secret via `pnpm github:sync`. */
  POSTMAN_API_KEY: z.string().min(1).optional(),
  /** Postman workspace ID where the API documentation collection is published. GitHub Environment secret via `pnpm github:sync`. */
  POSTMAN_WORKSPACE_ID: z.string().min(1).optional(),

  // Scalar Registry API documentation publishing (GitHub Actions only — consumed by
  // .github/workflows/reusable-openapi-postman-publish.yml and `pnpm docs:upload:scalar`).
  // Secret vs Variable follows github:sync `classifyKey`: only the API key is sensitive
  // (Secret, read via `secrets.SCALAR_API_KEY`); the namespace/slug are public registry
  // identifiers (Variables, read via `vars.SCALAR_NAMESPACE` / `vars.SCALAR_SLUG`). The
  // workflow's `secrets.*` vs `vars.*` access MUST match this split.
  /** Scalar API key used by `pnpm docs:upload:scalar` to publish the OpenAPI document to the Scalar Registry. Sensitive → GitHub Environment Secret (read via `secrets.SCALAR_API_KEY`); pushed by `pnpm github:sync`. */
  SCALAR_API_KEY: z.string().min(1).optional(),
  /** Scalar team namespace the OpenAPI document is published under (registry URL `@<namespace>/apis/<slug>`). Non-sensitive → GitHub Environment Variable (read via `vars.SCALAR_NAMESPACE`); pushed by `pnpm github:sync`. */
  SCALAR_NAMESPACE: z.string().min(1).optional(),
  /** Scalar Registry slug for the published OpenAPI document; the upload script defaults to the project slug when unset. Non-sensitive → GitHub Environment Variable (read via `vars.SCALAR_SLUG`); pushed by `pnpm github:sync`. */
  SCALAR_SLUG: z.string().min(1).optional(),

  // Release automation (GitHub Actions only — consumed by .github/workflows/post-merge-ci.yml)
  /** PAT (classic `repo` + `workflow` scopes) release-please uses to create the dev/main GitHub Releases; the default GITHUB_TOKEN cannot — the create-a-release API path requires the `workflow` scope. GitHub Environment secret via `pnpm github:sync`. */
  RELEASE_PLEASE_TOKEN: z.string().min(1).optional(),

  // Local code-quality gate (SonarQube) — local tooling only, never read by the API/worker
  // runtime. Consumed solely by the `pnpm sonar:*` scripts that drive the local SonarQube
  // container for the pre-commit / pre-push quality gate. Declared here (always `.optional()`)
  // so the schema ↔ `.env.example` invariant holds and these keys validate as known config
  // rather than tripping the "extra key" check; they carry no per-environment requirement.
  /** Local SonarQube user token for `pnpm sonar:scan`. Local tooling only — leave empty in hosted environments. */
  SONAR_TOKEN: z.string().min(1).optional(),
  /** Local SonarQube container admin password for `pnpm sonar:*`. Local tooling only — leave empty in hosted environments. */
  SONAR_ADMIN_PASSWORD: z.string().min(1).optional(),
});

/**
 * Process environment Zod schema. Refines `envSchemaBase` with cross-field invariants
 * (idempotency threshold ordering, METRICS_ENABLED → token, CAPTCHA configuration,
 * production Turnstile requirement, Redis topology, and FRONTEND_URL protocol) so
 * the API/worker boot fails fast on misconfiguration instead of surfacing partial
 * failures at runtime.
 */
export const envSchema = envSchemaBase
  .refine(
    (data) =>
      data.IDEMPOTENCY_CARDINALITY_CRITICAL_THRESHOLD >=
      data.IDEMPOTENCY_CARDINALITY_WARN_THRESHOLD,
    {
      message:
        'IDEMPOTENCY_CARDINALITY_CRITICAL_THRESHOLD must be >= IDEMPOTENCY_CARDINALITY_WARN_THRESHOLD',
      path: ['IDEMPOTENCY_CARDINALITY_CRITICAL_THRESHOLD'],
    },
  )
  .refine((data) => data.REDIS_MEMORY_CRITICAL_RATIO >= data.REDIS_MEMORY_WARN_RATIO, {
    message: 'REDIS_MEMORY_CRITICAL_RATIO must be >= REDIS_MEMORY_WARN_RATIO',
    path: ['REDIS_MEMORY_CRITICAL_RATIO'],
  })
  .refine((data) => data.PERSONAL_ORGANIZATION_ENABLED || data.TEAM_ORGANIZATION_ENABLED, {
    message:
      'At least one of PERSONAL_ORGANIZATION_ENABLED or TEAM_ORGANIZATION_ENABLED must be true — a deployment needs at least one organization kind.',
    path: ['PERSONAL_ORGANIZATION_ENABLED'],
  })
  .refine(
    (data) => {
      if (data.METRICS_ENABLED) {
        return Boolean(data.METRICS_SCRAPE_TOKEN && data.METRICS_SCRAPE_TOKEN.length >= 32);
      }
      return true;
    },
    {
      message: 'When METRICS_ENABLED=true, METRICS_SCRAPE_TOKEN (min 32 chars) is required',
      path: ['METRICS_SCRAPE_TOKEN'],
    },
  )
  .refine(
    (data) => {
      if (data.CAPTCHA_PROVIDER === 'turnstile') {
        return Boolean(data.CAPTCHA_SECRET);
      }
      return true;
    },
    {
      message: 'CAPTCHA_SECRET is required when CAPTCHA_PROVIDER=turnstile',
      path: ['CAPTCHA_SECRET'],
    },
  )
  .refine(
    (data) => {
      if (data.NODE_ENV !== 'production') {
        return true;
      }
      return data.CAPTCHA_PROVIDER === 'turnstile' && Boolean(data.CAPTCHA_SECRET);
    },
    {
      message:
        'In production, CAPTCHA_PROVIDER=turnstile and CAPTCHA_SECRET are required on public auth routes',
      path: ['CAPTCHA_PROVIDER'],
    },
  )
  .refine(
    (data) => {
      // sec-r4-C3: production requires encryption-at-rest. A low-entropy key (e.g. the all-zero
      // .env.example template) would silently defeat encryption of MFA TOTP seeds and webhook
      // signing secrets for a deployed environment.
      if (data.NODE_ENV !== 'production') {
        return true;
      }
      // Reject placeholder / low-entropy keys (e.g. the all-zero .env.example template) that
      // would silently defeat encryption-at-rest for MFA TOTP seeds and webhook signing secrets.
      // A real `openssl rand -hex 32` key effectively always contains far more than 8 distinct
      // hex digits, while all-zeros / single-character placeholders contain one.
      return new Set(data.SECRETS_ENCRYPTION_KEY.toLowerCase()).size >= 8;
    },
    {
      message:
        'In production, SECRETS_ENCRYPTION_KEY must be a high-entropy 32-byte key (generate with `openssl rand -hex 32`); placeholder/low-entropy values are rejected',
      path: ['SECRETS_ENCRYPTION_KEY'],
    },
  )
  .refine(
    (data) => {
      return validateProductionRedisTopology(data.REDIS_URL, data.REDIS_BULLMQ_URL);
    },
    {
      message:
        'REDIS_BULLMQ_URL, when set, must be a valid redis:// or rediss:// URL (a dedicated BullMQ endpoint is supported; see docs/deployment/runbooks/redis-topology.md)',
      path: ['REDIS_BULLMQ_URL'],
    },
  )
  .refine(
    (data) => {
      /**
       * `FRONTEND_URL` must be a valid http(s) URL whenever it is set. The previous
       * localhost-only restriction for non-production environments existed because
       * the magic-link service inlined the raw token in API responses outside
       * production. That leak has been removed (see `magic-link.service.ts`), so
       * any deployed environment may now use a real public `FRONTEND_URL`.
       */
      if (!data.FRONTEND_URL) {
        return true;
      }
      try {
        const parsed = new URL(data.FRONTEND_URL);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    {
      message: 'FRONTEND_URL must be a valid http(s) URL.',
      path: ['FRONTEND_URL'],
    },
  )
  .refine(
    (data) => {
      const origins = data.ALLOWED_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
      // A literal `*` would make CORS reflect any origin and silently defeat the
      // session-cookie Origin/Referer checks — never allow it as an entry.
      if (origins.includes('*')) {
        return false;
      }
      // sec-r4-C1: production requires absolute https origins — plaintext http origins would weaken
      // the session-cookie Origin defense on a deployed environment.
      if (data.NODE_ENV !== 'production') {
        return true;
      }
      // In production every origin must be an absolute https:// URL.
      // Plaintext http origins would let cross-site requests ride over an
      // unencrypted channel and weaken the cookie-origin defenses that compare
      // against this allowlist.
      // sec-M9: ALSO reject entries that don't round-trip — a config that includes
      // userinfo (`https://attacker@allowed.com`), trailing slash, or any path is
      // an operator footgun: the runtime compares against browser-supplied `Origin`
      // (which strips all of these), so the entry silently never matches and the
      // origin gate fails closed against all requests instead of permitting the
      // intended host.
      return origins.every((origin) => {
        try {
          const parsed = new URL(origin);
          if (parsed.protocol !== 'https:') return false;
          if (parsed.username !== '' || parsed.password !== '') return false;
          if (parsed.pathname !== '' && parsed.pathname !== '/') return false;
          if (parsed.search !== '' || parsed.hash !== '') return false;
          // Round-trip check: parsed.origin canonicalises away trailing slashes;
          // require the input already match the canonical form so config drift is
          // surfaced loudly rather than silently broken.
          return parsed.origin === origin;
        } catch {
          return false;
        }
      });
    },
    {
      message:
        'ALLOWED_ORIGINS must not contain `*`; in production every entry must be an absolute https:// origin without userinfo, path, query, fragment, or trailing slash.',
      path: ['ALLOWED_ORIGINS'],
    },
  )
  .refine(
    (data) => {
      // When Resend is configured, EMAIL_FROM_ADDRESS must be set explicitly. There is no
      // hardcoded sender fallback: a default `from` on an unverified domain is silently
      // rejected by Resend, so auth mail (magic link, verification, invitations) never arrives.
      if (!data.RESEND_API_KEY) {
        return true;
      }
      return Boolean(data.EMAIL_FROM_ADDRESS);
    },
    {
      message: 'EMAIL_FROM_ADDRESS is required when RESEND_API_KEY is set.',
      path: ['EMAIL_FROM_ADDRESS'],
    },
  )
  .refine(
    (data) => {
      // sec-B finding #19: when Stripe is configured, EMAIL_FROM_ADDRESS must be set.
      // `buildStripeCustomerEmail` derives the customer-email domain from this value;
      // a missing setting previously fell back to `billing+<id>@invalid`, sending
      // Stripe receipts/dunning/refund notifications to a reserved-TLD address that
      // bounces permanently. Mirrors the Resend pairing above.
      if (!data.STRIPE_SECRET_KEY) {
        return true;
      }
      return Boolean(data.EMAIL_FROM_ADDRESS);
    },
    {
      message:
        'EMAIL_FROM_ADDRESS is required when STRIPE_SECRET_KEY is set — Stripe customer emails are derived from this address.',
      path: ['EMAIL_FROM_ADDRESS'],
    },
  )
  .refine((data) => data.COOKIE_SAMESITE !== 'none' || data.COOKIE_SECURE === true, {
    message:
      'COOKIE_SAMESITE=none requires COOKIE_SECURE=true — browsers reject a cross-site cookie without the Secure attribute.',
    path: ['COOKIE_SAMESITE'],
  })
  .refine(
    (data) => !data.OAUTH_GOOGLE_CLIENT_ID || Boolean(data.OAUTH_GOOGLE_REDIRECT_URI?.trim()),
    {
      // The fallback in google-oauth.provider.ts builds `${FRONTEND_URL}/auth/oauth/google/callback`,
      // which is not a route core-fe serves (it mounts `/callback`), and this API has no self-origin
      // variable to build its own callback from. Rather than invent one, require the value whenever
      // the provider is configured — a loud boot failure beats a silently wrong redirect that only
      // surfaces as a provider-side `redirect_uri_mismatch`.
      message:
        "OAUTH_GOOGLE_REDIRECT_URI is required when OAUTH_GOOGLE_CLIENT_ID is set — it must match the Google Cloud Console entry exactly and point at this API's /api/v1/auth/oauth/google/callback.",
      path: ['OAUTH_GOOGLE_REDIRECT_URI'],
    },
  )
  .refine(
    (data) => !data.OAUTH_GITHUB_CLIENT_ID || Boolean(data.OAUTH_GITHUB_REDIRECT_URI?.trim()),
    {
      message:
        "OAUTH_GITHUB_REDIRECT_URI is required when OAUTH_GITHUB_CLIENT_ID is set — it must match the GitHub App callback URL exactly and point at this API's /api/v1/auth/oauth/github/callback.",
      path: ['OAUTH_GITHUB_REDIRECT_URI'],
    },
  )
  .refine(
    (data) => {
      // `none` makes the Origin allowlist the primary CSRF control on the cookie-session route,
      // so it must be trustworthy in EVERY environment — not only where NODE_ENV says production.
      // The existing https rule below is production-gated, and a cross-site deployment need not be
      // NODE_ENV=production to be internet-facing.
      if (data.COOKIE_SAMESITE !== 'none') {
        return true;
      }
      return data.ALLOWED_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
        .every((origin) => {
          try {
            return new URL(origin).protocol === 'https:';
          } catch {
            return false;
          }
        });
    },
    {
      message:
        'COOKIE_SAMESITE=none requires every ALLOWED_ORIGINS entry to be an absolute https:// origin — the Origin allowlist is the primary CSRF control once the session cookie is cross-site.',
      path: ['ALLOWED_ORIGINS'],
    },
  )
  .refine(
    (data) => {
      // sec-r4-C2: in production, session + CSRF cookies must carry the Secure attribute so they
      // are never transmitted over plaintext HTTP. COOKIE_SECURE=false is only valid for local
      // plaintext loops (development).
      if (data.NODE_ENV !== 'production') {
        return true;
      }
      return data.COOKIE_SECURE === true;
    },
    {
      message: 'COOKIE_SECURE must be true in production (cookies sent over HTTPS only).',
      path: ['COOKIE_SECURE'],
    },
  )
  // ── Category-B environment constraints for the policy flags ────────────────
  // Runtime code no longer compares NODE_ENV; these refines are the single place that keeps a
  // security-critical flag from being overridden to an unsafe value in the wrong environment.
  .refine((data) => data.NODE_ENV !== 'production' || data.CAPTCHA_BYPASS_ALLOWED === false, {
    message:
      'CAPTCHA_BYPASS_ALLOWED must be false in production (captcha bypass is a dev/test affordance only).',
    path: ['CAPTCHA_BYPASS_ALLOWED'],
  })
  .refine((data) => data.NODE_ENV !== 'production' || data.SESSION_ORIGIN_CSRF_REQUIRED === true, {
    message:
      'SESSION_ORIGIN_CSRF_REQUIRED must be true in production (CSRF double-submit is required when the Origin header is absent).',
    path: ['SESSION_ORIGIN_CSRF_REQUIRED'],
  })
  .refine((data) => data.NODE_ENV !== 'production' || data.WEBHOOK_ALLOWLIST_REQUIRED === true, {
    message:
      'WEBHOOK_ALLOWLIST_REQUIRED must be true in production (an empty webhook allowlist would open an SSRF hole).',
    path: ['WEBHOOK_ALLOWLIST_REQUIRED'],
  })
  .refine((data) => data.NODE_ENV !== 'production' || data.METRICS_AUTH_REQUIRED === true, {
    message:
      'METRICS_AUTH_REQUIRED must be true in production (the worker /metrics endpoint must require a bearer token).',
    path: ['METRICS_AUTH_REQUIRED'],
  })
  .refine((data) => data.NODE_ENV !== 'production' || data.BLOCK_DISPOSABLE_EMAIL === true, {
    message:
      'BLOCK_DISPOSABLE_EMAIL must be true in production (disposable/temporary email domains are rejected on signup — the relaxed false is a dev/test affordance only).',
    path: ['BLOCK_DISPOSABLE_EMAIL'],
  })
  // Boot-time safety checks: each must stay enforced in production (former isHostedDeployment gate).
  .refine((data) => data.NODE_ENV !== 'production' || data.DATABASE_TLS_ENFORCED === true, {
    message:
      'DATABASE_TLS_ENFORCED must be true in production (the Postgres server certificate must be verified).',
    path: ['DATABASE_TLS_ENFORCED'],
  })
  .refine((data) => data.NODE_ENV !== 'production' || data.DATABASE_RLS_SAFETY_ENFORCED === true, {
    message:
      'DATABASE_RLS_SAFETY_ENFORCED must be true in production (a superuser/BYPASSRLS role silently disables tenant RLS).',
    path: ['DATABASE_RLS_SAFETY_ENFORCED'],
  })
  .refine(
    (data) => data.NODE_ENV !== 'production' || data.DATABASE_CONNECTION_BUDGET_ENFORCED === true,
    {
      message:
        'DATABASE_CONNECTION_BUDGET_ENFORCED must be true in production (deployment replica counts are required to validate the Postgres connection budget).',
      path: ['DATABASE_CONNECTION_BUDGET_ENFORCED'],
    },
  )
  .refine((data) => data.NODE_ENV !== 'production' || data.REDIS_TLS_ENFORCED === true, {
    message:
      'REDIS_TLS_ENFORCED must be true in production (plaintext redis:// to a public host must fail closed).',
    path: ['REDIS_TLS_ENFORCED'],
  })
  .refine((data) => data.NODE_ENV !== 'production' || data.TRUST_PROXY_REQUIRED === true, {
    message:
      'TRUST_PROXY_REQUIRED must be true in production (without a trusted proxy hop every client collapses to the proxy IP).',
    path: ['TRUST_PROXY_REQUIRED'],
  })
  .refine((data) => data.NODE_ENV !== 'production' || data.TEST_MODE === false, {
    message:
      'TEST_MODE must be false in production (it gates test-only affordances that must never be reachable on a deployed runtime).',
    path: ['TEST_MODE'],
  })
  .refine(
    (data) => data.NODE_ENV !== 'production' || data.AUTH_FIXED_VERIFICATION_CODE === undefined,
    {
      message:
        'AUTH_FIXED_VERIFICATION_CODE must be unset in production (it is a master email login code — a deployed runtime must only ever accept the one-time codes issued by send-code).',
      path: ['AUTH_FIXED_VERIFICATION_CODE'],
    },
  )
  .refine(
    (data) =>
      data.NODE_ENV !== 'production' ||
      data.AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS >=
        DEFAULT_ANTI_ENUMERATION_MINIMUM_DURATION_MS,
    {
      message: `AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS must be >= ${DEFAULT_ANTI_ENUMERATION_MINIMUM_DURATION_MS} in production (below the known-account branch's own duration the floor stops masking it, turning the silent-success response into an account-existence timing oracle).`,
      path: ['AUTH_ANTI_ENUMERATION_MINIMUM_DURATION_MS'],
    },
  )
  .refine((data) => data.NODE_ENV !== 'production' || data.REDIS_READY_CHECK_ENABLED === true, {
    message:
      'REDIS_READY_CHECK_ENABLED must be true in production (the ready-check must stay on outside the test harness).',
    path: ['REDIS_READY_CHECK_ENABLED'],
  })
  .refine((data) => data.NODE_ENV !== 'production' || data.RATE_LIMIT_RELAXED_CAPS === false, {
    message:
      'RATE_LIMIT_RELAXED_CAPS must be false in production (credential-stuffing rate caps must stay tight).',
    path: ['RATE_LIMIT_RELAXED_CAPS'],
  })
  .refine(
    (data) =>
      data.NODE_ENV !== 'production' || data.RATE_LIMIT_IN_MEMORY_FALLBACK_ALLOWED === false,
    {
      message:
        'RATE_LIMIT_IN_MEMORY_FALLBACK_ALLOWED must be false in production (a stray RUN_REDIS_TESTS=0 must never downgrade the Redis limiter to per-process counting).',
      path: ['RATE_LIMIT_IN_MEMORY_FALLBACK_ALLOWED'],
    },
  )
  .refine(
    (data) => {
      // audit-#L1: the suite ships a static, PUBLICLY-COMMITTED RSA keypair (src/tests/setup.ts).
      // It must never sign or verify real tokens — reject it by base64-body fingerprint so a stray
      // copy-paste of the test key into a production secret fails closed at boot instead of silently
      // issuing forgeable tokens. Non-production (incl. the test harness running as `development`)
      // is unaffected. Rotate: recompute fingerprints via
      //   node -e "require('crypto');..." over src/tests/setup.ts and update FORBIDDEN_TEST_JWT_KEY_FINGERPRINTS.
      if (data.NODE_ENV !== 'production') {
        return true;
      }
      return !(
        containsForbiddenTestJwtKey(data.JWT_PRIVATE_KEY) ||
        containsForbiddenTestJwtKey(data.JWT_PUBLIC_KEY)
      );
    },
    {
      message:
        'JWT_PRIVATE_KEY / JWT_PUBLIC_KEY must not be the committed test keypair (src/tests/setup.ts) in production — generate a fresh RSA keypair for the production environment.',
      path: ['JWT_PRIVATE_KEY'],
    },
  )
  .refine(
    (data) => {
      // sec-UP10: presigned PUT has no client-side min-size enforcement, so a
      // zero-byte upload can occupy a row + presigned slot until the sweeper
      // reclaims it. Presigned POST policy carries `content-length-range` that
      // S3 evaluates at upload time, rejecting empty/oversized bodies before
      // they cost anything. Force POST in production; PUT remains available
      // for non-prod testing.
      if (data.NODE_ENV !== 'production') {
        return true;
      }
      return data.UPLOAD_USE_PRESIGNED_POST === true;
    },
    {
      message:
        'UPLOAD_USE_PRESIGNED_POST must be true in production (PUT fallback has no min-size enforcement).',
      path: ['UPLOAD_USE_PRESIGNED_POST'],
    },
  )
  .refine(
    (data) => {
      // sec-C11: ENABLE_RESPONSE_ENCRYPTION must be paired with a key source —
      // either the single RESPONSE_ENCRYPTION_KEY or a RESPONSE_ENCRYPTION_KEYS
      // keyring (for kid-based rotation). Other pairings (METRICS_ENABLED,
      // CAPTCHA_*) enforce this at the schema; this one was previously enforced
      // at `buildApp()` runtime, so a deploy without the key would crash on
      // first request instead of failing config validation at boot. The deeper
      // "keyring contains the current version" check lives in the resolver
      // (resolveActiveResponseEncryptionKey), which also runs at boot.
      if (!data.ENABLE_RESPONSE_ENCRYPTION) return true;
      const hasSingleKey =
        typeof data.RESPONSE_ENCRYPTION_KEY === 'string' && data.RESPONSE_ENCRYPTION_KEY.length > 0;
      const hasKeyring =
        typeof data.RESPONSE_ENCRYPTION_KEYS === 'string' &&
        data.RESPONSE_ENCRYPTION_KEYS.length > 0;
      return hasSingleKey || hasKeyring;
    },
    {
      message:
        'RESPONSE_ENCRYPTION_KEY (64 hex chars / 32 bytes for AES-256) or a RESPONSE_ENCRYPTION_KEYS keyring is required when ENABLE_RESPONSE_ENCRYPTION=true.',
      path: ['RESPONSE_ENCRYPTION_KEY'],
    },
  )
  .refine(
    (data) => {
      // sec-C3: OTLP traffic carries SQL fragments, request paths, request ids.
      // Allow plaintext http:// in dev/test (typical local collector), require
      // https:// in production — those environments must export over
      // an encrypted channel.
      if (data.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) return true;
      if (data.NODE_ENV !== 'production') return true;
      try {
        return new URL(data.OTEL_EXPORTER_OTLP_ENDPOINT).protocol === 'https:';
      } catch {
        return false;
      }
    },
    {
      message:
        'OTEL_EXPORTER_OTLP_ENDPOINT must be an https:// URL in production (telemetry exporters cannot transmit SQL fragments / request paths in plaintext).',
      path: ['OTEL_EXPORTER_OTLP_ENDPOINT'],
    },
  )
  .refine(
    (data) => data.DATABASE_WORKER_LOCK_TIMEOUT_MS < data.DATABASE_WORKER_STATEMENT_TIMEOUT_MS,
    {
      message:
        'DATABASE_WORKER_LOCK_TIMEOUT_MS must be < DATABASE_WORKER_STATEMENT_TIMEOUT_MS. statement_timeout includes time spent waiting for a lock, so an equal or larger lock timeout never fires and the worker lock wait is effectively unbounded.',
      path: ['DATABASE_WORKER_LOCK_TIMEOUT_MS'],
    },
  )
  .refine(
    (data) => {
      // statement_timeout measures TOTAL statement duration, lock wait included. So a
      // lock_timeout at or above it never fires — the statement timeout cuts the statement short
      // first and the lock bound is inert, silently restoring the unbounded-wait behaviour this
      // setting exists to prevent. 0 means "no statement timeout", so there is nothing to bound
      // against.
      if (data.DATABASE_HTTP_STATEMENT_TIMEOUT_MS === 0) {
        return true;
      }
      return data.DATABASE_LOCK_TIMEOUT_MS < data.DATABASE_HTTP_STATEMENT_TIMEOUT_MS;
    },
    {
      message:
        'DATABASE_LOCK_TIMEOUT_MS must be < DATABASE_HTTP_STATEMENT_TIMEOUT_MS (or the statement timeout must be 0). statement_timeout includes time spent waiting for a lock, so an equal or larger lock timeout never fires and the lock wait is effectively unbounded again.',
      path: ['DATABASE_LOCK_TIMEOUT_MS'],
    },
  )
  .refine(
    (data) => {
      // PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS is the Redis lock held while a permission
      // cache miss triggers a DB recompute. If the HTTP statement timeout exceeds the lock TTL,
      // the lock can expire before the DB query finishes, causing concurrent waiters to bypass
      // the stampede guard and all hit the database simultaneously.
      // 0 means "no statement timeout" — in that case we cannot enforce a bound.
      if (data.DATABASE_HTTP_STATEMENT_TIMEOUT_MS === 0) {
        return true;
      }
      return (
        data.DATABASE_HTTP_STATEMENT_TIMEOUT_MS <
        PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS * 1_000
      );
    },
    {
      message: `DATABASE_HTTP_STATEMENT_TIMEOUT_MS must be < ${PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS * 1_000} (PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS × 1000) or 0 (disabled). A longer timeout allows the recompute lock to expire mid-query, defeating the cache stampede guard.`,
      path: ['DATABASE_HTTP_STATEMENT_TIMEOUT_MS'],
    },
  )
  // sec-B6: Stripe secret key, when set, must carry a valid mode prefix
  // (`sk_test_` or `sk_live_`). A garbled value defeats every Stripe API
  // call and pushes the system into "fictional mode" (subs persist locally
  // but never charge); fail closed at boot instead of silently at runtime.
  .refine(
    (data) =>
      data.STRIPE_SECRET_KEY === undefined ||
      data.STRIPE_SECRET_KEY.startsWith('sk_test_') ||
      data.STRIPE_SECRET_KEY.startsWith('sk_live_') ||
      // Restricted test keys (Dashboard sandbox / restricted API keys).
      data.STRIPE_SECRET_KEY.startsWith('rk_test_') ||
      data.STRIPE_SECRET_KEY.startsWith('rkcs_test_'),
    {
      message:
        'STRIPE_SECRET_KEY must begin with `sk_test_` / `sk_live_` (API key) or `rk_test_` / `rkcs_test_` (restricted sandbox key).',
      path: ['STRIPE_SECRET_KEY'],
    },
  )
  // sec-B6 + sec-new-B3: Stripe webhook secret, when set, must carry the `whsec_` prefix.
  // A wrong value fails every HMAC and silently freezes subscription state
  // (no past-due / cancellation events reach the DB) until Stripe disables
  // the endpoint after ~3 days.
  // sec-new-B3: accepts a comma-separated list for zero-downtime key rotation
  // (e.g. `whsec_old,whsec_new`); every segment must start with `whsec_`.
  // Trailing commas and whitespace around segments are ignored so copy-paste
  // errors from the Stripe Dashboard do not brick the webhook at boot.
  .refine(
    (data) => {
      if (data.STRIPE_WEBHOOK_SECRET === undefined) return true;
      const segments = data.STRIPE_WEBHOOK_SECRET.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return segments.length > 0 && segments.every((s) => s.startsWith('whsec_'));
    },
    {
      message:
        'STRIPE_WEBHOOK_SECRET must be a `whsec_`-prefixed value or a comma-separated list of `whsec_`-prefixed values (Stripe webhook secret format).',
      path: ['STRIPE_WEBHOOK_SECRET'],
    },
  )
  // sec-B6: In production, the Stripe secret key must be a live key
  // (`sk_live_*`). A test key in production silently fails every webhook
  // signature check and accepts no real payments.
  .refine(
    (data) => {
      if (data.NODE_ENV !== 'production') return true;
      if (data.STRIPE_SECRET_KEY === undefined) return true;
      return data.STRIPE_SECRET_KEY.startsWith('sk_live_');
    },
    {
      message:
        'In production, STRIPE_SECRET_KEY must be a live-mode key (`sk_live_*`). Test-mode keys silently fail every webhook HMAC and accept no real payments.',
      path: ['STRIPE_SECRET_KEY'],
    },
  )
  // sec-B5: In production, half-configured Stripe (one of the two keys set,
  // the other missing — typically a typo or missing GitHub Actions secret)
  // would otherwise leave `isStripeConfigured()` returning false and the
  // subscription service silently issuing local-only trials without ever
  // charging. Reject the half-configured state loudly at boot.
  .refine(
    (data) => {
      if (data.NODE_ENV !== 'production') return true;
      const hasSecretKey = Boolean(data.STRIPE_SECRET_KEY);
      const hasWebhookSecret = Boolean(data.STRIPE_WEBHOOK_SECRET);
      // Both unset = billing disabled (allowed). Both set = handled by the
      // format / live-mode refines above. Only one set = error.
      return hasSecretKey === hasWebhookSecret;
    },
    {
      message:
        'In production, STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must both be set or both unset; a half-configured Stripe environment silently runs in fictional mode (subscriptions persist locally without charging).',
      path: ['STRIPE_WEBHOOK_SECRET'],
    },
  )
  // Mirror of the half-config refine — Zod path is informational, so we emit
  // a second clause targeting `STRIPE_SECRET_KEY` so either-missing-side error
  // surfaces on the offending key in deploy validators.
  .refine(
    (data) => {
      if (data.NODE_ENV !== 'production') return true;
      const hasSecretKey = Boolean(data.STRIPE_SECRET_KEY);
      const hasWebhookSecret = Boolean(data.STRIPE_WEBHOOK_SECRET);
      return hasSecretKey === hasWebhookSecret;
    },
    {
      message:
        'In production, STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must both be set or both unset (see sec-B5).',
      path: ['STRIPE_SECRET_KEY'],
    },
  )
  // audit #8: the RS256 signing keys were validated only by `min(1)`. A truncated PEM, a
  // non-RSA key, or an accidental sub-2048-bit key passed boot and either failed opaquely at
  // first sign/verify or (weak-but-valid) issued practically-forgeable tokens. Assert real RSA
  // PEMs of adequate modulus in DEPLOYED runtimes (production) — mirroring the entropy
  // floor already gated on SECRETS_ENCRYPTION_KEY. local/development/test use ephemeral keys.
  .refine(
    (data) => data.NODE_ENV !== 'production' || isStrongRsaPem(data.JWT_PRIVATE_KEY, 'private'),
    {
      message: `JWT_PRIVATE_KEY must be a valid RSA private-key PEM of at least ${MIN_JWT_RSA_MODULUS_BITS} bits.`,
      path: ['JWT_PRIVATE_KEY'],
    },
  )
  .refine(
    (data) => data.NODE_ENV !== 'production' || isStrongRsaPem(data.JWT_PUBLIC_KEY, 'public'),
    {
      message: `JWT_PUBLIC_KEY must be a valid RSA public-key PEM of at least ${MIN_JWT_RSA_MODULUS_BITS} bits.`,
      path: ['JWT_PUBLIC_KEY'],
    },
  )
  // audit #7: the Scalar API reference UI (GET /reference) mounts with no auth pre-handler and
  // no environment restriction. Exposing the full internal API contract unauthenticated in
  // production is a recon aid (and relaxes CSP on that subtree). Refuse to enable it in
  // production unless an operator explicitly opts in via API_REFERENCE_ALLOW_PRODUCTION=true.
  .refine(
    (data) =>
      !(
        data.NODE_ENV === 'production' &&
        data.ENABLE_API_REFERENCE &&
        !data.API_REFERENCE_ALLOW_PRODUCTION
      ),
    {
      message:
        'ENABLE_API_REFERENCE=true is not permitted in production (the /reference UI is unauthenticated and exposes the full API contract). Set API_REFERENCE_ALLOW_PRODUCTION=true to override deliberately.',
      path: ['ENABLE_API_REFERENCE'],
    },
  )
  // re-audit A1: the Bull-Board queue dashboard (/admin/queues) is SUPER_ADMIN-gated at runtime,
  // but unlike /reference it had no boot-time guard — so its protection rested entirely on a single
  // preHandler wiring. Refuse to enable it in production unless an operator explicitly opts in via
  // QUEUE_DASHBOARD_ALLOW_PRODUCTION=true (defense-in-depth safety net, mirroring ENABLE_API_REFERENCE).
  .refine(
    (data) =>
      !(
        data.NODE_ENV === 'production' &&
        data.ENABLE_QUEUE_DASHBOARD &&
        !data.QUEUE_DASHBOARD_ALLOW_PRODUCTION
      ),
    {
      message:
        'ENABLE_QUEUE_DASHBOARD=true is not permitted in production (the Bull-Board dashboard exposes job payloads and destructive job operations). Set QUEUE_DASHBOARD_ALLOW_PRODUCTION=true to override deliberately.',
      path: ['ENABLE_QUEUE_DASHBOARD'],
    },
  );

/**
 * Registry of variables migrated to the explicit {@link EnvVarSpec} manifest — each declared once
 * with its allowed-values summary + description, the Zod field derived from it. Grows section by
 * section (spread each `*_VARS` group here); `pnpm env:catalog` and the registry-coverage gate read
 * it. Not yet the whole schema — coverage ratchets up via `tooling/env-registry/coverage-budget.json`.
 */
export const ENV_VAR_REGISTRY: Readonly<Record<string, EnvVarSpec>> = {
  ...SERVER_VARS,
};

/** Ordered list of env var names from the schema (for .env.example sync and scripts). */
export const envSchemaKeys = Object.keys(envSchemaBase.shape) as (keyof z.infer<
  typeof envSchema
>)[];

/**
 * Serialize a parsed Zod default to the exact string form stored in `.env.example`.
 *
 * @remarks
 * Never `String(object)` — that yields `"[object Object]"` (Sonar S6551). Scalars use `String`;
 * arrays keep the historical `String(array)` shape (`''` for `[]`, comma-join otherwise) so
 * env-catalog / github:sync exact-match defaults stay stable; objects are JSON-serialized; and
 * unrepresentable values (`null`/`undefined`/symbol/function) return `undefined` so the caller
 * omits the key rather than storing a garbage default.
 */
export function formatEnvSchemaDefault(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) return value.length === 0 ? '' : value.map(String).join(',');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return undefined;
}

/**
 * Resolved default value — stringified — for every schema key that HAS one, keyed by env var name.
 *
 * @remarks
 * Built with Zod's public `safeParse(undefined)` — the exact default-resolution the runtime applies
 * at boot, and the same technique {@link envSchemaRequiredKeys} uses — so it never touches Zod
 * internals and degrades safely: a key that resolves to `undefined` (optional-without-default) or
 * fails to parse (required) is simply ABSENT from the map. Values are post-transform and stringified
 * (`booleanString('false')` → `'false'`, `.default(3000)` → `'3000'`, `.default('info')` → `'info'`).
 *
 * Consumed by `pnpm github:sync` (`tooling/setup/github/sync-github-environments.ts`): a variable
 * whose local value string-equals this default is NOT pushed to the GitHub Environment and is pruned
 * if already present — an unset variable falls back to exactly this value at boot, so storing it is
 * redundant. The match is exact-string and therefore conservative: a semantically-equivalent but
 * differently-written value (`'1'` for a boolean, `'3000.0'` for a number) does NOT match and is
 * kept as an override, so the tool can never wrongly drop a real override.
 */
export const envSchemaDefaults: Readonly<Record<string, string>> = (() => {
  const defaults: Record<string, string> = {};
  for (const [key, schema] of Object.entries(envSchemaBase.shape)) {
    const parsed = (schema as z.ZodTypeAny).safeParse(undefined);
    if (parsed.success) {
      const formatted = formatEnvSchemaDefault(parsed.data);
      if (formatted !== undefined) defaults[key] = formatted;
    }
  }
  return defaults;
})();

/**
 * Keys whose schema entry has no default and is not marked `.optional()`. These must
 * always be present at runtime — the app Zod-rejects on first request otherwise.
 *
 * Used by `tooling/setup/github/validate-environment-runtime.ts` to assert deploy-target secrets
 * against the schema instead of treating every uncommented `.env.example` line as
 * required (which would also flag optional integrations like Stripe / OAuth / S3).
 */
export const envSchemaRequiredKeys: readonly string[] = Object.entries(envSchemaBase.shape)
  .filter(([, schema]) => !(schema as z.ZodTypeAny).safeParse(undefined).success)
  .map(([key]) => key);

/**
 * Keys that are syntactically optional in the schema but become effectively required
 * under common runtime conditions enforced by `.refine()` clauses. Tooling surfaces
 * these as warnings (not hard errors) since they depend on other flag values that
 * deploy validators cannot inspect directly (GitHub only exposes secret *names*).
 */
export const envSchemaConditionallyRequiredKeys: ReadonlyArray<{
  readonly key: string;
  readonly condition: string;
}> = [
  {
    key: 'METRICS_SCRAPE_TOKEN',
    condition: 'METRICS_ENABLED=true (schema default; explicit METRICS_ENABLED=false opts out)',
  },
  {
    key: 'CAPTCHA_SECRET',
    condition:
      'CAPTCHA_PROVIDER=turnstile (schema default is `disabled`; required in NODE_ENV=production)',
  },
  {
    key: 'EMAIL_FROM_ADDRESS',
    condition: 'RESEND_API_KEY is set (no hardcoded sender fallback)',
  },
];

/* ---------------------------------------------------------------------------
 * GitHub Secret vs Variable classification
 * ---------------------------------------------------------------------------
 *
 * The classification lives entirely in `.env.example`: every key sits under
 * either the "GitHub Secrets" half (pushed via `gh secret set`) or the
 * "GitHub Variables" half (pushed via `gh api .../variables`). `pnpm github:sync`
 * mirrors that structure into each missing `.env.<environment>`, and then
 * reads the same structure when pushing.
 *
 * When you add a new env var: add it to this schema AND to the correct half
 * of `.env.example`. The `env-schema-add` skill walks through which half +
 * sub-section to pick.
 * --------------------------------------------------------------------------- */
