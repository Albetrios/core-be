import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envSchema, envSchemaDefaults, envSchemaKeys } from '@/shared/config/env-schema.js';

const DATABASE_URL_FIXTURE = 'postgres://localhost:5432/core';
const REDIS_URL_FIXTURE = 'redis://localhost:6379';

// audit #8: the deployed runtime (production) now requires real RSA PEMs ≥2048-bit, so the
// production fixture needs a genuine key pair. development still accepts the short placeholders
// below (the refine is gated to the deployed runtime).
const REAL_RSA_KEY_PAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const productionRedisTopology = {
  REDIS_URL: 'redis://shared.example.railway.internal:6379',
};

const commonRequiredBase = {
  DATABASE_URL: DATABASE_URL_FIXTURE,
  REDIS_URL: REDIS_URL_FIXTURE,
  JWT_PRIVATE_KEY: REAL_RSA_KEY_PAIR.privateKey,
  JWT_PUBLIC_KEY: REAL_RSA_KEY_PAIR.publicKey,
  ALLOWED_ORIGINS: 'http://localhost:3000',
  METRICS_SCRAPE_TOKEN: 'b'.repeat(32),
  // High-entropy 32-byte hex key — production rejects low-entropy placeholders (e.g. all-zeros).
  SECRETS_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  AUDIT_RETENTION_DAYS: '30',
  AUTH_SESSION_RETENTION_DAYS: '30',
};

const productionRequiredBase = {
  ...commonRequiredBase,
  NODE_ENV: 'production',
  // Production requires absolute https origins (no plaintext http / wildcard).
  ALLOWED_ORIGINS: 'https://app.example.com',
  CAPTCHA_PROVIDER: 'turnstile',
  CAPTCHA_SECRET: 'turnstile-secret',
  ...productionRedisTopology,
};

