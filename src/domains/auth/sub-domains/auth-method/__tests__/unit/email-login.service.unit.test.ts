import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import { UnauthorizedError } from '@/shared/errors/index.js';
import { mockedRedisSet } from '@/tests/helpers/redis-mock.helper.js';
import { EmailLoginService } from '@/domains/auth/sub-domains/auth-method/email-login.service.js';
import type { UserService } from '@/domains/user/user.service.js';

vi.mock('@/domains/auth/shared/complete-first-factor-auth.js', () => ({
  completeFirstFactorAuth: vi.fn().mockResolvedValue({
    access_token: 'jwt-token',
    session_public_id: 'session_public',
    session_refresh_secret: 'refresh_secret',
  }),
}));

// sendCode/login wrap their writes in withTransaction + runWithPinnedDatabaseHandle; invoke the
// callbacks directly so the unit test exercises the flow without a real database/transaction.
vi.mock('@/infrastructure/database/transaction.js', () => ({
  withTransaction: vi.fn((callback: (transaction: unknown) => unknown) => callback({})),
}));

vi.mock('@/infrastructure/database/contexts/request-database.context.js', () => ({
  runWithPinnedDatabaseHandle: vi.fn((_handle: unknown, callback: () => unknown) => callback()),
  getRequestDatabase: vi.fn(() => ({})),
}));

