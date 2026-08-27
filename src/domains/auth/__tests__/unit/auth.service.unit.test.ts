import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { NotFoundError, UnauthorizedError, ValidationError } from '@/shared/errors/index.js';
import { AuthService } from '@/domains/auth/auth.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import type { MfaService } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa.service.js';
import type { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { ACCOUNT_LOCKOUT_MINUTES, MAX_FAILED_LOGIN_ATTEMPTS } from '@/shared/constants/index.js';

vi.mock('@/shared/utils/text/email.util.js', () => ({
  isDisposableEmailBlocked: vi.fn(() => false),
}));

vi.mock('@/shared/utils/security/password.util.js', () => ({
  verifyPassword: vi.fn().mockResolvedValue({ valid: true, needsRehash: false }),
  hashPassword: vi.fn().mockResolvedValue('new-hash'),
  DUMMY_ARGON2_HASH: '$argon2id$dummy',
}));

vi.mock('@/shared/utils/security/jwt.util.js', () => ({
  signAccessToken: vi.fn().mockResolvedValue('jwt-access-token'),
}));

vi.mock('@/shared/utils/auth/global-admin-role.util.js', () => ({
  resolveAccessTokenRoleForUser: vi.fn().mockResolvedValue('USER'),
}));

vi.mock('@/shared/utils/auth/recent-step-up.util.js', () => ({
  recordRecentStepUp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/infrastructure/observability/sentry/sentry.js', () => ({
  captureMessage: vi.fn(),
}));

// audit-#15d: spy the timing floor so we can assert both login failure branches apply it.
vi.mock('@/shared/utils/security/anti-enumeration.util.js', () => ({
  enforceMinimumDuration: vi.fn().mockResolvedValue(undefined),
  ANTI_ENUMERATION_MINIMUM_DURATION_MS: 300,
}));

// login/refresh/switch mint the `org` claim via these tenancy resolvers (their own DB context).
// Stub them so the AuthService unit tests stay pure (the CI unit lane has no Postgres).
vi.mock('@/domains/tenancy/sub-domains/organization/resolve-active-organization.js', () => ({
  resolveDefaultActiveOrganizationPublicId: vi.fn().mockResolvedValue(undefined),
  findUserActiveOrganizationPublicId: vi.fn().mockResolvedValue(undefined),
  findUserActiveOrganizationPublicIdByInternalId: vi.fn().mockResolvedValue(undefined),
  findUserActiveOrganizationByPublicId: vi.fn().mockResolvedValue(undefined),
  resolvePersonalOrganizationPublicId: vi.fn().mockResolvedValue(undefined),
  resolvePersonalOrganization: vi.fn().mockResolvedValue(undefined),
  ensurePersonalOrganization: vi.fn().mockResolvedValue(undefined),
  ensurePersonalOrganizationPublicId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/infrastructure/database/contexts/user-database.context.js', () => ({
  withUserDatabaseContext: vi.fn((_userPublicId: string, callback: () => Promise<unknown>) =>
    callback(),
  ),
}));

vi.mock(
  '@/infrastructure/database/contexts/principal-database.context.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      withPrincipalDatabaseContext: vi.fn(
        async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
      ),
    };
  },
);

vi.mock(
  '@/infrastructure/database/contexts/session-database.context.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      withSessionDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
        callback(),
      ),
    };
  },
);

const user = {
  id: 1,
  public_id: generatePublicId('authSession'),
  email: 'user@example.com',
  password_hash: 'hash',
  failed_login_count: 0,
  account_locked_until: null,
  status: 'ACTIVE',
  is_mfa_enabled: false,
};

