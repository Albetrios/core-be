import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/utils/security/password.util.js', () => ({
  hashPassword: vi.fn().mockResolvedValue('hashed'),
  verifyPassword: vi.fn().mockResolvedValue({ valid: true, needsRehash: false }),
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

import { ForbiddenError, UnauthorizedError } from '@/shared/errors/index.js';
import { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import { verifyPassword } from '@/shared/utils/security/password.util.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { AuthMethodRepository } from '@/domains/auth/sub-domains/auth-method/auth-method.repository.js';
import type { VerificationTokenRepository } from '@/domains/auth/sub-domains/auth-method/verification-token/verification-token.repository.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';

/**
 * Regression for sec-A1 (High): the `/auth/step-up` route — gate in front of every sensitive
 * credential mutation (`mfa/enroll`, `mfa/:id` delete, `webauthn/register/*`, `me/auth-methods`
 * create/delete, `password/change`) — must NOT accept a password-only step-up when the user
 * has MFA enabled. Otherwise a transient stolen-session compromise plus knowledge of the
 * password is enough to delete MFA, register a passkey, and convert the stolen window into
 * permanent account access.
 *
 * MFA users must step up via `/auth/me/mfa/verify` (which already records `recordRecentStepUp`)
 * — not via password-only re-verification.
 */
describe('AuthMethodService.verifyPasswordForStepUp — MFA bypass guard (sec-A1)', () => {
  const userService = {
    requireUserRecordByPublicId: vi.fn(),
  } as unknown as UserService;
  const authMethodRepository = {} as AuthMethodRepository;
  const verificationTokenRepository = {} as VerificationTokenRepository;
  const authSessionService = {} as AuthSessionService;

  const service = new AuthMethodService(
    userService,
    authMethodRepository,
    verificationTokenRepository,
    authSessionService,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyPassword).mockResolvedValue({ valid: true, needsRehash: false });
  });

  it('refuses password-only step-up for an MFA-enabled user (force MFA verify instead)', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue({
      id: 1,
      public_id: 'user_pub',
      email: 'mfa@example.com',
      status: 'ACTIVE',
      password_hash: 'hashed',
      is_mfa_enabled: true,
      is_email_verified: true,
    } as never);

    await expect(
      service.verifyPasswordForStepUp({ userPublicId: 'user_pub', password: 'correct-password' }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // `verifyPassword` should not even be invoked — the MFA-required check fires first to
    // also avoid the password-timing oracle.
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('still allows password step-up for a non-MFA user (control case — normal flow works)', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue({
      id: 1,
      public_id: 'user_pub',
      email: 'nomfa@example.com',
      status: 'ACTIVE',
      password_hash: 'hashed',
      is_mfa_enabled: false,
      is_email_verified: true,
    } as never);

    await expect(
      service.verifyPasswordForStepUp({ userPublicId: 'user_pub', password: 'correct-password' }),
    ).resolves.toBeUndefined();

    expect(verifyPassword).toHaveBeenCalledWith('correct-password', 'hashed');
  });

  it('still rejects an incorrect password for a non-MFA user (negative control)', async () => {
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue({
      id: 1,
      public_id: 'user_pub',
      email: 'nomfa@example.com',
      status: 'ACTIVE',
      password_hash: 'hashed',
      is_mfa_enabled: false,
      is_email_verified: true,
    } as never);
    vi.mocked(verifyPassword).mockResolvedValue({ valid: false, needsRehash: false });

    await expect(
      service.verifyPasswordForStepUp({ userPublicId: 'user_pub', password: 'wrong' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