vi.mock('@/core/events/event-bus.js', () => ({
  eventBus: {
    emit: vi.fn().mockResolvedValue(undefined),
    emitStrict: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/shared/utils/text/email.util.js', () => ({
  isDisposableEmailBlocked: vi.fn(() => false),
}));

vi.mock('@/shared/utils/security/anti-enumeration.util.js', () => ({
  enforceMinimumDuration: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/shared/config/env.config.js', () => {
  const env = {
    NODE_ENV: 'development',
    // LOG_LEVEL is consumed at import time by logger.util.ts (pino); the mock must carry it so
    // module-init order can never surface `pino({ level: undefined })`.
    LOG_LEVEL: 'info',
    AUTH_SESSION_MAX_AGE_DAYS: 7,
    PERSONAL_ORGANIZATION_ENABLED: false,
    SECRETS_ENCRYPTION_KEY: 'test-secret-encryption-key-for-verification-code-pepper',
    // TEST_MODE gates the send-code `debug_verification_code` affordance; the Vitest harness runs
    // TEST_MODE=true. A test can flip this on the mock object to exercise the disabled path.
    TEST_MODE: true,
  };
  return { env, getEnv: () => env };
});

// EmailLoginService imports `redisConnection` (default constructor dep) — stub the client module so a
// real Redis connection is never constructed in this unit test. The constructor receives an explicit
// `redis` stub below.
vi.mock('@/infrastructure/cache/redis.client.js', () => ({
  redisConnection: {},
}));

vi.mock('@/domains/tenancy/sub-domains/organization/resolve-active-organization.js', () => ({
  ensurePersonalOrganization: vi.fn().mockResolvedValue(undefined),
}));

import { eventBus } from '@/core/events/event-bus.js';
import { env } from '@/shared/config/env.config.js';
import { AUTH_EVENT } from '@/domains/auth/sub-domains/auth-method/events/auth.events.js';
import { completeFirstFactorAuth } from '@/domains/auth/shared/complete-first-factor-auth.js';
import { ensurePersonalOrganization } from '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import type { MfaService } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa.service.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import type { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { VerificationTokenRepository } from '@/domains/auth/sub-domains/auth-method/verification-token/verification-token.repository.js';

const user = {
  id: 1,
  public_id: 'abcdefghijklmnopqrstu',
  email: 'user@example.com',
  status: 'ACTIVE',
  is_email_verified: false,
  is_mfa_enabled: false,
  deleted_at: null,
};

describe('EmailLoginService', () => {
  const userService = {
    findByEmail: vi.fn(),
    createForEmailCode: vi.fn(),
    updateEmailVerified: vi.fn().mockResolvedValue(user),
    requireUserRecordByPublicId: vi.fn(),
  } as unknown as UserService;

  const organizationSettingsService = {
    userHasOrganizationRequiringMfa: vi.fn().mockResolvedValue(false),
  } as unknown as OrganizationSettingsService;

  const mfaService = {
    createMfaSession: vi.fn(),
  } as unknown as MfaService;

  const authSessionService = {
    createSessionForUser: vi.fn().mockResolvedValue({ public_id: 'session_public' }),
  } as unknown as AuthSessionService;

  const authMethodService = {
    createEmailCodeMethod: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthMethodService;

  const verificationTokenRepository = {
    create: vi.fn().mockResolvedValue(undefined),
    consumeOtpForUser: vi.fn(),
    findValidByTokenHash: vi.fn(),
    invalidateAllForUser: vi.fn().mockResolvedValue(undefined),
  } as unknown as VerificationTokenRepository;

  // incrementWithExpiryOnFirst (real util) calls redis.eval and returns the attempt count;
  // 1 = under the cap by default, del clears it on success. `set` is the SET NX EX cooldown claim;
  // 'OK' (default) = slot claimed → send proceeds; null = on cooldown → send is skipped.
  const redis = {
    eval: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(0),
    set: vi.fn().mockResolvedValue('OK'),
  } as unknown as Redis;

  const service = new EmailLoginService(
    userService,
    verificationTokenRepository,
    organizationSettingsService,
    mfaService,
    authSessionService,
    authMethodService,
    redis,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(redis.eval).mockResolvedValue(1);
    mockedRedisSet(redis.set).mockResolvedValue('OK');
  });

  it('sendCode auto-signs-up an unknown email then issues a code', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    vi.mocked(userService.createForEmailCode).mockResolvedValue(user as never);

    const result = await service.sendCode({ email: 'new-user@example.com' });

    expect(userService.createForEmailCode).toHaveBeenCalledWith({ email: 'new-user@example.com' });
    expect(authMethodService.createEmailCodeMethod).toHaveBeenCalledWith(user.id, user.public_id);
    expect(verificationTokenRepository.create).toHaveBeenCalled();
    expect(vi.mocked(eventBus.emitStrict)).toHaveBeenCalledTimes(1);
    expect(result.messageKey).toBe('success:verificationCodeSent');
  });

  it('sendCode falls back to the existing user when the create races a unique violation', async () => {
    vi.mocked(userService.findByEmail)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(user as never);
    vi.mocked(userService.createForEmailCode).mockRejectedValue({ code: '23505' });

    const result = await service.sendCode({ email: user.email });

    // No 409 — email login is auto-signup; it converges on the existing user and still issues a code.
    expect(result.messageKey).toBe('success:verificationCodeSent');
    expect(verificationTokenRepository.create).toHaveBeenCalled();
    expect(vi.mocked(eventBus.emitStrict)).toHaveBeenCalledTimes(1);
  });

  it('sendCode issues a single live code, invalidating prior unused codes', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

    const result = await service.sendCode({ email: user.email });

    expect(userService.createForEmailCode).not.toHaveBeenCalled();
    // Single live code: a fresh send invalidates the user's prior unused EMAIL_CODE codes so only the
    // newest is redeemable.
    expect(verificationTokenRepository.invalidateAllForUser).toHaveBeenCalledWith(
      user.id,
      'EMAIL_CODE',
    );
    expect(verificationTokenRepository.create).toHaveBeenCalled();
    // The raw `verification_code`/`code` key never leaves via the result — only via the event payload.
    expect(result).not.toHaveProperty('code');
    expect(result).not.toHaveProperty('verification_code');
    const emittedEvent = vi.mocked(eventBus.emitStrict).mock.calls[0]?.[0];
    expect(emittedEvent?.type).toBe(AUTH_EVENT.EMAIL_VERIFICATION_CODE_REQUESTED);
    const emittedPayload = emittedEvent?.payload as { verification_code: string };
    expect(emittedPayload.verification_code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('sendCode echoes debug_verification_code under TEST_MODE (matches the emitted code)', async () => {
    // The Vitest harness runs with TEST_MODE=true (src/tests/setup.ts), so the TEST_MODE-only
    // affordance is active: the result carries the plaintext code for out-of-process test clients.
    // A `.refine()` forbids TEST_MODE=true in production and it is never set on a deployed runtime, so
    // this key is absent everywhere real (see env-schema.unit.test.ts `rejects TEST_MODE=true in production`).
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

    const result = await service.sendCode({ email: user.email });

    const emittedPayload = vi.mocked(eventBus.emitStrict).mock.calls[0]?.[0]?.payload as {
      verification_code: string;
    };
    expect(result.debug_verification_code).toBe(emittedPayload.verification_code);
    expect(result.debug_verification_code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('sendCode omits debug_verification_code when no code is issued (cooldown held) even under TEST_MODE', async () => {
    mockedRedisSet(redis.set).mockResolvedValueOnce(null); // cooldown already held → no issue, no code
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

    const result = await service.sendCode({ email: user.email });

    expect(result).not.toHaveProperty('debug_verification_code');
  });

  it('sendCode NEVER exposes debug_verification_code when TEST_MODE is off (even though a code is issued)', async () => {
    // Security-critical: the affordance is gated strictly on env.TEST_MODE. A .refine() forbids
    // TEST_MODE=true in production (env-schema.unit.test.ts), so a deployed runtime always takes this
    // path — the code is issued/emailed but never echoed to the caller.
    const envMutable = env as unknown as { TEST_MODE: boolean };
    envMutable.TEST_MODE = false;
    try {
      vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

      const result = await service.sendCode({ email: user.email });

      expect(vi.mocked(eventBus.emitStrict)).toHaveBeenCalled(); // a code WAS issued + emailed
      expect(result).not.toHaveProperty('debug_verification_code'); // but never returned
    } finally {
      envMutable.TEST_MODE = true;
    }
  });

  it('sendCode resets the per-user verify-attempt cap so a fresh code restores the budget', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

    await service.sendCode({ email: user.email });

    expect(redis.del).toHaveBeenCalledWith(`auth:email_code_verify_attempts:${user.id}`);
  });

  it('sendCode skips issuing (no signup, no email) when the per-email cooldown is already held', async () => {
    mockedRedisSet(redis.set).mockResolvedValueOnce(null);
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

    const result = await service.sendCode({ email: user.email });

    expect(result.messageKey).toBe('success:verificationCodeSent');
    expect(userService.findByEmail).not.toHaveBeenCalled();
    expect(userService.createForEmailCode).not.toHaveBeenCalled();
    expect(verificationTokenRepository.create).not.toHaveBeenCalled();
    expect(vi.mocked(eventBus.emitStrict)).not.toHaveBeenCalled();
  });

  it('sendCode fails open and still issues a code when the cooldown Redis SET rejects (Redis down)', async () => {
    mockedRedisSet(redis.set).mockRejectedValueOnce(new Error("Stream isn't writeable"));
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

    const result = await service.sendCode({ email: user.email });

    expect(result.messageKey).toBe('success:verificationCodeSent');
    expect(verificationTokenRepository.create).toHaveBeenCalled();
    expect(vi.mocked(eventBus.emitStrict)).toHaveBeenCalledTimes(1);
  });

  it('sendCode does not fail when the best-effort attempt-counter reset rejects (Redis down)', async () => {
    vi.mocked(redis.del).mockRejectedValueOnce(new Error("Stream isn't writeable"));
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);

    const result = await service.sendCode({ email: user.email });

    expect(result.messageKey).toBe('success:verificationCodeSent');
    expect(vi.mocked(eventBus.emitStrict)).toHaveBeenCalledTimes(1);
  });

  it('sendCode enforces a constant-time floor on both account-existence branches', async () => {
    const { enforceMinimumDuration } = await import(
      '@/shared/utils/security/anti-enumeration.util.js'
    );
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    vi.mocked(userService.createForEmailCode).mockResolvedValue(user as never);
    await service.sendCode({ email: 'missing@example.com' });
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    await service.sendCode({ email: user.email });
    expect(vi.mocked(enforceMinimumDuration)).toHaveBeenCalledTimes(2);
  });

  it('sendCode rejects disposable email addresses', async () => {
    const emailUtil = await import('@/shared/utils/text/email.util.js');
    vi.mocked(emailUtil.isDisposableEmailBlocked).mockReturnValueOnce(true);
    await expect(service.sendCode({ email: 'temp@mailinator.com' })).rejects.toThrow();
    expect(userService.createForEmailCode).not.toHaveBeenCalled();
  });

  it('login creates a session, marks the email verified, and invalidates the other live codes', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue({
      token_type: 'EMAIL_CODE',
      user_id: user.id,
    } as never);

    const result = await service.login(
      { email: user.email, code: 'ABCDEF' },
      '127.0.0.1',
      'vitest',
    );
    if (!('access_token' in result)) throw new Error('expected access token result');

    expect(verificationTokenRepository.consumeOtpForUser).toHaveBeenCalledWith(
      user.id,
      'EMAIL_CODE',
      expect.any(String),
    );
    // §2a(c): the first successful use invalidates the user's remaining live codes (single-use set).
    expect(verificationTokenRepository.invalidateAllForUser).toHaveBeenCalledWith(
      user.id,
      'EMAIL_CODE',
    );
    expect(userService.updateEmailVerified).toHaveBeenCalledWith(user.public_id);
    expect(result.access_token).toBe('jwt-token');
    expect(redis.del).toHaveBeenCalled();
  });

  it('sec-U1: login refuses to mint a session when the account was SUSPENDED between code issue and login', async () => {
    // `findByEmail` filters only soft-deleted, so a suspended user reaches the consume+active-guard.
    // The just-consumed code proves email control, but a suspended account must NOT get a session
    // (TOCTOU: ACTIVE when the code was issued, suspended before login completed).
    vi.mocked(userService.findByEmail).mockResolvedValue({ ...user, status: 'SUSPENDED' } as never);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue({
      token_type: 'EMAIL_CODE',
      user_id: user.id,
    } as never);

    await expect(
      service.login({ email: user.email, code: 'ABCDEF' }, '127.0.0.1', 'vitest'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(authSessionService.createSessionForUser).not.toHaveBeenCalled();
  });

  it('login rejects an unknown email without consuming a code', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    await expect(
      service.login({ email: 'missing@example.com', code: 'ABCDEF' }, '127.0.0.1'),
    ).rejects.toThrow();
    expect(verificationTokenRepository.consumeOtpForUser).not.toHaveBeenCalled();
  });

  it('login rejects once the per-user attempt cap is exceeded', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(redis.eval).mockResolvedValueOnce(99);
    await expect(
      service.login({ email: user.email, code: 'ABCDEF' }, '127.0.0.1'),
    ).rejects.toThrow();
    expect(verificationTokenRepository.consumeOtpForUser).not.toHaveBeenCalled();
  });

  it('login enforces a constant-time floor on the unknown-email and attempt-cap branches', async () => {
    const { enforceMinimumDuration } = await import(
      '@/shared/utils/security/anti-enumeration.util.js'
    );

    // Unknown-email branch rejects after a single lookup but must still apply the floor, so its
    // latency cannot be distinguished from the slower known-email path (account-existence oracle).
    vi.mocked(userService.findByEmail).mockResolvedValueOnce(null);
    await expect(
      service.login({ email: 'missing@example.com', code: 'ABCDEF' }, '127.0.0.1'),
    ).rejects.toThrow();

    // Attempt-cap branch: a known email over the per-user cap.
    vi.mocked(userService.findByEmail).mockResolvedValueOnce(user as never);
    vi.mocked(redis.eval).mockResolvedValueOnce(99);
    await expect(
      service.login({ email: user.email, code: 'ABCDEF' }, '127.0.0.1'),
    ).rejects.toThrow();

    expect(vi.mocked(enforceMinimumDuration)).toHaveBeenCalledTimes(2);
  });

  it('login rejects a wrong or expired code', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null);
    await expect(
      service.login({ email: user.email, code: 'ZZZZZZ' }, '127.0.0.1'),
    ).rejects.toThrow();
  });

  /**
   * TEST_STATIC_VERIFICATION_CODE — the local/development escape hatch that lets a caller log in
   * without the `send-code` round trip. The env schema refines it to `undefined` in production,
   * so these paths cannot exist on a deployed runtime; what the suite pins is that switching it
   * on skips ONLY the stored-code lookup and weakens nothing else.
   */
  describe('login with TEST_STATIC_VERIFICATION_CODE', () => {
    const FIXED = 'TEST24';

    beforeEach(() => {
      (env as { TEST_STATIC_VERIFICATION_CODE?: string }).TEST_STATIC_VERIFICATION_CODE = FIXED;
    });

    afterEach(() => {
      delete (env as { TEST_STATIC_VERIFICATION_CODE?: string }).TEST_STATIC_VERIFICATION_CODE;
    });

    it('authenticates an existing user without any stored code being consumed', async () => {
      vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
      // No token row exists — send-code was never called. The fixed-code branch must not need one.
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null);

      const result = await service.login({ email: user.email, code: FIXED }, '127.0.0.1', 'vitest');

      if (!('access_token' in result)) throw new Error('expected access token result');
      expect(verificationTokenRepository.consumeOtpForUser).not.toHaveBeenCalled();
    });

    // Matched through normalizeVerificationCode, the same helper a real code goes through, so a
    // lowercase entry behaves like the uppercase one. Separators and other lengths never reach
    // this comparison — EmailLoginDto already constrains the field to 6 alphanumeric characters.
    it('matches case-insensitively, as a real code does', async () => {
      vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null);

      const result = await service.login(
        { email: user.email, code: 'test24' },
        '127.0.0.1',
        'vitest',
      );

      if (!('access_token' in result)) throw new Error('expected access token result');
      expect(verificationTokenRepository.consumeOtpForUser).not.toHaveBeenCalled();
    });

    it('still rejects a code that is not the fixed one, falling back to the stored-code lookup', async () => {
      vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null);

      await expect(
        service.login({ email: user.email, code: 'ZZZZZZ' }, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedError);
      // The wrong code took the normal path, so the stored-code lookup still ran.
      expect(verificationTokenRepository.consumeOtpForUser).toHaveBeenCalled();
    });

    it('never creates an account — an unknown email is still rejected', async () => {
      vi.mocked(userService.findByEmail).mockResolvedValue(null as never);

      await expect(
        service.login({ email: 'nobody@example.com', code: FIXED }, '127.0.0.1'),
      ).rejects.toThrow(UnauthorizedError);
      expect(userService.createForEmailCode).not.toHaveBeenCalled();
    });

    it('does not bypass the per-user verify-attempt cap', async () => {
      vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
      // Over the cap: incrementWithExpiryOnFirst returns a count above the allowed maximum.
      vi.mocked(redis.eval).mockResolvedValueOnce(999 as never);

      await expect(service.login({ email: user.email, code: FIXED }, '127.0.0.1')).rejects.toThrow(
        UnauthorizedError,
      );
    });

    it('does not bypass the account-active assertion', async () => {
      vi.mocked(userService.findByEmail).mockResolvedValue({
        ...user,
        status: 'SUSPENDED',
      } as never);
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null);

      await expect(
        service.login({ email: user.email, code: FIXED }, '127.0.0.1'),
      ).rejects.toThrow();
    });

    it('has no effect at all when the env var is unset (the default)', async () => {
      delete (env as { TEST_STATIC_VERIFICATION_CODE?: string }).TEST_STATIC_VERIFICATION_CODE;
      vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null);

      await expect(service.login({ email: user.email, code: FIXED }, '127.0.0.1')).rejects.toThrow(
        UnauthorizedError,
      );
      expect(verificationTokenRepository.consumeOtpForUser).toHaveBeenCalled();
    });
  });

  it('login enforces the constant-time floor on the known-account wrong-code branch (anti-enumeration)', async () => {
    const { enforceMinimumDuration } = await import(
      '@/shared/utils/security/anti-enumeration.util.js'
    );
    // Known email + wrong code must be timing-indistinguishable from the unknown-email 401, else the
    // latency delta is an account-existence oracle. The wrong-code throw is inside the code-consume
    // transaction, so the floor is applied in the catch outside it.
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(redis.eval).mockResolvedValue(1);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null);
    await expect(
      service.login({ email: user.email, code: 'ZZZZZZ' }, '127.0.0.1'),
    ).rejects.toThrow();
    expect(vi.mocked(enforceMinimumDuration)).toHaveBeenCalledTimes(1);
  });

  it('login propagates a downstream session/MFA failure so the code consume rolls back', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue({
      token_type: 'EMAIL_CODE',
      user_id: user.id,
    } as never);
    vi.mocked(completeFirstFactorAuth).mockRejectedValueOnce(new Error('session insert failed'));

    await expect(service.login({ email: user.email, code: 'ABCDEF' }, '127.0.0.1')).rejects.toThrow(
      'session insert failed',
    );
    expect(verificationTokenRepository.consumeOtpForUser).toHaveBeenCalled();
    // The success-only attempt-counter clear must NOT run when login throws.
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('login provisions the personal org on the first verification (claims a bare invited account)', async () => {
    env.PERSONAL_ORGANIZATION_ENABLED = true;
    try {
      vi.mocked(userService.findByEmail).mockResolvedValue({
        ...user,
        is_email_verified: false,
      } as never);
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue({
        token_type: 'EMAIL_CODE',
        user_id: user.id,
      } as never);

      await service.login({ email: user.email, code: 'ABCDEF' }, '127.0.0.1', 'vitest');

      expect(vi.mocked(ensurePersonalOrganization)).toHaveBeenCalledWith(user.id);
    } finally {
      env.PERSONAL_ORGANIZATION_ENABLED = false;
    }
  });

  it('login does not re-provision a personal org for an already-verified returning user', async () => {
    env.PERSONAL_ORGANIZATION_ENABLED = true;
    try {
      vi.mocked(userService.findByEmail).mockResolvedValue({
        ...user,
        is_email_verified: true,
      } as never);
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue({
        token_type: 'EMAIL_CODE',
        user_id: user.id,
      } as never);

      await service.login({ email: user.email, code: 'ABCDEF' }, '127.0.0.1', 'vitest');

      expect(vi.mocked(ensurePersonalOrganization)).not.toHaveBeenCalled();
    } finally {
      env.PERSONAL_ORGANIZATION_ENABLED = false;
    }
  });

  it('does not provision a personal org in team-only mode (env flag off)', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    vi.mocked(userService.createForEmailCode).mockResolvedValue(user as never);
    await service.sendCode({ email: 'team-only@example.com' });
    expect(vi.mocked(ensurePersonalOrganization)).not.toHaveBeenCalled();
  });

  describe('verifyCodeForStepUp (bootstrap-only email-code step-up, item #8)', () => {
    const passwordlessUser = { ...user, is_mfa_enabled: false, password_hash: null };

    it('consumes the code for a passwordless-no-MFA account and mints NO session', async () => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(
        passwordlessUser as never,
      );
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue({
        id: 9,
      } as never);

      await expect(
        service.verifyCodeForStepUp({ userPublicId: passwordlessUser.public_id, code: 'ABC123' }),
      ).resolves.toBeUndefined();

      expect(verificationTokenRepository.consumeOtpForUser).toHaveBeenCalled();
      expect(verificationTokenRepository.invalidateAllForUser).toHaveBeenCalledWith(
        passwordlessUser.id,
        'EMAIL_CODE',
      );
      // No session is minted (unlike login) — this only opens a step-up window.
      expect(completeFirstFactorAuth).not.toHaveBeenCalled();
    });

    it('rejects an MFA-enabled account before consuming any code (preserves the MFA invariant)', async () => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue({
        ...passwordlessUser,
        is_mfa_enabled: true,
      } as never);
      await expect(
        service.verifyCodeForStepUp({ userPublicId: passwordlessUser.public_id, code: 'ABC123' }),
      ).rejects.toMatchObject({ messageKey: 'errors:mfaStepUpRequired' });
      expect(verificationTokenRepository.consumeOtpForUser).not.toHaveBeenCalled();
    });

    it('rejects an account that has a password (email-code step-up is passwordless-only)', async () => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue({
        ...passwordlessUser,
        password_hash: 'argon2-hash',
      } as never);
      await expect(
        service.verifyCodeForStepUp({ userPublicId: passwordlessUser.public_id, code: 'ABC123' }),
      ).rejects.toMatchObject({ messageKey: 'errors:passwordStepUpRequired' });
      expect(verificationTokenRepository.consumeOtpForUser).not.toHaveBeenCalled();
    });

    it('rejects a wrong/expired code (no matching token consumed)', async () => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(
        passwordlessUser as never,
      );
      vi.mocked(verificationTokenRepository.consumeOtpForUser).mockResolvedValue(null as never);
      await expect(
        service.verifyCodeForStepUp({ userPublicId: passwordlessUser.public_id, code: 'ABC123' }),
      ).rejects.toMatchObject({ messageKey: 'errors:invalidOrExpiredVerificationCode' });
      expect(verificationTokenRepository.invalidateAllForUser).not.toHaveBeenCalled();
    });

    it('rejects once the per-user attempt cap is exceeded, before consuming any code (parity with login)', async () => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(
        passwordlessUser as never,
      );
      // Over the shared EMAIL_CODE_VERIFY_ATTEMPT cap → reject before touching the token store.
      vi.mocked(redis.eval).mockResolvedValueOnce(99);
      await expect(
        service.verifyCodeForStepUp({ userPublicId: passwordlessUser.public_id, code: 'ABC123' }),
      ).rejects.toMatchObject({ messageKey: 'errors:invalidOrExpiredVerificationCode' });
      expect(verificationTokenRepository.consumeOtpForUser).not.toHaveBeenCalled();
    });
  });
});