describe('AuthService', () => {
  const userService = {
    findByEmail: vi.fn().mockResolvedValue(user),
    findById: vi.fn().mockResolvedValue(user),
    requireUserRecordByPublicId: vi.fn().mockResolvedValue(user),
    updateLoginAttempt: vi.fn().mockResolvedValue(undefined),
    registerFailedLoginAttempt: vi.fn().mockResolvedValue(undefined),
    updatePassword: vi.fn().mockResolvedValue(user),
  } as unknown as UserService;

  const authSessionService = {
    createSessionForUser: vi.fn().mockResolvedValue({
      public_id: 'session_public',
      refresh_secret: 'refresh-secret',
    }),
    revokeSessionByAccessToken: vi.fn().mockResolvedValue(undefined),
    findActiveSessionByPublicId: vi.fn().mockResolvedValue({
      public_id: 'session_public',
      user_id: 1,
      expires_at: new Date(Date.now() + 86_400_000),
      revoked_at: null,
    }),
    findSessionByPublicIdIncludingRevoked: vi.fn().mockResolvedValue({
      public_id: 'session_public',
      user_id: 1,
      expires_at: new Date(Date.now() + 86_400_000),
      is_revoked: false,
    }),
    rotateSessionTokenHash: vi.fn().mockResolvedValue(undefined),
    refreshSessionCredentials: vi.fn().mockResolvedValue({ refresh_secret: 'new-refresh-secret' }),
    rebindAccessToken: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthSessionService;

  const mfaService = {
    createMfaSession: vi.fn().mockResolvedValue('mfa_session_token'),
  } as unknown as MfaService;

  const organizationSettingsService = {
    userHasOrganizationRequiringMfa: vi.fn().mockResolvedValue(false),
  } as unknown as OrganizationSettingsService;

  const redis = {
    get: vi.fn().mockResolvedValue(null),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    // route-audit C5: per-IP failed-login counter now uses an atomic INCR+EXPIRE Lua via redis.eval.
    eval: vi.fn().mockResolvedValue(1),
  } as unknown as Redis;

  const authMethodService = {
    // resetPassword consumes the token + updates the password + revokes sessions, then returns the
    // reset user so AuthService can mint a fresh session (auto-login).
    resetPassword: vi.fn().mockResolvedValue(user),
  } as unknown as AuthMethodService;

  const service = new AuthService(
    userService,
    authSessionService,
    mfaService,
    organizationSettingsService,
    redis,
    authMethodService,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(organizationSettingsService.userHasOrganizationRequiringMfa).mockResolvedValue(false);
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.incr).mockResolvedValue(1);
    vi.mocked(redis.expire).mockResolvedValue(1);
  });

  it('login returns mfa_required when user has MFA enabled', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue({
      ...user,
      is_mfa_enabled: true,
    } as never);
    const result = await service.login(
      { email: user.email, password: 'ValidPassword12!' },
      '127.0.0.1',
    );
    expect(result).toEqual({
      mfa_required: true,
      mfa_session_token: 'mfa_session_token',
    });
    expect(mfaService.createMfaSession).toHaveBeenCalledWith(user.public_id);
    expect(authSessionService.createSessionForUser).not.toHaveBeenCalled();
  });

  it('login returns mfa_required when an organization requires MFA', async () => {
    vi.mocked(organizationSettingsService.userHasOrganizationRequiringMfa).mockResolvedValue(true);
    const result = await service.login(
      { email: user.email, password: 'ValidPassword12!' },
      '127.0.0.1',
    );
    expect(result).toEqual({
      mfa_required: true,
      mfa_session_token: 'mfa_session_token',
    });
  });

  it('login returns access token and session id', async () => {
    const result = await service.login(
      { email: user.email, password: 'ValidPassword12!' },
      '127.0.0.1',
      'agent',
    );
    expect('access_token' in result && result.access_token).toBe('jwt-access-token');
    expect(authSessionService.createSessionForUser).toHaveBeenCalled();
  });

  describe('resetPassword (auto-login)', () => {
    const resetBody = {
      token: 'reset-token',
      password: 'BrandNewPassword456!',
    };

    it('logs the user straight in (access token + session) after a successful reset', async () => {
      vi.mocked(authMethodService.resetPassword).mockResolvedValue(user as never);
      const result = await service.resetPassword(resetBody, '127.0.0.1', 'agent');
      expect(authMethodService.resetPassword).toHaveBeenCalledWith(resetBody);
      expect('access_token' in result && result.access_token).toBe('jwt-access-token');
      expect(authSessionService.createSessionForUser).toHaveBeenCalled();
    });

    it('returns mfa_required (no session) when the reset user has MFA — the reset never bypasses MFA', async () => {
      vi.mocked(authMethodService.resetPassword).mockResolvedValue({
        ...user,
        is_mfa_enabled: true,
      } as never);
      const result = await service.resetPassword(resetBody, '127.0.0.1');
      expect(result).toEqual({
        mfa_required: true,
        mfa_session_token: 'mfa_session_token',
      });
      expect(authSessionService.createSessionForUser).not.toHaveBeenCalled();
    });

    it('refuses a session for a suspended account even though the password was reset', async () => {
      vi.mocked(authMethodService.resetPassword).mockResolvedValue({
        ...user,
        status: 'SUSPENDED',
      } as never);
      await expect(service.resetPassword(resetBody, '127.0.0.1')).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
      expect(authSessionService.createSessionForUser).not.toHaveBeenCalled();
    });
  });

  it('login rejects unknown user', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    await expect(
      service.login({ email: 'x@y.com', password: 'WrongPassword1!' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('runs a dummy password verification for unknown emails to equalize login timing (#23)', async () => {
    const { verifyPassword, DUMMY_ARGON2_HASH } = await import(
      '@/shared/utils/security/password.util.js'
    );
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    await expect(
      service.login({ email: 'unknown@example.com', password: 'WrongPassword1!' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(verifyPassword).toHaveBeenCalledWith('WrongPassword1!', DUMMY_ARGON2_HASH);
  });

  it('applies the timing floor on both login failure branches (audit-#15d)', async () => {
    const { enforceMinimumDuration } = await import(
      '@/shared/utils/security/anti-enumeration.util.js'
    );
    const { verifyPassword } = await import('@/shared/utils/security/password.util.js');

    // Unknown-email branch.
    vi.mocked(enforceMinimumDuration).mockClear();
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    await expect(
      service.login({ email: 'unknown@example.com', password: 'WrongPassword1!' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(enforceMinimumDuration).toHaveBeenCalledTimes(1);

    // Wrong-password branch (known email) — the branch with the extra Postgres write.
    vi.mocked(enforceMinimumDuration).mockClear();
    vi.mocked(userService.findByEmail).mockResolvedValue(user as never);
    vi.mocked(verifyPassword).mockResolvedValueOnce({
      valid: false,
      needsRehash: false,
    });
    await expect(
      service.login({ email: user.email, password: 'WrongPassword1!' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(enforceMinimumDuration).toHaveBeenCalledTimes(1);
  });

  it('login rejects a locked account only when the password is also wrong', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue({
      ...user,
      account_locked_until: new Date(Date.now() + 60_000),
    } as never);
    const { verifyPassword } = await import('@/shared/utils/security/password.util.js');
    vi.mocked(verifyPassword).mockResolvedValueOnce({
      valid: false,
      needsRehash: false,
    });
    await expect(
      service.login({ email: user.email, password: 'WrongPassword1!' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('login uses the SAME error message for unknown email, wrong password, and currently-locked-out wrong password (sec-A #23)', async () => {
    // Prior code returned `errors:accountLocked` when (email is real) AND (password is
    // wrong) AND (lockout is active) — a narrow enumeration oracle a credential-stuffing
    // operator could use to confirm "this account has recently received >=
    // MAX_FAILED_LOGIN_ATTEMPTS failed logins". The fix collapses the message to the
    // generic invalidEmailOrPassword for all three branches.
    const { verifyPassword } = await import('@/shared/utils/security/password.util.js');

    // Unknown email → invalidEmailOrPassword
    vi.mocked(userService.findByEmail).mockResolvedValueOnce(null as never);
    await expect(
      service.login({ email: 'unknown@example.com', password: 'WrongPassword1!' }, '127.0.0.1'),
    ).rejects.toMatchObject({ messageKey: 'errors:invalidEmailOrPassword' });

    // Real email, wrong password, NO lockout → invalidEmailOrPassword
    vi.mocked(userService.findByEmail).mockResolvedValueOnce({
      ...user,
      account_locked_until: null,
    } as never);
    vi.mocked(verifyPassword).mockResolvedValueOnce({
      valid: false,
      needsRehash: false,
    });
    await expect(
      service.login({ email: user.email, password: 'WrongPassword1!' }, '127.0.0.1'),
    ).rejects.toMatchObject({ messageKey: 'errors:invalidEmailOrPassword' });

    // Real email, wrong password, ACTIVE lockout → invalidEmailOrPassword (no oracle)
    vi.mocked(userService.findByEmail).mockResolvedValueOnce({
      ...user,
      account_locked_until: new Date(Date.now() + 60_000),
    } as never);
    vi.mocked(verifyPassword).mockResolvedValueOnce({
      valid: false,
      needsRehash: false,
    });
    await expect(
      service.login({ email: user.email, password: 'WrongPassword1!' }, '127.0.0.1'),
    ).rejects.toMatchObject({ messageKey: 'errors:invalidEmailOrPassword' });
  });

  it('login lets a correct password bypass an active lockout (no victim-account DoS)', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue({
      ...user,
      failed_login_count: 10,
      account_locked_until: new Date(Date.now() + 60_000),
    } as never);
    const result = await service.login(
      { email: user.email, password: 'ValidPassword12!' },
      '127.0.0.1',
    );
    expect('access_token' in result && result.access_token).toBe('jwt-access-token');
    // The successful login lifts the lock and clears the failure counter for the owner.
    expect(userService.updateLoginAttempt).toHaveBeenCalledWith(user.public_id, 0, null);
  });

  it('allows login when account lock has expired', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue({
      ...user,
      account_locked_until: new Date(Date.now() - 60_000),
    } as never);
    const result = await service.login(
      { email: user.email, password: 'ValidPassword12!' },
      '127.0.0.1',
    );
    expect('access_token' in result && result.access_token).toBe('jwt-access-token');
  });

  it('logout revokes session by token hash', async () => {
    await service.logout('bearer-token');
    expect(authSessionService.revokeSessionByAccessToken).toHaveBeenCalled();
  });

  it('refreshToken issues new jwt for valid session', async () => {
    const result = await service.refreshToken({
      sessionPublicId: 'session_public',
      refreshSecret: 'refresh-secret',
    });
    expect(result.access_token).toBe('jwt-access-token');
    expect(result.refresh_secret).toBe('new-refresh-secret');
    expect(authSessionService.refreshSessionCredentials).toHaveBeenCalled();
  });

  it('AUTH-14: refreshToken preserves the session-selected org (re-validated) instead of resetting to default', async () => {
    const resolve = await import(
      '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js'
    );
    const jwt = await import('@/shared/utils/security/jwt.util.js');
    vi.mocked(authSessionService.findSessionByPublicIdIncludingRevoked).mockResolvedValue({
      public_id: 'session_public',
      user_id: 1,
      organization_id: 42,
      expires_at: new Date(Date.now() + 86_400_000),
      is_revoked: false,
    } as never);
    vi.mocked(resolve.findUserActiveOrganizationPublicIdByInternalId).mockResolvedValue(
      'org_selected',
    );

    await service.refreshToken({
      sessionPublicId: 'session_public',
      refreshSecret: 'refresh-secret',
    });

    // The selected org is re-validated by internal id and reused for the token claim.
    expect(resolve.findUserActiveOrganizationPublicIdByInternalId).toHaveBeenCalledWith(1, 42);
    expect(resolve.resolveDefaultActiveOrganizationPublicId).not.toHaveBeenCalled();
    expect(jwt.signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: 'org_selected' }),
    );
  });

  it('AUTH-14: refreshToken falls back to the default org when the persisted org is no longer a valid membership', async () => {
    const resolve = await import(
      '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js'
    );
    vi.mocked(authSessionService.findSessionByPublicIdIncludingRevoked).mockResolvedValue({
      public_id: 'session_public',
      user_id: 1,
      organization_id: 42,
      expires_at: new Date(Date.now() + 86_400_000),
      is_revoked: false,
    } as never);
    // Membership revoked / org deleted → re-validation returns undefined.
    vi.mocked(resolve.findUserActiveOrganizationPublicIdByInternalId).mockResolvedValue(undefined);
    vi.mocked(resolve.resolveDefaultActiveOrganizationPublicId).mockResolvedValue('org_default');

    await service.refreshToken({
      sessionPublicId: 'session_public',
      refreshSecret: 'refresh-secret',
    });

    expect(resolve.resolveDefaultActiveOrganizationPublicId).toHaveBeenCalledWith(1);
  });

  it('AUTH-15: switchToOrganization persists the selected org on the session for refresh to preserve', async () => {
    const resolve = await import(
      '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js'
    );
    vi.mocked(resolve.findUserActiveOrganizationByPublicId).mockResolvedValue({
      id: 9,
      public_id: 'org_team',
    });

    const result = await service.switchToOrganization({
      userPublicId: user.public_id,
      sessionPublicId: 'session_public',
      organizationPublicId: 'org_team',
    });

    expect(result.access_token).toBe('jwt-access-token');
    expect(authSessionService.rebindAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionPublicId: 'session_public',
        activeOrganizationId: 9,
      }),
    );
  });

  /**
   * `switchToOrganization`'s two user-scoped reads — the user record and the membership gate —
   * both run under `app.current_user_id` set to the SAME value, so they must share ONE context
   * and therefore one pooled checkout. Splitting them back into a context each is invisible in
   * the response and only shows up as connection pressure under load, so it is pinned here.
   *
   * The session rebind is asserted to run AFTER that context closes. It writes under
   * `app.current_session_public_id` — a different guc — so it needs its own transaction; nesting
   * it would hold the user checkout open across it and make the request peak at two concurrent
   * connections instead of taking them one after another.
   */
  it('runs both user-scoped reads in ONE database context and rebinds the session outside it', async () => {
    const resolve = await import(
      '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js'
    );
    const databaseContext = await import(
      '@/infrastructure/database/contexts/principal-database.context.js'
    );
    vi.mocked(resolve.findUserActiveOrganizationByPublicId).mockResolvedValue({
      id: 9,
      public_id: 'org_team',
    });

    const order: string[] = [];
    vi.mocked(databaseContext.withPrincipalDatabaseContext).mockImplementation(
      // The real signature hands the callback a pinned database handle; the mock never touches
      // it, so it is passed through as `never` rather than fabricating a fake handle.
      (async (_scope: unknown, callback: (handle: never) => Promise<unknown>) => {
        order.push('context:open');
        const result = await callback(undefined as never);
        order.push('context:close');
        return result;
      }) as unknown as typeof databaseContext.withPrincipalDatabaseContext,
    );
    vi.mocked(authSessionService.rebindAccessToken).mockImplementation(async () => {
      order.push('session:rebind');
      return undefined;
    });

    await service.switchToOrganization({
      userPublicId: user.public_id,
      sessionPublicId: 'session_public',
      organizationPublicId: 'org_team',
    });

    // One context for the whole route. Two would mean the same guc set twice, in two checkouts.
    expect(databaseContext.withPrincipalDatabaseContext).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['context:open', 'context:close', 'session:rebind']);
  });

  it('switchToPersonal self-heals the personal org via ensurePersonalOrganization (no 404 when personal is enabled)', async () => {
    const resolve = await import(
      '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js'
    );
    // ensurePersonalOrganization provisions on demand → returns the (possibly just-created) org.
    vi.mocked(resolve.ensurePersonalOrganization).mockResolvedValue({
      id: 7,
      public_id: 'org_personal',
    });

    const result = await service.switchToPersonal({
      userPublicId: user.public_id,
      sessionPublicId: 'session_public',
    });

    expect(resolve.ensurePersonalOrganization).toHaveBeenCalledWith(user.id);
    expect(result.access_token).toBe('jwt-access-token');
    expect(authSessionService.rebindAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionPublicId: 'session_public',
        activeOrganizationId: 7,
      }),
    );
  });

  it('switchToPersonal 404s when personal organizations are disabled (ensure returns undefined)', async () => {
    const resolve = await import(
      '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js'
    );
    vi.mocked(resolve.ensurePersonalOrganization).mockResolvedValue(undefined);

    await expect(
      service.switchToPersonal({
        userPublicId: user.public_id,
        sessionPublicId: 'session_public',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('records a failed attempt via the atomic increment (count + lock decided in SQL)', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue({
      ...user,
      failed_login_count: 3,
    } as never);
    const { verifyPassword } = await import('@/shared/utils/security/password.util.js');
    vi.mocked(verifyPassword).mockResolvedValueOnce({
      valid: false,
      needsRehash: false,
    });

    await expect(
      service.login({ email: user.email, password: 'WrongPassword1!' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    // The +1 and the lockout threshold are now evaluated atomically in the database, so the
    // service delegates the policy rather than computing the next count itself.
    expect(userService.registerFailedLoginAttempt).toHaveBeenCalledWith(user.public_id, {
      maxAttempts: MAX_FAILED_LOGIN_ATTEMPTS,
      lockoutMinutes: ACCOUNT_LOCKOUT_MINUTES,
    });
    expect(userService.updateLoginAttempt).not.toHaveBeenCalled();
  });

  it('login records a failed attempt on bad password via the atomic increment', async () => {
    const { verifyPassword } = await import('@/shared/utils/security/password.util.js');
    vi.mocked(verifyPassword).mockResolvedValueOnce({
      valid: false,
      needsRehash: false,
    });
    await expect(
      service.login({ email: user.email, password: 'WrongPassword1!' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(userService.registerFailedLoginAttempt).toHaveBeenCalled();
  });

  it('refreshToken rejects missing session', async () => {
    vi.mocked(authSessionService.findSessionByPublicIdIncludingRevoked).mockResolvedValue(null);
    await expect(
      service.refreshToken({
        sessionPublicId: 'missing',
        refreshSecret: 'refresh-secret',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refreshToken rejects expired sessions and inactive users', async () => {
    vi.mocked(authSessionService.findSessionByPublicIdIncludingRevoked).mockResolvedValue({
      public_id: 'session_public',
      user_id: 1,
      expires_at: new Date(Date.now() - 1000),
      is_revoked: false,
    } as never);
    await expect(
      service.refreshToken({
        sessionPublicId: 'session_public',
        refreshSecret: 'refresh-secret',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    vi.mocked(authSessionService.findSessionByPublicIdIncludingRevoked).mockResolvedValue({
      public_id: 'session_public',
      user_id: 1,
      expires_at: new Date(Date.now() + 86_400_000),
      is_revoked: false,
    } as never);
    vi.mocked(userService.findById).mockResolvedValue({
      ...user,
      status: 'SUSPENDED',
    } as never);
    await expect(
      service.refreshToken({
        sessionPublicId: 'session_public',
        refreshSecret: 'refresh-secret',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('sec-re-05: refreshToken reaches refreshSessionCredentials even when the session row is revoked, so the reuse-detection block can fire', async () => {
    // Without this fix, `refreshToken` looked the session up via
    // `findActiveSessionByPublicId` (which filters `is_revoked = false`) and
    // threw `errors:invalidOrExpiredSession` for revoked rows BEFORE
    // `refreshSessionCredentials` could run the
    // `findByPublicIdIncludingRevoked` reuse-detection block — the exact
    // "user clicked Log out everywhere, attacker holds stale refresh secret"
    // scenario sec-A #9 was meant to catch silently no-op'd. The Sentry
    // signal (`auth.refresh_token.reuse_detected`) never fired.
    vi.mocked(authSessionService.findSessionByPublicIdIncludingRevoked).mockResolvedValue({
      public_id: 'session_public',
      user_id: 1,
      expires_at: new Date(Date.now() + 86_400_000),
      is_revoked: true,
    } as never);
    vi.mocked(userService.findById).mockResolvedValue({
      ...user,
      status: 'ACTIVE',
    } as never);
    vi.mocked(authSessionService.refreshSessionCredentials).mockRejectedValueOnce(
      new UnauthorizedError('errors:invalidOrExpiredSession'),
    );

    await expect(
      service.refreshToken({
        sessionPublicId: 'session_public',
        refreshSecret: 'replayed-stale-secret',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    // The critical assertion — refreshSessionCredentials WAS reached, even for
    // a revoked session. On dev this call never happens because the service
    // throws on the earlier findActiveSessionByPublicId null-return.
    expect(authSessionService.refreshSessionCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionPublicId: 'session_public',
        refreshSecret: 'replayed-stale-secret',
      }),
    );
  });

  it('login rehashes password when verifyPassword reports needsRehash', async () => {
    const { verifyPassword } = await import('@/shared/utils/security/password.util.js');
    vi.mocked(verifyPassword).mockResolvedValueOnce({
      valid: true,
      needsRehash: true,
    });
    await service.login({ email: user.email, password: 'ValidPassword12!' }, '127.0.0.1', 'agent');
    expect(userService.updatePassword).toHaveBeenCalled();
  });

  it('login delegates the lockout decision to the atomic failed-attempt increment', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue({
      ...user,
      failed_login_count: 9,
    } as never);
    const { verifyPassword } = await import('@/shared/utils/security/password.util.js');
    vi.mocked(verifyPassword).mockResolvedValueOnce({
      valid: false,
      needsRehash: false,
    });

    await expect(
      service.login({ email: user.email, password: 'WrongPassword1!' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    // The threshold check (count + 1 >= max → lock) is applied atomically in SQL; the service
    // simply hands the policy to the increment. The lockout behaviour itself is exercised against
    // a real database in user.repository.db.unit.test.ts.
    expect(userService.registerFailedLoginAttempt).toHaveBeenCalledWith(user.public_id, {
      maxAttempts: MAX_FAILED_LOGIN_ATTEMPTS,
      lockoutMinutes: ACCOUNT_LOCKOUT_MINUTES,
    });
  });

  it('login rejects disposable email addresses', async () => {
    const emailUtil = await import('@/shared/utils/text/email.util.js');
    vi.mocked(emailUtil.isDisposableEmailBlocked).mockReturnValueOnce(true);
    await expect(
      service.login({ email: 'temp@mailinator.com', password: 'ValidPassword12!' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('login blocks an IP that has exceeded the per-IP failure threshold', async () => {
    vi.mocked(redis.get).mockResolvedValueOnce('50');
    await expect(
      service.login({ email: user.email, password: 'ValidPassword12!' }, '192.168.1.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    // Should reject before even checking the user
    expect(userService.findByEmail).not.toHaveBeenCalled();
  });

  it('login increments the per-IP counter on a failed password attempt', async () => {
    const { verifyPassword } = await import('@/shared/utils/security/password.util.js');
    vi.mocked(verifyPassword).mockResolvedValueOnce({
      valid: false,
      needsRehash: false,
    });
    await expect(
      service.login({ email: user.email, password: 'WrongPassword1!' }, '10.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(redis.eval).toHaveBeenCalled();
  });

  it('login increments the per-IP counter when the email is not found', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    await expect(
      service.login({ email: 'nobody@example.com', password: 'WrongPassword1!' }, '10.0.0.2'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(redis.eval).toHaveBeenCalled();
  });

  it('login fails open on Redis error during IP check (does not block legitimate user)', async () => {
    vi.mocked(redis.get).mockRejectedValueOnce(new Error('redis connection refused'));
    const result = await service.login(
      { email: user.email, password: 'ValidPassword12!' },
      '127.0.0.1',
    );
    expect('access_token' in result && result.access_token).toBe('jwt-access-token');
  });

  it('logout rejects unknown or already revoked tokens', async () => {
    vi.mocked(authSessionService.revokeSessionByAccessToken).mockRejectedValue(
      new UnauthorizedError('errors:invalidOrRevokedToken'),
    );
    await expect(service.logout('missing-token')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('login does not reset failed login count when count is already zero', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue({
      ...user,
      failed_login_count: 0,
    } as never);
    await service.login({ email: user.email, password: 'ValidPassword12!' }, '127.0.0.1');
    expect(userService.updateLoginAttempt).not.toHaveBeenCalled();
  });

  it('login rejects a suspended user before issuing any session (bug 31)', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue({
      ...user,
      status: 'SUSPENDED',
    } as never);
    await expect(
      service.login({ email: user.email, password: 'ValidPassword12!' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(authSessionService.createSessionForUser).not.toHaveBeenCalled();
    expect(mfaService.createMfaSession).not.toHaveBeenCalled();
  });

  it('login rejects a suspended user even when MFA would otherwise be required (bug 31)', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue({
      ...user,
      status: 'SUSPENDED',
      is_mfa_enabled: true,
    } as never);
    await expect(
      service.login({ email: user.email, password: 'ValidPassword12!' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mfaService.createMfaSession).not.toHaveBeenCalled();
  });

  it('login rejects users without password authentication enabled', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue({
      ...user,
      password_hash: null,
    } as never);
    await expect(
      service.login({ email: user.email, password: 'ValidPassword12!' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refreshToken rejects when user record is missing', async () => {
    vi.mocked(userService.findById).mockResolvedValue(null);
    await expect(
      service.refreshToken({
        sessionPublicId: 'session_public',
        refreshSecret: 'refresh-secret',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('login resets failed login count after successful authentication', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue({
      ...user,
      failed_login_count: 4,
    } as never);
    await service.login({ email: user.email, password: 'ValidPassword12!' }, '127.0.0.1');
    expect(userService.updateLoginAttempt).toHaveBeenCalledWith(user.public_id, 0, null);
  });
});