describe('env-schema', () => {
  describe('OAuth redirect URIs', () => {
    it('requires OAUTH_GOOGLE_REDIRECT_URI once the Google client is configured', () => {
      // The code fallback builds `${FRONTEND_URL}/callback/google` (the SPA's provider-specific
      // OAuth landing page), but the registered value must match the provider console exactly.
      // Fail loudly at boot rather than ship a silently wrong redirect that only surfaces
      // provider-side.
      expect(() =>
        envSchema.parse({ ...commonRequiredBase, OAUTH_GOOGLE_CLIENT_ID: 'google-client-id' }),
      ).toThrow();
    });

    it('accepts the Google client when the redirect URI is supplied', () => {
      const parsed = envSchema.parse({
        ...commonRequiredBase,
        OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
        OAUTH_GOOGLE_REDIRECT_URI: 'https://app.example.com/callback/google',
      });
      expect(parsed.OAUTH_GOOGLE_REDIRECT_URI).toBe('https://app.example.com/callback/google');
    });

    it('requires OAUTH_GITHUB_REDIRECT_URI once the GitHub client is configured', () => {
      expect(() =>
        envSchema.parse({ ...commonRequiredBase, OAUTH_GITHUB_CLIENT_ID: 'github-client-id' }),
      ).toThrow();
    });

    it('leaves both optional when neither provider is configured', () => {
      expect(() => envSchema.parse({ ...commonRequiredBase })).not.toThrow();
    });
  });

  describe('COOKIE_SAMESITE', () => {
    it('defaults to strict', () => {
      const parsed = envSchema.parse({ ...commonRequiredBase });
      expect(parsed.COOKIE_SAMESITE).toBe('strict');
    });

    it('accepts none when the cookie is Secure', () => {
      // A cross-site SPA (different registrable domain from the API) needs `none` or the browser
      // strips the cookie from every request to /api/v1/auth.
      const parsed = envSchema.parse({
        ...commonRequiredBase,
        COOKIE_SAMESITE: 'none',
        COOKIE_SECURE: 'true',
        // `none` additionally requires https origins — commonRequiredBase uses http://localhost.
        ALLOWED_ORIGINS: 'https://app.example.com',
      });
      expect(parsed.COOKIE_SAMESITE).toBe('none');
    });

    it('rejects none without Secure — browsers refuse such a cookie outright', () => {
      expect(() =>
        envSchema.parse({
          ...commonRequiredBase,
          COOKIE_SAMESITE: 'none',
          COOKIE_SECURE: 'false',
        }),
      ).toThrow();
    });

    it('rejects none when any ALLOWED_ORIGINS entry is not https', () => {
      // At `none` the Origin allowlist becomes the primary CSRF control on the cookie-session
      // route, so it must be trustworthy in every environment — not only under NODE_ENV=production.
      expect(() =>
        envSchema.parse({
          ...commonRequiredBase,
          COOKIE_SAMESITE: 'none',
          COOKIE_SECURE: 'true',
          ALLOWED_ORIGINS: 'https://app.example.com,http://legacy.example.com',
        }),
      ).toThrow();
    });

    it('accepts none when every ALLOWED_ORIGINS entry is https', () => {
      const parsed = envSchema.parse({
        ...commonRequiredBase,
        COOKIE_SAMESITE: 'none',
        COOKIE_SECURE: 'true',
        ALLOWED_ORIGINS: 'https://app.example.com,https://admin.example.com',
      });
      expect(parsed.COOKIE_SAMESITE).toBe('none');
    });

    it('rejects a value outside strict | lax | none', () => {
      expect(() =>
        envSchema.parse({ ...commonRequiredBase, COOKIE_SAMESITE: 'sometimes' }),
      ).toThrow();
    });
  });

  it('exports schema keys for tooling sync', () => {
    expect(envSchemaKeys.length).toBeGreaterThan(0);
    expect(envSchemaKeys).toContain('DATABASE_URL');
    expect(envSchemaKeys).toContain('JWT_PRIVATE_KEY');
  });

  it('applies DATABASE_HTTP_STATEMENT_TIMEOUT_MS and pool alert defaults', () => {
    const parsed = envSchema.safeParse({
      ...process.env,
      DATABASE_URL: DATABASE_URL_FIXTURE,
      REDIS_URL: REDIS_URL_FIXTURE,
      NODE_ENV: 'development',
      AUDIT_RETENTION_DAYS: '30',
      AUTH_SESSION_RETENTION_DAYS: '30',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.DATABASE_HTTP_STATEMENT_TIMEOUT_MS).toBe(5_000);
      expect(parsed.data.DATABASE_POOL_ACTIVE_WARN_RATIO).toBe(0.8);
      expect(parsed.data.DATABASE_POOL_ALERT_POLL_INTERVAL_MS).toBe(5_000);
    }
  });

  it('coerces PORT and applies defaults for optional fields', () => {
    const parsed = envSchema.safeParse({
      ...process.env,
      DATABASE_URL: DATABASE_URL_FIXTURE,
      REDIS_URL: REDIS_URL_FIXTURE,
      PORT: '4000',
      NODE_ENV: 'development',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.PORT).toBe(4000);
      expect(parsed.data.AUTH_SESSION_MAX_AGE_DAYS).toBe(7);
    }
  });

  // sec-r4-C4: AUTH_SESSION_MAX_AGE_DAYS must be bounded at 365 so a config
  // typo cannot produce effectively-never-expiring sessions.
  it('rejects AUTH_SESSION_MAX_AGE_DAYS above 365 (sec-r4-C4)', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
      AUTH_SESSION_MAX_AGE_DAYS: '366',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) => issue.path.includes('AUTH_SESSION_MAX_AGE_DAYS')),
      ).toBe(true);
    }
  });

  it('accepts AUTH_SESSION_MAX_AGE_DAYS at the 365 ceiling (sec-r4-C4)', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
      AUTH_SESSION_MAX_AGE_DAYS: '365',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.AUTH_SESSION_MAX_AGE_DAYS).toBe(365);
    }
  });

  it('validates the single-key RS256 model in production (JWT_PUBLIC_KEY only, no keyring)', () => {
    const parsed = envSchema.safeParse({ ...productionRequiredBase });
    expect(parsed.success).toBe(true);
  });

  it('requires EMAIL_FROM_ADDRESS when RESEND_API_KEY is set', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
      RESEND_API_KEY: 're_test_key',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes('EMAIL_FROM_ADDRESS'))).toBe(
        true,
      );
    }
  });

  it('accepts RESEND_API_KEY together with EMAIL_FROM_ADDRESS', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
      RESEND_API_KEY: 're_test_key',
      EMAIL_FROM_ADDRESS: 'noreply@example.com',
    });
    expect(parsed.success).toBe(true);
  });

  it('allows EMAIL_FROM_ADDRESS to be absent when RESEND_API_KEY is unset', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects ALLOWED_ORIGINS containing a wildcard in any environment', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
      ALLOWED_ORIGINS: 'https://app.example.com,*',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects plaintext http ALLOWED_ORIGINS in production', () => {
    const parsed = envSchema.safeParse({
      ...productionRequiredBase,
      ALLOWED_ORIGINS: 'http://app.example.com',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts https ALLOWED_ORIGINS in production', () => {
    const parsed = envSchema.safeParse({
      ...productionRequiredBase,
      ALLOWED_ORIGINS: 'https://app.example.com,https://admin.example.com',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects BLOCK_DISPOSABLE_EMAIL=false in production (Category-B)', () => {
    const parsed = envSchema.safeParse({
      ...productionRequiredBase,
      BLOCK_DISPOSABLE_EMAIL: 'false',
    });
    expect(parsed.success).toBe(false);
  });

  it('defaults BLOCK_DISPOSABLE_EMAIL to blocking (true) in production', () => {
    const parsed = envSchema.safeParse({ ...productionRequiredBase });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.BLOCK_DISPOSABLE_EMAIL).toBe(true);
  });

  it('allows BLOCK_DISPOSABLE_EMAIL=false outside production (dev affordance)', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
      BLOCK_DISPOSABLE_EMAIL: 'false',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.BLOCK_DISPOSABLE_EMAIL).toBe(false);
  });

  it('defaults TEST_MODE to false', () => {
    const parsed = envSchema.safeParse({ ...commonRequiredBase, NODE_ENV: 'development' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.TEST_MODE).toBe(false);
  });

  it('rejects TEST_MODE=true in production (Category-B)', () => {
    const parsed = envSchema.safeParse({ ...productionRequiredBase, TEST_MODE: 'true' });
    expect(parsed.success).toBe(false);
    expect(
      !parsed.success && parsed.error.issues.some((issue) => issue.path.includes('TEST_MODE')),
    ).toBe(true);
  });

  it('allows TEST_MODE=true outside production (test-run gate)', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
      TEST_MODE: 'true',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.TEST_MODE).toBe(true);
  });

  it('accepts NODE_ENV=local (developer machine, primary file .env.local)', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'local',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.NODE_ENV).toBe('local');
  });

  it('defaults NODE_ENV to local when unset (an unset NODE_ENV is a developer machine)', () => {
    // commonRequiredBase omits NODE_ENV, so this exercises the `.default('local')`. Every deploy/CI
    // context sets NODE_ENV explicitly, so the default only governs a bare local `pnpm dev`.
    const parsed = envSchema.safeParse({ ...commonRequiredBase });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.NODE_ENV).toBe('local');
  });

  it('fails loudly on an out-of-enum NODE_ENV (e.g. qa) — never a silent default', () => {
    // Use a non-forbidden invalid value so this negative test doesn't itself trip the
    // no-removed-values guard (which scans source for NODE_ENV=test/staging).
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'qa',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes('NODE_ENV'))).toBe(true);
    }
  });

  it('allows http localhost ALLOWED_ORIGINS outside production', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
      ALLOWED_ORIGINS: 'http://localhost:3000',
    });
    expect(parsed.success).toBe(true);
  });

  it('transforms TRUST_PROXY "1" to a hop count', () => {
    const parsed = envSchema.safeParse({
      ...process.env,
      DATABASE_URL: DATABASE_URL_FIXTURE,
      REDIS_URL: REDIS_URL_FIXTURE,
      NODE_ENV: 'development',
      AUDIT_RETENTION_DAYS: '30',
      AUTH_SESSION_RETENTION_DAYS: '30',
      TRUST_PROXY: '1',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.TRUST_PROXY).toBe(1);
    }
  });

  it('rejects bare TRUST_PROXY=true', () => {
    const parsed = envSchema.safeParse({
      ...process.env,
      DATABASE_URL: DATABASE_URL_FIXTURE,
      REDIS_URL: REDIS_URL_FIXTURE,
      NODE_ENV: 'development',
      TRUST_PROXY: 'true',
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.TRUST_PROXY).toBeDefined();
    }
  });

  it('transforms TRUST_PROXY disabled values to false', () => {
    const disabled = envSchema.safeParse({
      ...process.env,
      DATABASE_URL: DATABASE_URL_FIXTURE,
      REDIS_URL: REDIS_URL_FIXTURE,
      NODE_ENV: 'development',
      TRUST_PROXY: '0',
    });

    expect(disabled.success && disabled.data.TRUST_PROXY).toBe(false);
  });

  it('coerces optional boolean-like env strings', () => {
    const disposableAllowed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
      BLOCK_DISPOSABLE_EMAIL: 'false',
      SCHEDULER_ENABLED: '0',
    });

    expect(disposableAllowed.success).toBe(true);
    if (disposableAllowed.success) {
      expect(disposableAllowed.data.BLOCK_DISPOSABLE_EMAIL).toBe(false);
      expect(disposableAllowed.data.SCHEDULER_ENABLED).toBe(false);
    }
  });

  // sec-C5: JWT_SECRET removed from the schema (RS256 only). The
  // "parses without JWT_SECRET" + "accepts optional pair alongside
  // JWT_SECRET" tests are no longer applicable; the RS256-key acceptance
  // test below covers the surviving path.
  it('parses with the RS256 key pair set', () => {
    const parsed = envSchema.safeParse({
      ...process.env,
      DATABASE_URL: DATABASE_URL_FIXTURE,
      REDIS_URL: REDIS_URL_FIXTURE,
      NODE_ENV: 'development',
      JWT_PRIVATE_KEY: 'test-private-key',
      JWT_PUBLIC_KEY: 'test-public-key',
    });

    expect(parsed.success).toBe(true);
  });

  it('transforms ENABLE_RESPONSE_ENCRYPTION string values', () => {
    const enabled = envSchema.safeParse({
      ...process.env,
      DATABASE_URL: DATABASE_URL_FIXTURE,
      REDIS_URL: REDIS_URL_FIXTURE,
      NODE_ENV: 'development',
      ENABLE_RESPONSE_ENCRYPTION: 'true',
      RESPONSE_ENCRYPTION_KEY: 'a'.repeat(64),
    });
    const disabled = envSchema.safeParse({
      ...process.env,
      DATABASE_URL: DATABASE_URL_FIXTURE,
      REDIS_URL: REDIS_URL_FIXTURE,
      NODE_ENV: 'development',
      ENABLE_RESPONSE_ENCRYPTION: '0',
    });

    expect(enabled.success && enabled.data.ENABLE_RESPONSE_ENCRYPTION).toBe(true);
    expect(disabled.success && disabled.data.ENABLE_RESPONSE_ENCRYPTION).toBe(false);
  });

  it('rejects idempotency cardinality when critical threshold is below warn threshold', () => {
    const parsed = envSchema.safeParse({
      ...process.env,
      DATABASE_URL: DATABASE_URL_FIXTURE,
      REDIS_URL: REDIS_URL_FIXTURE,
      NODE_ENV: 'development',
      IDEMPOTENCY_CARDINALITY_WARN_THRESHOLD: '100',
      IDEMPOTENCY_CARDINALITY_CRITICAL_THRESHOLD: '10',
    });

    expect(parsed.success).toBe(false);
  });

  it('requires RS256 keys in production', () => {
    const parsed = envSchema.safeParse({
      DATABASE_URL: DATABASE_URL_FIXTURE,
      REDIS_URL: REDIS_URL_FIXTURE,
      NODE_ENV: 'production',
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects an env missing both RS256 key parts', () => {
    // sec-C5: the original "rejects JWT_SECRET shorter than minimum length"
    // assertion was actually pinning the "missing RS256 keys" rejection path
    // (the env block omitted them too); rename to match what is actually
    // being verified.
    const parsed = envSchema.safeParse({
      DATABASE_URL: DATABASE_URL_FIXTURE,
      REDIS_URL: REDIS_URL_FIXTURE,
      NODE_ENV: 'development',
    });

    expect(parsed.success).toBe(false);
  });

  it('transforms feature-flag env strings to booleans', () => {
    const parsed = envSchema.safeParse({
      ...process.env,
      DATABASE_URL: DATABASE_URL_FIXTURE,
      REDIS_URL: REDIS_URL_FIXTURE,
      NODE_ENV: 'development',
      AUDIT_RETENTION_DAYS: '30',
      AUTH_SESSION_RETENTION_DAYS: '30',
      ENABLE_MCP_SERVER: 'true',
      ENABLE_API_REFERENCE: 'true',
      ENABLE_QUEUE_DASHBOARD: '1',
      DATABASE_SSL_REJECT_UNAUTHORIZED: 'true',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.ENABLE_MCP_SERVER).toBe(true);
      expect(parsed.data.ENABLE_API_REFERENCE).toBe(true);
      expect(parsed.data.ENABLE_QUEUE_DASHBOARD).toBe(true);
      expect(parsed.data.DATABASE_SSL_REJECT_UNAUTHORIZED).toBe(true);
    }
  });

  it('accepts production when RS256 keys are provided', () => {
    const parsed = envSchema.safeParse(productionRequiredBase);

    expect(parsed.success).toBe(true);
  });

  it('allows a shared or dedicated BullMQ Redis endpoint in production', () => {
    const sharedWithoutBullMqUrl = envSchema.safeParse({
      ...productionRequiredBase,
      REDIS_BULLMQ_URL: undefined,
    });
    expect(sharedWithoutBullMqUrl.success).toBe(true);

    const sharedWithSameBullMqUrl = envSchema.safeParse({
      ...productionRequiredBase,
      REDIS_URL: 'redis://shared.example.railway.internal:6379',
      REDIS_BULLMQ_URL: 'redis://shared.example.railway.internal:6379',
    });
    expect(sharedWithSameBullMqUrl.success).toBe(true);

    // A dedicated BullMQ endpoint is supported (recommended production isolation).
    const separateBullMqHost = envSchema.safeParse({
      ...productionRequiredBase,
      REDIS_BULLMQ_URL: 'redis://bullmq.example.railway.internal:6379',
    });
    expect(separateBullMqHost.success).toBe(true);

    // A non-parseable override is rejected.
    const invalidBullMqUrl = envSchema.safeParse({
      ...productionRequiredBase,
      REDIS_BULLMQ_URL: 'not a url',
    });
    expect(invalidBullMqUrl.success).toBe(false);
  });

  it('allows single Redis host when NODE_ENV is development', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
    });

    expect(parsed.success).toBe(true);
  });

  it('requires SECRETS_ENCRYPTION_KEY in production', () => {
    const { SECRETS_ENCRYPTION_KEY: secretsEncryptionKey, ...productionWithoutSecretsKey } =
      productionRequiredBase;
    void secretsEncryptionKey;

    const missingKey = envSchema.safeParse(productionWithoutSecretsKey);
    expect(missingKey.success).toBe(false);
    if (!missingKey.success) {
      expect(
        missingKey.error.issues.some((issue) => issue.path[0] === 'SECRETS_ENCRYPTION_KEY'),
      ).toBe(true);
    }

    const withKey = envSchema.safeParse(productionRequiredBase);
    expect(withKey.success).toBe(true);
  });

  it('rejects a low-entropy / placeholder SECRETS_ENCRYPTION_KEY in production', () => {
    const allZeros = envSchema.safeParse({
      ...productionRequiredBase,
      SECRETS_ENCRYPTION_KEY: '0'.repeat(64),
    });
    expect(allZeros.success).toBe(false);
    if (!allZeros.success) {
      expect(
        allZeros.error.issues.some((issue) => issue.path[0] === 'SECRETS_ENCRYPTION_KEY'),
      ).toBe(true);
    }

    // Single-character placeholder (e.g. the test default `'a'.repeat(64)`) is also rejected.
    const singleChar = envSchema.safeParse({
      ...productionRequiredBase,
      SECRETS_ENCRYPTION_KEY: 'a'.repeat(64),
    });
    expect(singleChar.success).toBe(false);
  });

  it('allows a low-entropy SECRETS_ENCRYPTION_KEY outside production (ephemeral test/CI keys)', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
      SECRETS_ENCRYPTION_KEY: '0'.repeat(64),
    });
    expect(parsed.success).toBe(true);
  });

  it('requires METRICS_SCRAPE_TOKEN whenever METRICS_ENABLED is true', () => {
    const productionWithMetrics = {
      ...productionRequiredBase,
      METRICS_ENABLED: 'true',
      METRICS_SCRAPE_TOKEN: undefined,
    };

    const missingToken = envSchema.safeParse(productionWithMetrics);
    expect(missingToken.success).toBe(false);
    if (!missingToken.success) {
      expect(
        missingToken.error.issues.some((issue) => issue.path[0] === 'METRICS_SCRAPE_TOKEN'),
      ).toBe(true);
    }

    const withToken = envSchema.safeParse({
      ...productionWithMetrics,
      METRICS_SCRAPE_TOKEN: 'b'.repeat(32),
    });
    expect(withToken.success).toBe(true);
  });

  it('accepts a public FRONTEND_URL across all NODE_ENV values (magic-link inline-token leak removed)', () => {
    /**
     * Previously, non-production runtimes were forced to use a localhost
     * FRONTEND_URL because the magic-link service inlined the raw token in
     * API responses. That leak has been eliminated, so deployed non-production
     * environments may now use real public URLs identical to production.
     */
    const parsedDevelopment = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
      FRONTEND_URL: 'https://staging.example.com',
    });
    expect(parsedDevelopment.success).toBe(true);

    const parsedLocalhost = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
      FRONTEND_URL: 'http://localhost:3000',
    });
    expect(parsedLocalhost.success).toBe(true);
  });

  it('rejects production boot when CAPTCHA is not turnstile', () => {
    const {
      CAPTCHA_PROVIDER: _provider,
      CAPTCHA_SECRET: _secret,
      ...withoutCaptcha
    } = productionRequiredBase;
    void _provider;
    void _secret;

    const parsed = envSchema.safeParse(withoutCaptcha);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === 'CAPTCHA_PROVIDER')).toBe(true);
    }
  });

  it('rejects production boot when CAPTCHA_PROVIDER=disabled', () => {
    const parsed = envSchema.safeParse({
      ...productionRequiredBase,
      CAPTCHA_PROVIDER: 'disabled',
      CAPTCHA_SECRET: undefined,
    });
    expect(parsed.success).toBe(false);
  });

  it('allows production boot with configured turnstile CAPTCHA', () => {
    const parsed = envSchema.safeParse(productionRequiredBase);
    expect(parsed.success).toBe(true);
  });

  it('does not require Turnstile CAPTCHA outside production', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
      CAPTCHA_PROVIDER: 'disabled',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects production boot when COOKIE_SECURE is disabled', () => {
    const parsed = envSchema.safeParse({
      ...productionRequiredBase,
      COOKIE_SECURE: 'false',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === 'COOKIE_SECURE')).toBe(true);
    }
  });

  it('allows COOKIE_SECURE=false outside production (local plaintext loops)', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      NODE_ENV: 'development',
      COOKIE_SECURE: 'false',
    });
    expect(parsed.success).toBe(true);
  });

  it('defaults COOKIE_SECURE to true and accepts it in production', () => {
    const parsed = envSchema.safeParse(productionRequiredBase);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.COOKIE_SECURE).toBe(true);
    }
  });

  it('rejects FRONTEND_URL that is not a valid http(s) URL', () => {
    const parsed = envSchema.safeParse({
      DATABASE_URL: DATABASE_URL_FIXTURE,
      REDIS_URL: REDIS_URL_FIXTURE,
      NODE_ENV: 'development',
      FRONTEND_URL: 'not-a-url',
      AUDIT_RETENTION_DAYS: '30',
      AUTH_SESSION_RETENTION_DAYS: '30',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.flatten().fieldErrors.FRONTEND_URL).toBeDefined();
    }
  });

  it('defaults DATABASE_LOCK_TIMEOUT_MS to 3000, below the HTTP statement budget', () => {
    const parsed = envSchema.safeParse({ ...commonRequiredBase });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.DATABASE_LOCK_TIMEOUT_MS).toBe(3_000);
    }
  });

  it('rejects DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS = 0 (an unbounded idle transaction)', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => i.path[0] === 'DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS'),
      ).toBe(true);
    }
  });

  it('rejects DATABASE_LOCK_TIMEOUT_MS >= DATABASE_HTTP_STATEMENT_TIMEOUT_MS (the bound would be inert)', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      DATABASE_HTTP_STATEMENT_TIMEOUT_MS: '4000',
      DATABASE_LOCK_TIMEOUT_MS: '4000',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path[0] === 'DATABASE_LOCK_TIMEOUT_MS')).toBe(true);
    }
  });

  it('allows DATABASE_LOCK_TIMEOUT_MS above the statement timeout when that timeout is 0 (disabled)', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      DATABASE_HTTP_STATEMENT_TIMEOUT_MS: '0',
      DATABASE_LOCK_TIMEOUT_MS: '9000',
    });
    expect(parsed.success).toBe(true);
  });

  it('gives workers a longer lock budget than HTTP by default', () => {
    const parsed = envSchema.safeParse({ ...commonRequiredBase });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.DATABASE_WORKER_LOCK_TIMEOUT_MS).toBe(30_000);
      expect(parsed.data.DATABASE_WORKER_LOCK_TIMEOUT_MS).toBeGreaterThan(
        parsed.data.DATABASE_LOCK_TIMEOUT_MS,
      );
    }
  });

  it('rejects DATABASE_WORKER_LOCK_TIMEOUT_MS >= DATABASE_WORKER_STATEMENT_TIMEOUT_MS', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      DATABASE_WORKER_STATEMENT_TIMEOUT_MS: '20000',
      DATABASE_WORKER_LOCK_TIMEOUT_MS: '20000',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path[0] === 'DATABASE_WORKER_LOCK_TIMEOUT_MS')).toBe(
        true,
      );
    }
  });

  it('rejects DATABASE_HTTP_STATEMENT_TIMEOUT_MS >= PERMISSION_CACHE_RECOMPUTE_LOCK_TTL_SECONDS × 1000', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      DATABASE_HTTP_STATEMENT_TIMEOUT_MS: '15000',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => i.path[0] === 'DATABASE_HTTP_STATEMENT_TIMEOUT_MS'),
      ).toBe(true);
    }
  });

  it('allows DATABASE_HTTP_STATEMENT_TIMEOUT_MS = 0 (disabled) regardless of lock TTL', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      DATABASE_HTTP_STATEMENT_TIMEOUT_MS: '0',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts DATABASE_HTTP_STATEMENT_TIMEOUT_MS within the lock TTL bound', () => {
    const parsed = envSchema.safeParse({
      ...commonRequiredBase,
      DATABASE_HTTP_STATEMENT_TIMEOUT_MS: '5000',
    });
    expect(parsed.success).toBe(true);
  });

  // sec-B5 / sec-B6 — Stripe production guards. Without these, a typo or
  // missing GitHub secret silently puts the system into "fictional mode"
  // (subscriptions persist locally but never charge), and a wrong-mode key
  // (sk_test_ in prod) silently freezes subscription state because every
  // webhook HMAC fails.
  describe('Stripe production guards (sec-B5 / sec-B6)', () => {
    it('rejects production env with only STRIPE_SECRET_KEY set (half-configured)', () => {
      const parsed = envSchema.safeParse({
        ...productionRequiredBase,
        STRIPE_SECRET_KEY: 'sk_live_X',
      });
      expect(parsed.success).toBe(false);
      const issue = parsed.success
        ? undefined
        : parsed.error.issues.find((i) => i.path.includes('STRIPE_WEBHOOK_SECRET'));
      expect(issue).toBeDefined();
    });

    it('rejects production env with only STRIPE_WEBHOOK_SECRET set (half-configured)', () => {
      const parsed = envSchema.safeParse({
        ...productionRequiredBase,
        STRIPE_WEBHOOK_SECRET: 'whsec_X',
      });
      expect(parsed.success).toBe(false);
      const issue = parsed.success
        ? undefined
        : parsed.error.issues.find((i) => i.path.includes('STRIPE_SECRET_KEY'));
      expect(issue).toBeDefined();
    });

    it('rejects production env with a test-mode STRIPE_SECRET_KEY (sk_test_*)', () => {
      const parsed = envSchema.safeParse({
        ...productionRequiredBase,
        STRIPE_SECRET_KEY: 'sk_test_X',
        STRIPE_WEBHOOK_SECRET: 'whsec_X',
      });
      expect(parsed.success).toBe(false);
      const issue = parsed.success
        ? undefined
        : parsed.error.issues.find((i) => i.path.includes('STRIPE_SECRET_KEY'));
      expect(issue).toBeDefined();
    });

    it('rejects malformed STRIPE_SECRET_KEY everywhere (no sk_test_/sk_live_ prefix)', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        STRIPE_SECRET_KEY: 'not-a-stripe-key',
        STRIPE_WEBHOOK_SECRET: 'whsec_X',
      });
      expect(parsed.success).toBe(false);
      const issue = parsed.success
        ? undefined
        : parsed.error.issues.find((i) => i.path.includes('STRIPE_SECRET_KEY'));
      expect(issue).toBeDefined();
    });

    it('rejects malformed STRIPE_WEBHOOK_SECRET everywhere (no whsec_ prefix)', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        STRIPE_SECRET_KEY: 'sk_test_X',
        STRIPE_WEBHOOK_SECRET: 'not-a-stripe-webhook',
      });
      expect(parsed.success).toBe(false);
      const issue = parsed.success
        ? undefined
        : parsed.error.issues.find((i) => i.path.includes('STRIPE_WEBHOOK_SECRET'));
      expect(issue).toBeDefined();
    });

    // sec-new-B3: comma-separated secret list validation
    it('sec-new-B3: accepts comma-separated list of valid whsec_ secrets', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        STRIPE_SECRET_KEY: 'sk_test_X',
        STRIPE_WEBHOOK_SECRET: 'whsec_old,whsec_new',
        EMAIL_FROM_ADDRESS: 'billing@example.com',
      });
      expect(parsed.success).toBe(true);
    });

    it('sec-new-B3: accepts comma-separated list with surrounding whitespace (copy-paste tolerance)', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        STRIPE_SECRET_KEY: 'sk_test_X',
        STRIPE_WEBHOOK_SECRET: '  whsec_first  ,  whsec_second  ,  ',
        EMAIL_FROM_ADDRESS: 'billing@example.com',
      });
      expect(parsed.success).toBe(true);
    });

    it('sec-new-B3: rejects comma-separated list where one segment lacks the whsec_ prefix', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        STRIPE_SECRET_KEY: 'sk_test_X',
        STRIPE_WEBHOOK_SECRET: 'whsec_valid,garbage',
        EMAIL_FROM_ADDRESS: 'billing@example.com',
      });
      expect(parsed.success).toBe(false);
      const issue = parsed.success
        ? undefined
        : parsed.error.issues.find((i) => i.path.includes('STRIPE_WEBHOOK_SECRET'));
      expect(issue).toBeDefined();
    });

    it('accepts production env with both Stripe keys set in live mode', () => {
      // sec-B #19: configuring Stripe also requires EMAIL_FROM_ADDRESS so the
      // Stripe customer email is built off a real owned domain (not @invalid).
      const parsed = envSchema.safeParse({
        ...productionRequiredBase,
        STRIPE_SECRET_KEY: 'sk_live_X',
        STRIPE_WEBHOOK_SECRET: 'whsec_X',
        EMAIL_FROM_ADDRESS: 'billing@example.com',
      });
      expect(parsed.success).toBe(true);
    });

    it('accepts production env with no Stripe keys at all (billing disabled)', () => {
      const parsed = envSchema.safeParse(productionRequiredBase);
      expect(parsed.success).toBe(true);
    });

    it('accepts non-production with sk_test_ + whsec_ (typical dev configuration)', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        STRIPE_SECRET_KEY: 'sk_test_X',
        STRIPE_WEBHOOK_SECRET: 'whsec_X',
        EMAIL_FROM_ADDRESS: 'billing@example.com',
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects Stripe configuration without EMAIL_FROM_ADDRESS (sec-B #19)', () => {
      // The prior fallback to `billing+<id>@invalid` silently routed Stripe
      // receipts/dunning/refund notifications to an RFC 6761 reserved TLD that
      // bounces permanently. Cross-field refine: Stripe ⇒ EMAIL_FROM_ADDRESS.
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        STRIPE_SECRET_KEY: 'sk_test_X',
        STRIPE_WEBHOOK_SECRET: 'whsec_X',
      });
      expect(parsed.success).toBe(false);
      const issue = parsed.success
        ? undefined
        : parsed.error.issues.find((i) => i.path.includes('EMAIL_FROM_ADDRESS'));
      expect(issue).toBeDefined();
    });
  });

  describe('retention upper bounds (audit-#14)', () => {
    it.each([
      ['NOTIFICATION_RETENTION_DAYS', '90000'],
      ['AUTH_SESSION_RETENTION_DAYS', '90000'],
      ['TOMBSTONE_RETENTION_DAYS', '90000'],
      ['STRIPE_WEBHOOK_EVENT_RETENTION_DAYS', '90000'],
      ['WEBHOOK_DELIVERY_ATTEMPT_RETENTION_DAYS', '36500'],
    ])('rejects an over-cap %s so a typo cannot disable cleanup', (key, value) => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        NODE_ENV: 'development',
        [key]: value,
      });
      expect(parsed.success).toBe(false);
      const issue = parsed.success
        ? undefined
        : parsed.error.issues.find((i) => i.path.includes(key));
      expect(issue).toBeDefined();
    });

    it('accepts retention values within the new bounds', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        NODE_ENV: 'development',
        NOTIFICATION_RETENTION_DAYS: '365',
        AUTH_SESSION_RETENTION_DAYS: '730',
        TOMBSTONE_RETENTION_DAYS: '730',
        STRIPE_WEBHOOK_EVENT_RETENTION_DAYS: '730',
        WEBHOOK_DELIVERY_ATTEMPT_RETENTION_DAYS: '180',
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe('JWT signing key strength (audit #8)', () => {
    it('rejects a non-PEM JWT_PRIVATE_KEY in production', () => {
      const parsed = envSchema.safeParse({
        ...productionRequiredBase,
        JWT_PRIVATE_KEY: 'not-a-pem',
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((i) => i.path[0] === 'JWT_PRIVATE_KEY')).toBe(true);
      }
    });

    it('rejects a sub-2048-bit RSA key in production', () => {
      const weakPair = generateKeyPairSync('rsa', {
        modulusLength: 1024,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const parsed = envSchema.safeParse({
        ...productionRequiredBase,
        JWT_PRIVATE_KEY: weakPair.privateKey,
        JWT_PUBLIC_KEY: weakPair.publicKey,
      });
      expect(parsed.success).toBe(false);
    });

    it('accepts a valid ≥2048-bit RSA pair in production', () => {
      const parsed = envSchema.safeParse(productionRequiredBase);
      expect(parsed.success).toBe(true);
    });

    it('still accepts short placeholder keys outside deployed runtimes (local/test/dev)', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        NODE_ENV: 'development',
        JWT_PRIVATE_KEY: 'private',
        JWT_PUBLIC_KEY: 'public',
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe('global rate-limit ceiling (audit #34)', () => {
    it('rejects RATE_LIMIT_MAX above the 100_000 ceiling (fat-finger guard)', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        NODE_ENV: 'development',
        RATE_LIMIT_MAX: '1000000',
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((i) => i.path[0] === 'RATE_LIMIT_MAX')).toBe(true);
      }
    });

    it('accepts a sane RATE_LIMIT_MAX', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        NODE_ENV: 'development',
        RATE_LIMIT_MAX: '500',
      });
      expect(parsed.success && parsed.data.RATE_LIMIT_MAX).toBe(500);
    });
  });

  describe('unauthenticated /reference production guard (audit #7)', () => {
    it('rejects ENABLE_API_REFERENCE=true in production without the explicit override', () => {
      const parsed = envSchema.safeParse({
        ...productionRequiredBase,
        ENABLE_API_REFERENCE: 'true',
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((i) => i.path[0] === 'ENABLE_API_REFERENCE')).toBe(true);
      }
    });

    it('allows ENABLE_API_REFERENCE=true in production with API_REFERENCE_ALLOW_PRODUCTION=true', () => {
      const parsed = envSchema.safeParse({
        ...productionRequiredBase,
        ENABLE_API_REFERENCE: 'true',
        API_REFERENCE_ALLOW_PRODUCTION: 'true',
      });
      expect(parsed.success).toBe(true);
    });

    it('allows ENABLE_API_REFERENCE=true outside production (dev/local)', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        NODE_ENV: 'development',
        ENABLE_API_REFERENCE: 'true',
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe('Bull-Board queue dashboard production guard (re-audit A1)', () => {
    it('rejects ENABLE_QUEUE_DASHBOARD=true in production without the explicit override', () => {
      const parsed = envSchema.safeParse({
        ...productionRequiredBase,
        ENABLE_QUEUE_DASHBOARD: 'true',
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((i) => i.path[0] === 'ENABLE_QUEUE_DASHBOARD')).toBe(true);
      }
    });

    it('allows ENABLE_QUEUE_DASHBOARD=true in production with QUEUE_DASHBOARD_ALLOW_PRODUCTION=true', () => {
      const parsed = envSchema.safeParse({
        ...productionRequiredBase,
        ENABLE_QUEUE_DASHBOARD: 'true',
        QUEUE_DASHBOARD_ALLOW_PRODUCTION: 'true',
      });
      expect(parsed.success).toBe(true);
    });

    it('allows ENABLE_QUEUE_DASHBOARD=true outside production (dev/local)', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        NODE_ENV: 'development',
        ENABLE_QUEUE_DASHBOARD: 'true',
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe('WEBHOOK_URL_ALLOWLIST wildcard guard (audit #32)', () => {
    it('rejects an over-broad single-label wildcard (`*.com`)', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        NODE_ENV: 'development',
        WEBHOOK_URL_ALLOWLIST: '*.com',
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((i) => i.path[0] === 'WEBHOOK_URL_ALLOWLIST')).toBe(true);
      }
    });

    it('rejects an over-broad wildcard mixed with valid entries', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        NODE_ENV: 'development',
        WEBHOOK_URL_ALLOWLIST: 'hooks.example.com, *.io',
      });
      expect(parsed.success).toBe(false);
    });

    it('accepts a registrable-domain wildcard and exact hosts', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        NODE_ENV: 'development',
        WEBHOOK_URL_ALLOWLIST: '*.example.com, hooks.partner.io',
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe('audit-#L1: committed test JWT keypair rejection', () => {
    // Read the ACTUAL committed test key so this test self-updates if the key is ever rotated.
    const readCommittedTestKey = (marker: string): string => {
      const source = readFileSync(join(process.cwd(), 'src/tests/setup.ts'), 'utf8');
      const match = source.match(
        new RegExp(`-----BEGIN ${marker}-----[\\s\\S]*?-----END ${marker}-----`),
      );
      if (!match) throw new Error(`test ${marker} not found in src/tests/setup.ts`);
      return `${match[0]}\n`;
    };
    const COMMITTED_TEST_PRIVATE_KEY = readCommittedTestKey('PRIVATE KEY');
    const COMMITTED_TEST_PUBLIC_KEY = readCommittedTestKey('PUBLIC KEY');

    it('rejects the committed test keypair in production', () => {
      const parsed = envSchema.safeParse({
        ...productionRequiredBase,
        JWT_PRIVATE_KEY: COMMITTED_TEST_PRIVATE_KEY,
        JWT_PUBLIC_KEY: COMMITTED_TEST_PUBLIC_KEY,
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((issue) => issue.path.includes('JWT_PRIVATE_KEY'))).toBe(
          true,
        );
      }
    });

    it('accepts the committed test key OUTSIDE production (the refine is production-gated)', () => {
      const parsed = envSchema.safeParse({
        ...commonRequiredBase,
        NODE_ENV: 'development',
        JWT_PRIVATE_KEY: COMMITTED_TEST_PRIVATE_KEY,
        JWT_PUBLIC_KEY: COMMITTED_TEST_PUBLIC_KEY,
      });
      expect(parsed.success).toBe(true);
    });

    it('accepts a fresh production RSA keypair (control)', () => {
      const parsed = envSchema.safeParse({ ...productionRequiredBase });
      expect(parsed.success).toBe(true);
    });
  });
});

describe('envSchemaDefaults', () => {
  it('resolves concrete stringified defaults for keys that declare one', () => {
    // Post-transform + stringified: booleanString → 'false', z.coerce.number().default(3000) →
    // '3000', z.enum([...]).default('info') → 'info'.
    expect(envSchemaDefaults.PORT).toBe('3000');
    expect(envSchemaDefaults.HTTP_BIND_HOST).toBe('0.0.0.0');
    expect(envSchemaDefaults.LOG_LEVEL).toBe('info');
    expect(envSchemaDefaults.CAPTCHA_PROVIDER).toBe('disabled');
    expect(envSchemaDefaults.CAPTCHA_FAIL_OPEN).toBe('false');
    expect(envSchemaDefaults.ENABLE_MCP_SERVER).toBe('false');
    expect(envSchemaDefaults.SECRETS_ENCRYPTION_CURRENT_VERSION).toBe('v1');
  });

  it('omits required and optional-without-default keys (they resolve to undefined)', () => {
    // A key with no resolvable default is ABSENT from the map, so github:sync always pushes it —
    // it can never be mistaken for a schema default and dropped.
    expect(envSchemaDefaults).not.toHaveProperty('DATABASE_URL'); // required
    expect(envSchemaDefaults).not.toHaveProperty('REDIS_URL'); // required
    expect(envSchemaDefaults).not.toHaveProperty('JWT_PRIVATE_KEY'); // required
    expect(envSchemaDefaults).not.toHaveProperty('CAPTCHA_SECRET'); // optional, no default
    expect(envSchemaDefaults).not.toHaveProperty('SENTRY_DSN'); // optional, no default
    expect(envSchemaDefaults).not.toHaveProperty('FASTIFY_KEEP_ALIVE_TIMEOUT_MS'); // optional, no default
  });

  it('matches the value the runtime actually falls back to for each defaulted key', () => {
    // The whole point: an unset variable boots to exactly this value, so the github:sync skip is
    // behaviour-preserving. Prove the map equals what envSchema.parse applies.
    const parsed = envSchema.safeParse({ ...commonRequiredBase, NODE_ENV: 'development' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(String(parsed.data.PORT)).toBe(envSchemaDefaults.PORT);
      expect(String(parsed.data.RATE_LIMIT_MAX)).toBe(envSchemaDefaults.RATE_LIMIT_MAX);
      expect(String(parsed.data.LOG_LEVEL)).toBe(envSchemaDefaults.LOG_LEVEL);
      expect(String(parsed.data.CAPTCHA_FAIL_OPEN)).toBe(envSchemaDefaults.CAPTCHA_FAIL_OPEN);
    }
  });

  it('every default is a plain string (safe to string-compare against a .env file value)', () => {
    for (const value of Object.values(envSchemaDefaults)) {
      expect(typeof value).toBe('string');
    }
  });
});
