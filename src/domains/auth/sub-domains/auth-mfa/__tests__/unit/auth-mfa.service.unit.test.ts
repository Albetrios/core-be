import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedError } from '@/shared/errors/index.js';
import { TOTP_ISSUER } from '@/shared/constants/project-identity.constants.js';
import { MfaService } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import { signAccessToken } from '@/shared/utils/security/jwt.util.js';

vi.mock('otplib', () => ({
  generateSecret: () => 'TESTSECRET',
  generateURI: () => `otpauth://totp/${TOTP_ISSUER}:user@example.com?secret=TESTSECRET`,
  verify: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock('@/shared/utils/security/jwt.util.js', () => ({
  signAccessToken: vi.fn().mockReturnValue('access-token'),
}));

// H1: the MFA login path now bakes the active-org `org` claim into the token (mirroring the
// first-factor path). Mock the resolver — without this the unit lane (no Postgres) would hit a
// real DB call. The verifyLoginMfa test below asserts the resolved org reaches signAccessToken.
vi.mock('@/domains/tenancy/sub-domains/organization/resolve-active-organization.js', () => ({
  resolveDefaultActiveOrganizationPublicId: vi.fn().mockResolvedValue('org_mfaactive0000000000'),
}));

vi.mock('@/shared/utils/auth/global-admin-role.util.js', () => ({
  resolveAccessTokenRoleForUser: vi.fn().mockResolvedValue('USER'),
}));

vi.mock('@/domains/auth/auth.validator.js', () => ({
  validateMfaVerify: (body: unknown) => body,
  validateMfaEnroll: (body: unknown) => body,
  validateMfaEnrollConfirm: (body: unknown) => body,
  validateMfaLoginVerify: (body: unknown) => body,
}));

vi.mock('@/domains/auth/sub-domains/auth-mfa-session/auth-mfa-session.js', () => ({
  createMfaSession: vi.fn().mockResolvedValue('session-token'),
  verifyMfaSession: vi.fn().mockResolvedValue({ user_public_id: 'user_public' }),
}));

vi.mock('@/domains/auth/sub-domains/auth-mfa/auth-mfa-recovery-code.repository.js', () => ({
  consumeMfaRecoveryCode: vi.fn().mockResolvedValue(false),
  hashMfaRecoveryCode: (plain: string) => `HASHED:${plain}`,
  insertMfaRecoveryCodes: vi.fn().mockResolvedValue(undefined),
  invalidateAllUnusedRecoveryCodesForUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/domains/auth/sub-domains/auth-mfa/auth-mfa-recovery-code.util.js', () => ({
  generateMfaRecoveryCodes: vi.fn((count: number) =>
    Array.from({ length: count }, (_value, index) => `RECOVERY${index + 1}`),
  ),
}));

vi.mock('@/shared/utils/security/field-secret-encryption.util.js', () => ({
  encryptFieldSecret: (value: string) => value,
  decryptFieldSecret: (value: string) => value,
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

const user = {
  id: 1,
  public_id: 'user_public',
  email: 'user@example.com',
  status: 'ACTIVE',
  is_email_verified: true,
};

describe('MfaService', () => {
  const userService = {
    requireUserRecordByPublicId: vi.fn().mockResolvedValue(user),
    updateMfaEnabled: vi.fn().mockResolvedValue(undefined),
  } as unknown as UserService;

  const authMethodService = {
    findTotpByUserId: vi.fn(),
    updateAuthMethodLastUsedAt: vi.fn().mockResolvedValue({}),
    createAuthMethodRecord: vi
      .fn()
      .mockResolvedValue({ id: 99, public_id: 'testpublicmid0000000' }),
    listMfaMethodsByUserId: vi.fn().mockResolvedValue([]),
    revokeAuthMethod: vi.fn(),
    findAuthMethodByPublicIdForUser: vi.fn(),
    acquireCredentialMutationLock: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthMethodService;

  const authSessionService = {
    createSessionForUser: vi.fn().mockResolvedValue({ public_id: 'session_public' }),
  } as unknown as AuthSessionService;

  const redis = {
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    getdel: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    // route-audit C5: lockout counter now uses an atomic INCR+EXPIRE Lua via redis.eval.
    eval: vi.fn().mockResolvedValue(1),
  };

  const service = new MfaService(
    userService,
    authMethodService,
    authSessionService,
    redis as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    redis.set.mockResolvedValue('OK');
    redis.get.mockResolvedValue(null);
    redis.incr.mockResolvedValue(1);
    redis.expire.mockResolvedValue(1);
    redis.eval.mockResolvedValue(1);
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(user as never);
    vi.mocked(authMethodService.findTotpByUserId).mockResolvedValue({
      id: 5,
      encrypted_secret: 'TESTSECRET',
    } as never);
    vi.mocked(userService.updateMfaEnabled).mockResolvedValue(undefined as never);
  });

  it('verifyLoginMfa issues session after valid TOTP', async () => {
    const result = await service.verifyLoginMfa(
      { mfa_session_token: 'token', totp_code: '123456' },
      '127.0.0.1',
    );
    expect(result.access_token).toBe('access-token');
    // The handler audits recovery-code use distinctly, so the factor must be surfaced.
    expect(result.factor).toBe('totp');
    expect(authSessionService.createSessionForUser).toHaveBeenCalled();
    // H1 regression guard: the MFA-login token MUST carry the active-org `org` claim, exactly like
    // the first-factor path. Without it an MFA user gets an org-less token and is locked out of
    // every org-scoped route (which resolve the active org from the claim post-flatten).
    expect(vi.mocked(signAccessToken)).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: 'org_mfaactive0000000000' }),
    );
  });

  it('sec-U1: refuses to mint a session when the account was SUSPENDED during the MFA-session window', async () => {
    // First factor already passed (a valid mfa_session_token exists); the account was suspended
    // before the second factor completed. `auth.service` blocks suspended users BEFORE minting the
    // MFA token — this second guard covers the window AFTER, a real TOCTOU. Reject before any session.
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue({
      ...user,
      status: 'SUSPENDED',
    } as never);

    await expect(
      service.verifyLoginMfa({ mfa_session_token: 'token', totp_code: '123456' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(authSessionService.createSessionForUser).not.toHaveBeenCalled();
  });

  it('sec-U1: refuses to mint a session when the account was soft-deleted during the MFA-session window', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue({
      ...user,
      deleted_at: new Date(),
    } as never);

    await expect(
      service.verifyLoginMfa({ mfa_session_token: 'token', totp_code: '123456' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(authSessionService.createSessionForUser).not.toHaveBeenCalled();
  });

  it('verifyLoginMfa issues session after valid recovery code', async () => {
    const { consumeMfaRecoveryCode } = await import(
      '@/domains/auth/sub-domains/auth-mfa/auth-mfa-recovery-code.repository.js'
    );
    vi.mocked(consumeMfaRecoveryCode).mockResolvedValueOnce(true);

    const result = await service.verifyLoginMfa(
      { mfa_session_token: 'token', recovery_code: 'ABCD-1234' },
      '127.0.0.1',
    );
    expect(result.access_token).toBe('access-token');
    // Recovery-code use must be distinguishable (the TOTP-bypass break-glass path the handler flags).
    expect(result.factor).toBe('recovery_code');
    expect(consumeMfaRecoveryCode).toHaveBeenCalledWith(user.id, 'ABCD-1234');
  });

  it('reaudit-#3: a TOTP-locked-out user can STILL log in with a valid recovery code', async () => {
    const { consumeMfaRecoveryCode } = await import(
      '@/domains/auth/sub-domains/auth-mfa/auth-mfa-recovery-code.repository.js'
    );
    redis.eval.mockResolvedValue(11); // > MAX_MFA_VERIFICATION_ATTEMPTS — atomic counter says locked
    vi.mocked(consumeMfaRecoveryCode).mockResolvedValueOnce(true);

    // TOTP is rejected while locked...
    await expect(
      service.verifyLoginMfa({ mfa_session_token: 'token', totp_code: '123456' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    // ...but the recovery (break-glass) code still works — the lockout does not gate it.
    const result = await service.verifyLoginMfa(
      { mfa_session_token: 'token', recovery_code: 'ABCD-1234' },
      '127.0.0.1',
    );
    expect(result.access_token).toBe('access-token');
  });

  it('reaudit-#3: a wrong recovery code does NOT increment the TOTP lockout counter', async () => {
    const { consumeMfaRecoveryCode } = await import(
      '@/domains/auth/sub-domains/auth-mfa/auth-mfa-recovery-code.repository.js'
    );
    vi.mocked(consumeMfaRecoveryCode).mockResolvedValueOnce(false);

    await expect(
      service.verifyLoginMfa(
        { mfa_session_token: 'token', recovery_code: 'WRONG-9999' },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('verifyLoginMfa rejects already-used recovery codes', async () => {
    const { consumeMfaRecoveryCode } = await import(
      '@/domains/auth/sub-domains/auth-mfa/auth-mfa-recovery-code.repository.js'
    );
    vi.mocked(consumeMfaRecoveryCode).mockResolvedValueOnce(false);

    await expect(
      service.verifyLoginMfa(
        { mfa_session_token: 'token', recovery_code: 'USED-CODE1' },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('verify accepts valid TOTP code', async () => {
    const result = await service.verify('user_public', { code: '123456' });
    expect(result.verified).toBe(true);
    expect(authMethodService.updateAuthMethodLastUsedAt).toHaveBeenCalled();
  });

  it('verify records a failure and rejects on an invalid TOTP code (audit-#12)', async () => {
    const { verify } = await import('otplib');
    vi.mocked(verify).mockResolvedValueOnce({ valid: false } as never);
    await expect(service.verify('user_public', { code: '000000' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'mfa:verify:fail:1',
      expect.any(String),
    );
  });

  it('verify locks out atomically before checking the code once the budget is exhausted (audit-#12 / route-audit-#4)', async () => {
    redis.eval.mockResolvedValue(11); // > MAX_MFA_VERIFICATION_ATTEMPTS — atomic counter says locked
    const { verify } = await import('otplib');
    await expect(service.verify('user_public', { code: '123456' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it('route-audit-#4: counts the attempt with an atomic INCR up-front, not a read-only GET', async () => {
    redis.eval.mockResolvedValue(1); // under budget
    await service.verify('user_public', { code: '123456' });
    // The counter is incremented atomically per attempt (so concurrent guesses get distinct
    // counts and cannot overspend the budget); the old non-atomic read-only GET check is gone.
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'mfa:verify:fail:1',
      expect.any(String),
    );
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('verify clears the failure counter on success (audit-#12)', async () => {
    await service.verify('user_public', { code: '123456' });
    expect(redis.del).toHaveBeenCalledWith('mfa:verify:fail:1');
  });

  it('verifyLoginMfa records a failure on an invalid TOTP code (audit-#12)', async () => {
    const { verify } = await import('otplib');
    vi.mocked(verify).mockResolvedValueOnce({ valid: false } as never);
    await expect(
      service.verifyLoginMfa(
        { mfa_session_token: 'session-token', totp_code: '000000' },
        '127.0.0.1',
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'mfa:verify:fail:1',
      expect.any(String),
    );
  });

  it('verify rejects when MFA not enabled', async () => {
    vi.mocked(authMethodService.findTotpByUserId).mockResolvedValue(null);
    await expect(service.verify('user_public', { code: '123456' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('enrollInit stages the secret in Redis without persisting an auth_methods row or flipping is_mfa_enabled', async () => {
    // sec-A finding #3: phase 1 of the two-phase ceremony. The secret/provisioning URI
    // are returned to the caller but NOTHING is written to Postgres until phase 2
    // confirms a fresh code. The prior single-step `enroll` flipped is_mfa_enabled
    // immediately, locking users out when transcription failed.
    const result = await service.enrollInit('user_public', { method_type: 'MFA_TOTP' });
    expect(result.secret).toBe('TESTSECRET');
    expect(result.provisioning_uri).toContain('otpauth://');
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^mfa:enroll:/),
      expect.any(String),
      'EX',
      expect.any(Number),
    );
    expect(authMethodService.createAuthMethodRecord).not.toHaveBeenCalled();
    expect(userService.updateMfaEnabled).not.toHaveBeenCalled();
  });

  it('enrollInit rejects non-TOTP method types', async () => {
    await expect(
      service.enrollInit('user_public', { method_type: 'MFA_SMS' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(redis.set).not.toHaveBeenCalledWith(
      expect.stringMatching(/^mfa:enroll:/),
      expect.anything(),
      'EX',
      expect.anything(),
    );
  });

  it('enrollConfirm persists the auth_methods row, mints recovery codes, and flips is_mfa_enabled on a verified code (sec-re-06: flip happens INSIDE the transaction)', async () => {
    const { insertMfaRecoveryCodes } = await import(
      '@/domains/auth/sub-domains/auth-mfa/auth-mfa-recovery-code.repository.js'
    );
    const { generateMfaRecoveryCodes } = await import(
      '@/domains/auth/sub-domains/auth-mfa/auth-mfa-recovery-code.util.js'
    );
    // GETDEL returns the staged (encrypted) secret atomically.
    redis.getdel.mockResolvedValueOnce('TESTSECRET');

    // Track call order: createAuthMethodRecord → insertMfaRecoveryCodes → updateMfaEnabled
    // must all happen inside the withUserDatabaseContext callback (same transaction).
    // sec-re-06: the prior code called updateMfaEnabled AFTER withUserDatabaseContext
    // returned, on a separate connection; a crash between commit and the flip left the
    // user with valid TOTP + codes but is_mfa_enabled=false, bypassing MFA at login.
    const callOrder: string[] = [];
    vi.mocked(authMethodService.createAuthMethodRecord).mockImplementationOnce(async () => {
      callOrder.push('createAuthMethodRecord');
      return { id: 99, public_id: 'testpublicmid0000000' } as never;
    });
    vi.mocked(insertMfaRecoveryCodes).mockImplementationOnce(async () => {
      callOrder.push('insertMfaRecoveryCodes');
    });
    vi.mocked(userService.updateMfaEnabled).mockImplementationOnce(async () => {
      callOrder.push('updateMfaEnabled');
      return null as never;
    });

    const result = await service.enrollConfirm('user_public', { code: '123456' });

    expect(redis.getdel).toHaveBeenCalledWith(expect.stringMatching(/^mfa:enroll:/));
    expect(authMethodService.createAuthMethodRecord).toHaveBeenCalledWith(
      expect.objectContaining({ method_type: 'MFA_TOTP' }),
    );
    expect(insertMfaRecoveryCodes).toHaveBeenCalledTimes(1);
    expect(generateMfaRecoveryCodes).toHaveBeenCalledTimes(1);
    expect(userService.updateMfaEnabled).toHaveBeenCalledWith('user_public', true);
    // sec-new-B4: enrollConfirm now returns method_public_id (opaque id) instead of bigserial method_id.
    expect(result.method_public_id).toBeDefined();
    expect(typeof result.method_public_id).toBe('string');
    expect(result.recovery_codes).toHaveLength(10);

    // The is_mfa_enabled flip must happen AFTER the TOTP row and recovery codes
    // are written — but BEFORE the transaction commits (so they're atomic).
    expect(callOrder.indexOf('updateMfaEnabled')).toBeGreaterThan(
      callOrder.indexOf('insertMfaRecoveryCodes'),
    );
  });

  it('enrollConfirm rejects when no staged secret is present (expired or never started)', async () => {
    redis.getdel.mockResolvedValueOnce(null);
    await expect(service.enrollConfirm('user_public', { code: '123456' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(authMethodService.createAuthMethodRecord).not.toHaveBeenCalled();
    expect(userService.updateMfaEnabled).not.toHaveBeenCalled();
  });

  it('enrollConfirm rejects when the submitted code does not verify against the staged secret', async () => {
    const otp = await import('otplib');
    vi.mocked(otp.verify).mockResolvedValueOnce({ valid: false });
    redis.getdel.mockResolvedValueOnce('TESTSECRET');
    await expect(service.enrollConfirm('user_public', { code: '000000' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(authMethodService.createAuthMethodRecord).not.toHaveBeenCalled();
    expect(userService.updateMfaEnabled).not.toHaveBeenCalled();
  });

  it('sec-re-04: enrollConfirm revokes existing active TOTP methods and invalidates old recovery codes before inserting the new ones', async () => {
    // Without dedup, re-enrolling left two active MFA_TOTP rows in
    // auth_methods (the old one and the new one). findTotpByUserId had no
    // ORDER BY so login picked an arbitrary row, often the stale one — the
    // user's working authenticator codes were rejected, soft-locking the
    // account. After this fix the existing methods are revoked and the
    // user's prior recovery codes are invalidated inside the same
    // transaction BEFORE the new credentials are persisted.
    const { insertMfaRecoveryCodes, invalidateAllUnusedRecoveryCodesForUser } = await import(
      '@/domains/auth/sub-domains/auth-mfa/auth-mfa-recovery-code.repository.js'
    );
    const callOrder: string[] = [];
    vi.mocked(authMethodService.acquireCredentialMutationLock).mockImplementation(async () => {
      callOrder.push('acquireCredentialMutationLock');
    });
    vi.mocked(authMethodService.listMfaMethodsByUserId).mockImplementation(async () => {
      callOrder.push('listMfaMethodsByUserId');
      return [
        { id: 11, method_type: 'MFA_TOTP', last_used_at: null, created_at: new Date() },
        { id: 12, method_type: 'MFA_TOTP', last_used_at: null, created_at: new Date() },
      ] as never;
    });
    vi.mocked(authMethodService.revokeAuthMethod).mockImplementation(async () => {
      callOrder.push('revokeAuthMethod');
    });
    vi.mocked(invalidateAllUnusedRecoveryCodesForUser).mockImplementation(async () => {
      callOrder.push('invalidateAllUnusedRecoveryCodesForUser');
    });
    vi.mocked(authMethodService.createAuthMethodRecord).mockImplementation(async () => {
      callOrder.push('createAuthMethodRecord');
      return { id: 99, public_id: 'testpublicmid0000000' } as never;
    });
    vi.mocked(insertMfaRecoveryCodes).mockImplementation(async () => {
      callOrder.push('insertMfaRecoveryCodes');
    });
    redis.getdel.mockResolvedValueOnce('TESTSECRET');

    await service.enrollConfirm('user_public', { code: '123456' });

    // Both existing TOTP rows are revoked.
    expect(authMethodService.revokeAuthMethod).toHaveBeenCalledWith(11, user.id);
    expect(authMethodService.revokeAuthMethod).toHaveBeenCalledWith(12, user.id);
    // Recovery codes for the old secret are invalidated.
    expect(invalidateAllUnusedRecoveryCodesForUser).toHaveBeenCalledWith(user.id);
    // The new credentials are persisted.
    expect(authMethodService.createAuthMethodRecord).toHaveBeenCalledWith(
      expect.objectContaining({ method_type: 'MFA_TOTP' }),
    );
    expect(insertMfaRecoveryCodes).toHaveBeenCalledTimes(1);

    // The cleanup steps MUST complete before the new credentials are written
    // — otherwise a crash between insert and revoke leaves orphans.
    const revokeIndex = callOrder.indexOf('revokeAuthMethod');
    const invalidateIndex = callOrder.indexOf('invalidateAllUnusedRecoveryCodesForUser');
    const createIndex = callOrder.indexOf('createAuthMethodRecord');
    const insertCodesIndex = callOrder.indexOf('insertMfaRecoveryCodes');
    expect(revokeIndex).toBeGreaterThanOrEqual(0);
    expect(invalidateIndex).toBeGreaterThanOrEqual(0);
    expect(revokeIndex).toBeLessThan(createIndex);
    expect(invalidateIndex).toBeLessThan(insertCodesIndex);

    // route-audit D3: the credential-mutation advisory lock is taken FIRST — before reading the
    // existing methods — so a concurrent enroll/delete serializes on the same lock deleteMfa uses.
    const lockIndex = callOrder.indexOf('acquireCredentialMutationLock');
    const listIndex = callOrder.indexOf('listMfaMethodsByUserId');
    expect(lockIndex).toBe(0);
    expect(lockIndex).toBeLessThan(listIndex);
  });

  it('sec-re-04: enrollConfirm proceeds normally when no existing TOTP methods are present (first-time enrollment)', async () => {
    // First-time enrollment still works — no revokes happen because the
    // user has no active methods, no recovery codes to invalidate.
    const { insertMfaRecoveryCodes, invalidateAllUnusedRecoveryCodesForUser } = await import(
      '@/domains/auth/sub-domains/auth-mfa/auth-mfa-recovery-code.repository.js'
    );
    vi.mocked(authMethodService.listMfaMethodsByUserId).mockResolvedValueOnce([] as never);
    redis.getdel.mockResolvedValueOnce('TESTSECRET');

    await service.enrollConfirm('user_public', { code: '123456' });

    expect(authMethodService.revokeAuthMethod).not.toHaveBeenCalled();
    expect(invalidateAllUnusedRecoveryCodesForUser).toHaveBeenCalledWith(user.id);
    expect(authMethodService.createAuthMethodRecord).toHaveBeenCalledOnce();
    expect(insertMfaRecoveryCodes).toHaveBeenCalledOnce();
  });

  it('verifyLoginMfa rejects a replayed TOTP code within its window', async () => {
    redis.set.mockResolvedValueOnce(null);
    await expect(
      service.verifyLoginMfa({ mfa_session_token: 'token', totp_code: '123456' }, '127.0.0.1'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(authSessionService.createSessionForUser).not.toHaveBeenCalled();
  });

  it('verify rejects a replayed TOTP code within its window', async () => {
    redis.set.mockResolvedValueOnce(null);
    await expect(service.verify('user_public', { code: '123456' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('verifyLoginMfa marks the consumed TOTP code in Redis with NX', async () => {
    await service.verifyLoginMfa({ mfa_session_token: 'token', totp_code: '123456' }, '127.0.0.1');
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('mfa:totp:consumed:'),
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
  });

  it('deleteMfa revokes method and disables MFA when last method removed', async () => {
    vi.mocked(authMethodService.findAuthMethodByPublicIdForUser).mockResolvedValue({
      id: 5,
      method_type: 'MFA_TOTP',
    } as never);
    vi.mocked(authMethodService.revokeAuthMethod).mockResolvedValue({ id: 5 } as never);
    vi.mocked(authMethodService.listMfaMethodsByUserId).mockResolvedValue([]);

    await service.deleteMfa('user_public', 'mfamethodpublicid0001');
    expect(userService.updateMfaEnabled).toHaveBeenCalledWith('user_public', false);
  });

  it('listMfaMethods returns enrolled methods with the opaque public id (route-#10)', async () => {
    vi.mocked(authMethodService.listMfaMethodsByUserId).mockResolvedValue([
      {
        id: 5,
        public_id: 'mfamethodpublicid0001',
        method_type: 'MFA_TOTP',
        last_used_at: null,
        created_at: new Date(),
      },
    ] as never);
    const methods = await service.listMfaMethods('user_public');
    expect(methods).toHaveLength(1);
    // route-#10: the serialized `id` is the opaque public id, never the sequential DB id.
    expect(methods[0]?.id).toBe('mfamethodpublicid0001');
  });

  it('verify rejects invalid TOTP codes', async () => {
    const { verify } = await import('otplib');
    vi.mocked(verify).mockResolvedValueOnce({ valid: false } as never);
    await expect(service.verify('user_public', { code: '000000' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('deleteMfa keeps MFA enabled when other methods remain', async () => {
    vi.mocked(authMethodService.findAuthMethodByPublicIdForUser).mockResolvedValue({
      id: 5,
      method_type: 'MFA_TOTP',
    } as never);
    vi.mocked(authMethodService.revokeAuthMethod).mockResolvedValue({ id: 5 } as never);
    vi.mocked(authMethodService.listMfaMethodsByUserId).mockResolvedValue([
      { id: 6, method_type: 'MFA_TOTP' },
    ] as never);

    await service.deleteMfa('user_public', 'mfamethodpublicid0001');
    expect(userService.updateMfaEnabled).not.toHaveBeenCalledWith('user_public', false);
  });

  it('deleteMfa rejects unknown or non-TOTP methods', async () => {
    vi.mocked(authMethodService.findAuthMethodByPublicIdForUser).mockResolvedValue(null);
    await expect(service.deleteMfa('user_public', 'mfamethodpublicid0001')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );

    vi.mocked(authMethodService.findAuthMethodByPublicIdForUser).mockResolvedValue({
      id: 5,
      method_type: 'OAUTH',
    } as never);
    await expect(service.deleteMfa('user_public', 'mfamethodpublicid0001')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('deleteMfa rejects when user record is missing', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
    await expect(service.deleteMfa('missing', 'mfamethodpublicid0001')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('deleteMfa rejects when revoke fails', async () => {
    vi.mocked(authMethodService.findAuthMethodByPublicIdForUser).mockResolvedValue({
      id: 5,
      method_type: 'MFA_TOTP',
    } as never);
    vi.mocked(authMethodService.revokeAuthMethod).mockRejectedValue(
      new UnauthorizedError('errors:mfaMethodNotFound'),
    );
    await expect(service.deleteMfa('user_public', 'mfamethodpublicid0001')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('sec-new-A4: updateMfaEnabled is called inside the withUserDatabaseContext transaction (no TOCTOU window)', async () => {
    // Regression: the previous code called updateMfaEnabled AFTER withUserDatabaseContext
    // returned, leaving a TOCTOU gap where a concurrent enroll could flip is_mfa_enabled
    // back to true between the revoke commit and the flag update.
    const { withPrincipalDatabaseContext } = await import(
      '@/infrastructure/database/contexts/principal-database.context.js'
    );

    const callOrder: string[] = [];
    vi.mocked(withPrincipalDatabaseContext).mockImplementationOnce(
      async (_scope: unknown, callback: Parameters<typeof withPrincipalDatabaseContext>[1]) => {
        callOrder.push('txn_start');
        await callback(null as never);
        callOrder.push('txn_end');
      },
    );

    vi.mocked(authMethodService.findAuthMethodByPublicIdForUser).mockResolvedValueOnce({
      id: 5,
      method_type: 'MFA_TOTP',
    } as never);
    vi.mocked(authMethodService.revokeAuthMethod).mockImplementationOnce(async () => {
      callOrder.push('revokeAuthMethod');
      return { id: 5 } as never;
    });
    // Both listMfaMethodsByUserId calls return [] — the pre-check count is 0 (
    // wouldBeLastRemoval = true) and the post-revoke remaining count is 0.
    vi.mocked(authMethodService.listMfaMethodsByUserId).mockResolvedValue([] as never);
    vi.mocked(userService.updateMfaEnabled).mockImplementationOnce(async () => {
      callOrder.push('updateMfaEnabled');
      return null as never;
    });

    await service.deleteMfa('user_public', 'mfamethodpublicid0001');

    // updateMfaEnabled must happen INSIDE the transaction (between txn_start and txn_end)
    expect(callOrder).toContain('updateMfaEnabled');
    expect(callOrder.indexOf('updateMfaEnabled')).toBeGreaterThan(callOrder.indexOf('txn_start'));
    expect(callOrder.indexOf('updateMfaEnabled')).toBeLessThan(callOrder.indexOf('txn_end'));
    // The revoke must precede the flag flip.
    expect(callOrder.indexOf('revokeAuthMethod')).toBeLessThan(
      callOrder.indexOf('updateMfaEnabled'),
    );
  });

  it('verify and listMfaMethods reject when user record is missing', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
    await expect(service.verify('missing', { code: '123456' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(service.listMfaMethods('missing')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('enrollInit rejects when user record is missing', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
    await expect(service.enrollInit('missing', { method_type: 'MFA_TOTP' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('verify rejects when TOTP secret is missing', async () => {
    vi.mocked(authMethodService.findTotpByUserId).mockResolvedValue({
      id: 5,
      encrypted_secret: null,
    } as never);
    await expect(service.verify('user_public', { code: '123456' })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});
