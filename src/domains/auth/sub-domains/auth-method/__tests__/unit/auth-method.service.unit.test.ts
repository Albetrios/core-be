import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/shared/errors/index.js';
import { MAX_LINKED_AUTH_METHODS_PER_USER } from '@/shared/constants/security.constants.js';
import { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { AuthMethodRepository } from '@/domains/auth/sub-domains/auth-method/auth-method.repository.js';
import type { Redis } from 'ioredis';
import { mockedRedisSet } from '@/tests/helpers/redis-mock.helper.js';
import type { VerificationTokenRepository } from '@/domains/auth/sub-domains/auth-method/verification-token/verification-token.repository.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import type * as EventBusModule from '@/core/events/event-bus.js';

vi.mock('@/core/events/event-bus.js', async (importOriginal) => {
  const original = await importOriginal<typeof EventBusModule>();
  return {
    ...original,
    eventBus: {
      emit: vi.fn().mockResolvedValue(undefined),
      emitStrict: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock('@/shared/utils/security/password.util.js', () => ({
  hashPassword: vi.fn().mockResolvedValue('hashed'),
  verifyPassword: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock('@/shared/utils/text/email.util.js', () => ({
  isDisposableEmailBlocked: vi.fn(() => false),
}));

vi.mock('@/shared/utils/security/anti-enumeration.util.js', () => ({
  enforceMinimumDuration: vi.fn().mockResolvedValue(undefined),
}));

// resetPassword now runs inside withTransaction + runWithPinnedDatabaseHandle; invoke the
// callbacks directly so the unit test exercises the flow without a real database/transaction.
vi.mock('@/infrastructure/database/transaction.js', () => ({
  withTransaction: vi.fn((callback: (transaction: unknown) => unknown) => callback({})),
}));

vi.mock(
  '@/infrastructure/database/contexts/database-context-runtime.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      runWithPinnedDatabaseHandle: vi.fn((_handle: unknown, callback: () => unknown) => callback()),
      getRequestDatabase: vi.fn(() => ({})),
      setLocalDatabaseConfig: vi.fn().mockResolvedValue(undefined),
    };
  },
);

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Blanket maintenance passthrough: services this suite touches (directly or via
    // cross-domain imports) may enter maintenance contexts (tombstoning, admin reads) —
    // the real wrapper opens a database.transaction() and CI's unit lane has no Postgres.
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
    withPrincipalDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

const user = {
  id: 1,
  public_id: 'user_public',
  email: 'user@example.com',
  password_hash: 'hash',
  is_email_verified: false,
  status: 'ACTIVE',
};

describe('AuthMethodService', () => {
  const userService = {
    requireUserRecordByPublicId: vi.fn().mockResolvedValue(user),
    findByEmail: vi.fn().mockResolvedValue(user),
    findById: vi.fn().mockResolvedValue(user),
    updatePassword: vi.fn().mockResolvedValue(user),
    updateEmailVerified: vi.fn().mockResolvedValue(user),
    updateLoginAttempt: vi.fn().mockResolvedValue(user),
  } as unknown as UserService;

  const authMethodRepository = {
    listByUserId: vi.fn().mockResolvedValue([]),
    countActiveByUserId: vi.fn().mockResolvedValue(0),
    acquireCredentialMutationLock: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({ id: 2 }),
    revoke: vi.fn().mockResolvedValue({ id: 2 }),
    revokeUnlessLastLoginCapable: vi.fn().mockResolvedValue({ id: 2 }),
    revokeAllByUserId: vi.fn().mockResolvedValue(1),
    findByProviderUserId: vi.fn().mockResolvedValue(null),
    findTotpByUserId: vi.fn().mockResolvedValue(null),
    updateLastUsedAt: vi.fn().mockResolvedValue(undefined),
    findByIdForUser: vi.fn().mockResolvedValue(null),
    findByPublicIdForUser: vi.fn().mockResolvedValue(null),
    listMfaByUserId: vi.fn().mockResolvedValue([]),
  } as unknown as AuthMethodRepository;

  const verificationTokenRepository = {
    invalidateAllForUser: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({ id: 3 }),
    consumeIfValid: vi.fn(),
    consumeOtpForUser: vi.fn(),
    findValidByTokenHash: vi.fn(),
    markUsed: vi.fn(),
  } as unknown as VerificationTokenRepository;

  const authSessionService = {
    revokeAllSessions: vi.fn().mockResolvedValue(undefined),
    revokeAllSessionsExceptCurrent: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthSessionService;

  // OTP verify uses a per-user attempt cap: `eval` (incrementWithExpiryOnFirst) returns the attempt
  // count (1 = under the cap by default), `del` clears it on success. `set` is the SET NX EX resend
  // cooldown claim: 'OK' (default) = slot claimed → issue proceeds; null = on cooldown → skipped.
  const redis = {
    eval: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(0),
    set: vi.fn().mockResolvedValue('OK'),
  } as unknown as Redis;

  const webauthnCredentialRepository = {
    listActiveByUserId: vi.fn().mockResolvedValue([]),
  };

  const service = new AuthMethodService(
    userService,
    authMethodRepository,
    verificationTokenRepository,
    authSessionService,
    redis,
    webauthnCredentialRepository as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(user as never);
    mockedRedisSet(redis.set).mockResolvedValue('OK');
  });

  it('throws NotFoundError when user record is missing', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
    await expect(service.list('missing')).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.create('missing', {
        method_type: 'EMAIL_CODE',
        is_primary: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('revokeAllForUser throws when user is not found', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
    await expect(service.revokeAllForUser('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('hasLoginCapableMethod (sec-r5-M3)', () => {
    it('returns true when the user holds a login-capable method (PASSWORD/OAUTH/EMAIL_CODE)', async () => {
      vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([
        { id: 4, user_id: 1, method_type: 'MFA_TOTP' },
        { id: 5, user_id: 1, method_type: 'PASSWORD' },
      ] as never);
      await expect(service.hasLoginCapableMethod('user_public')).resolves.toBe(true);
    });

    it('returns false when the user holds only non-login-capable methods (MFA only)', async () => {
      vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([
        { id: 4, user_id: 1, method_type: 'MFA_TOTP' },
      ] as never);
      await expect(service.hasLoginCapableMethod('user_public')).resolves.toBe(false);
    });

    it('returns false when the user has no auth methods at all', async () => {
      vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([] as never);
      await expect(service.hasLoginCapableMethod('user_public')).resolves.toBe(false);
    });

    it('throws NotFoundError when the user record is missing', async () => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
      await expect(service.hasLoginCapableMethod('missing')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('hasActiveLoginCredential (counts passkeys — bare-account guard)', () => {
    it('returns true on a login-capable method and does not even query passkeys (short-circuit)', async () => {
      vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([
        { id: 5, user_id: 1, method_type: 'PASSWORD' },
      ] as never);
      await expect(service.hasActiveLoginCredential('user_public')).resolves.toBe(true);
      expect(webauthnCredentialRepository.listActiveByUserId).not.toHaveBeenCalled();
    });

    it('returns true for a passkey-only account with no login-capable method', async () => {
      // The key regression: hasLoginCapableMethod would return false here, but a passkey IS a
      // credential — so the account is NOT a claimable bare placeholder.
      vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([
        { id: 4, user_id: 1, method_type: 'MFA_TOTP' },
      ] as never);
      vi.mocked(webauthnCredentialRepository.listActiveByUserId).mockResolvedValue([
        { id: 9, user_id: 1 },
      ] as never);
      await expect(service.hasActiveLoginCredential('user_public')).resolves.toBe(true);
      expect(webauthnCredentialRepository.listActiveByUserId).toHaveBeenCalledWith(user.id);
    });

    it('returns false when there is no login-capable method and no passkey (truly bare)', async () => {
      vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([] as never);
      vi.mocked(webauthnCredentialRepository.listActiveByUserId).mockResolvedValue([] as never);
      await expect(service.hasActiveLoginCredential('user_public')).resolves.toBe(false);
    });

    it('throws NotFoundError when the user record is missing', async () => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
      await expect(service.hasActiveLoginCredential('missing')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('lists and mutates auth methods for user', async () => {
    // sec-A5 guard: `delete()` reads the target method then verifies that another
    // login-capable method survives. Provide both so the happy-path mutation
    // continues to exercise the create/delete/revokeAllForUser fan-out.
    // sec-new-B4: delete() now accepts a publicId string and uses findByPublicIdForUser.
    vi.mocked(authMethodRepository.findByPublicIdForUser).mockResolvedValue({
      id: 2,
      public_id: 'testpublicmid000000a',
      user_id: 1,
      method_type: 'OAUTH',
    } as never);
    vi.mocked(authMethodRepository.listByUserId).mockResolvedValue([
      { id: 2, public_id: 'testpublicmid000000a', user_id: 1, method_type: 'OAUTH' },
      { id: 3, public_id: 'testpublicmid000000b', user_id: 1, method_type: 'PASSWORD' },
    ] as never);
    await service.list('user_public');
    await service.create('user_public', {
      method_type: 'EMAIL_CODE',
      is_primary: true,
    });
    await service.delete('user_public', 'testpublicmid000000a');
    await service.revokeAllForUser('user_public');
    expect(authMethodRepository.create).toHaveBeenCalled();
  });

  it('does not persist user-supplied provider identity fields on manual create', async () => {
    await service.create('user_public', { method_type: 'EMAIL_CODE' });
    const createArgs = vi.mocked(authMethodRepository.create).mock.calls.at(-1)?.[0];
    expect(createArgs).not.toHaveProperty('provider');
    expect(createArgs).not.toHaveProperty('provider_user_id');
  });

  it('rejects create once the per-user auth-method cap is reached (under the advisory lock)', async () => {
    vi.mocked(authMethodRepository.countActiveByUserId).mockResolvedValueOnce(
      MAX_LINKED_AUTH_METHODS_PER_USER,
    );
    await expect(
      service.create('user_public', { method_type: 'EMAIL_CODE' }),
    ).rejects.toBeInstanceOf(ConflictError);
    // The lock is taken before the count, and no row is inserted when the cap is hit.
    expect(authMethodRepository.acquireCredentialMutationLock).toHaveBeenCalledWith(user.id);
    expect(authMethodRepository.create).not.toHaveBeenCalled();
  });

  it('rejects manual OAUTH linking (account-takeover guard)', async () => {
    await expect(service.create('user_public', { method_type: 'OAUTH' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(authMethodRepository.create).not.toHaveBeenCalled();
  });

  it('rejects manual provider identity binding via strict DTO', async () => {
    await expect(
      service.create('user_public', {
        method_type: 'OAUTH',
        provider: 'google',
        provider_user_id: 'victim-sub',
      } as never),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('forgotPassword creates reset token when user exists', async () => {
    const result = await service.forgotPassword({ email: user.email });
    expect(result.messageKey).toBe('success:passwordResetEmailSent');
    expect(verificationTokenRepository.create).toHaveBeenCalled();
  });

  it('forgotPassword returns success when user unknown', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    const result = await service.forgotPassword({ email: 'missing@example.com' });
    expect(result.messageKey).toBe('success:passwordResetEmailSent');
    expect(verificationTokenRepository.create).not.toHaveBeenCalled();
  });

  it('forgotPassword skips issuing a reset when the per-email cooldown is already held', async () => {
    mockedRedisSet(redis.set).mockResolvedValueOnce(null);
    const result = await service.forgotPassword({ email: user.email });
    expect(result.messageKey).toBe('success:passwordResetEmailSent');
    // On cooldown the user is never looked up and no token is issued (no email), but the uniform
    // success is preserved so the cooldown is not an account-existence oracle.
    expect(userService.findByEmail).not.toHaveBeenCalled();
    expect(verificationTokenRepository.create).not.toHaveBeenCalled();
  });

  it('forgotPassword enforces a constant-time floor on both account-existence branches', async () => {
    const { enforceMinimumDuration } = await import(
      '@/shared/utils/security/anti-enumeration.util.js'
    );
    await service.forgotPassword({ email: user.email });
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    await service.forgotPassword({ email: 'missing@example.com' });
    // The known- and unknown-account paths both run the floor so latency cannot be an oracle.
    expect(vi.mocked(enforceMinimumDuration)).toHaveBeenCalledTimes(2);
  });

  it('resetPassword updates password for valid token', async () => {
    vi.mocked(verificationTokenRepository.consumeIfValid).mockResolvedValue({
      token_type: 'PASSWORD_RESET',
      user_id: user.id,
    } as never);
    await service.resetPassword({ token: 'reset-token', password: 'NewPassword123!' });
    expect(userService.updatePassword).toHaveBeenCalled();
    // The reset token proves email control → mark verified; and the password changed → clear the
    // failed-login lockout so the owner is not held out of the next sign-in.
    expect(userService.updateEmailVerified).toHaveBeenCalledWith(user.public_id);
    expect(userService.updateLoginAttempt).toHaveBeenCalledWith(user.public_id, 0, null);
    expect(authSessionService.revokeAllSessions).toHaveBeenCalledWith(user.public_id);
  });

  it('resetPassword rejects invalid token', async () => {
    vi.mocked(verificationTokenRepository.consumeIfValid).mockResolvedValue(null);
    await expect(
      service.resetPassword({ token: 'bad', password: 'NewPassword123!' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('changePassword verifies current password and revokes other sessions', async () => {
    await service.changePassword(
      'user_public',
      {
        current_password: 'old',
        new_password: 'NewPassword123!',
      },
      { currentAccessToken: 'current-bearer-token' },
    );
    expect(userService.updatePassword).toHaveBeenCalled();
    expect(authSessionService.revokeAllSessionsExceptCurrent).toHaveBeenCalledWith({
      userPublicId: user.public_id,
      currentAccessToken: 'current-bearer-token',
    });
    expect(authSessionService.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('changePassword revokes all sessions when no current token is supplied', async () => {
    await service.changePassword('user_public', {
      current_password: 'old',
      new_password: 'NewPassword123!',
    });
    expect(authSessionService.revokeAllSessionsExceptCurrent).not.toHaveBeenCalled();
    expect(authSessionService.revokeAllSessions).toHaveBeenCalledWith(user.public_id);
  });

  it('AUTH-17: changePassword propagates a session-revocation failure so the tx rolls back', async () => {
    // The new hash and the session revocation run in ONE transaction. If revocation
    // fails, the error must propagate (rolling the password change back) instead of
    // leaving a changed password with a still-live, possibly-compromised session.
    vi.mocked(authSessionService.revokeAllSessionsExceptCurrent).mockRejectedValueOnce(
      new Error('redis down'),
    );
    await expect(
      service.changePassword(
        'user_public',
        { current_password: 'old', new_password: 'NewPassword123!' },
        { currentAccessToken: 'current-bearer-token' },
      ),
    ).rejects.toThrow('redis down');
    // updatePassword ran inside the same transaction callback, so a real DB rolls it back.
    expect(userService.updatePassword).toHaveBeenCalled();
  });

  it('changePassword rejects when password auth disabled', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue({
      ...user,
      password_hash: null,
    } as never);
    await expect(
      service.changePassword('user_public', {
        current_password: 'old',
        new_password: 'NewPassword123!',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('forgotPassword rejects disposable email', async () => {
    const emailUtil = await import('@/shared/utils/text/email.util.js');
    vi.mocked(emailUtil.isDisposableEmailBlocked).mockReturnValueOnce(true);
    await expect(service.forgotPassword({ email: 'bad@temp.com' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('delete throws when auth method is not found', async () => {
    // sec-new-B4: delete() accepts a publicId string; findByPublicIdForUser returning null triggers NotFoundError.
    vi.mocked(authMethodRepository.findByPublicIdForUser).mockResolvedValue(null);
    await expect(service.delete('user_public', 'testpublicmid000000x')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('resetPassword rejects wrong token type and missing user', async () => {
    // sec-r5-L2: a wrong-flow token never matches the PASSWORD_RESET-scoped consume, so the
    // repository returns null and the service surfaces UnauthorizedError.
    vi.mocked(verificationTokenRepository.consumeIfValid).mockResolvedValue(null);
    await expect(
      service.resetPassword({ token: 'reset-token', password: 'NewPassword123!' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(verificationTokenRepository.consumeIfValid).toHaveBeenCalledWith(
      expect.any(String),
      'PASSWORD_RESET',
    );

    vi.mocked(verificationTokenRepository.consumeIfValid).mockResolvedValue({
      token_type: 'PASSWORD_RESET',
      user_id: user.id,
    } as never);
    vi.mocked(userService.findById).mockResolvedValue(null);
    await expect(
      service.resetPassword({ token: 'reset-token', password: 'NewPassword123!' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('changePassword rejects incorrect current password', async () => {
    const passwordUtil = await import('@/shared/utils/security/password.util.js');
    vi.mocked(passwordUtil.verifyPassword).mockResolvedValueOnce({
      valid: false,
      needsRehash: false,
    });
    await expect(
      service.changePassword('user_public', {
        current_password: 'wrong',
        new_password: 'NewPassword123!',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('delete throws NotFoundError when user record is missing', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
    await expect(service.delete('missing', 'testpublicmid000000y')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('changePassword throws NotFoundError when user record is missing', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
    await expect(
      service.changePassword('missing', {
        current_password: 'old',
        new_password: 'NewPassword123!',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('resetPassword rejects when token record is missing', async () => {
    vi.mocked(verificationTokenRepository.consumeIfValid).mockResolvedValue(null);
    await expect(
      service.resetPassword({ token: 'missing', password: 'NewPassword123!' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('delegates repository helpers and links OAuth when missing', async () => {
    const oauthData = {
      user_id: user.id,
      method_type: 'OAUTH',
      provider: 'google',
      provider_user_id: 'gid',
      is_primary: true,
    } as const;

    vi.mocked(authMethodRepository.findByProviderUserId).mockResolvedValue(null);
    await service.findByProviderUserId('google', 'gid');
    await service.linkOAuthProviderIfMissing({ ownerPublicId: user.public_id, data: oauthData });
    expect(authMethodRepository.create).toHaveBeenCalledWith(oauthData);

    vi.mocked(authMethodRepository.findByProviderUserId).mockResolvedValue({ id: 9 } as never);
    await service.linkOAuthProviderIfMissing({ ownerPublicId: user.public_id, data: oauthData });
    expect(authMethodRepository.create).toHaveBeenCalledTimes(1);

    await service.linkOAuthProviderIfMissing({
      ownerPublicId: user.public_id,
      data: {
        user_id: user.id,
        method_type: 'PASSWORD',
      },
    });
    await service.findTotpByUserId(user.id);
    await service.createAuthMethodRecord(oauthData);
    await service.updateAuthMethodLastUsedAt(2, user.id);
    await service.findAuthMethodByIdForUser(2, user.id);
    await service.listMfaMethodsByUserId(user.id);
    vi.mocked(authMethodRepository.revoke).mockResolvedValue({ id: 2 } as never);
    await service.revokeAuthMethod(2, user.id);
    expect(authMethodRepository.findTotpByUserId).toHaveBeenCalled();
    expect(authMethodRepository.updateLastUsedAt).toHaveBeenCalled();
    expect(authMethodRepository.findByIdForUser).toHaveBeenCalled();
    expect(authMethodRepository.listMfaByUserId).toHaveBeenCalled();
    expect(authMethodRepository.revoke).toHaveBeenCalled();
  });
});
