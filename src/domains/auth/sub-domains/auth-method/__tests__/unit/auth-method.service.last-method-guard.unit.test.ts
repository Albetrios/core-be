import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { AuthMethodRepository } from '@/domains/auth/sub-domains/auth-method/auth-method.repository.js';
import type { VerificationTokenRepository } from '@/domains/auth/sub-domains/auth-method/verification-token/verification-token.repository.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';

vi.mock('@/infrastructure/database/contexts/user-database.context.js', () => ({
  withUserDatabaseContext: vi.fn(async (_userPublicId: string, callback: () => Promise<unknown>) =>
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

// Stable 21-char test public ids used across all scenarios in this suite.
const METHOD_PUB_A = 'testmethodpuba123456'; // being deleted

/**
 * Regression for sec-A5 (Medium): `DELETE /me/auth-methods/:publicId` must refuse to revoke the
 * user's last login-capable credential (PASSWORD/OAUTH/EMAIL_CODE), or the user is locked out.
 *
 * route-audit C1: the "is another login-capable method active?" check and the revoke now run in ONE
 * statement (`revokeUnlessLastLoginCapable` — an `EXISTS` over the user's other active rows), so two
 * concurrent deletes cannot each read "one other left" and both succeed. A zero-row result for a
 * login-capable method surfaces as `ForbiddenError('cannotRemoveLastAuthMethod')`.
 */
describe('AuthMethodService.delete — last-method guard (sec-A5 / route-audit C1 atomic)', () => {
  const userService = {
    requireUserRecordByPublicId: vi.fn(),
    clearPasswordHash: vi.fn().mockResolvedValue(null),
  } as unknown as UserService;

  const authMethodRepository = {
    findByPublicIdForUser: vi.fn(),
    revokeUnlessLastLoginCapable: vi.fn(),
  } as unknown as AuthMethodRepository;

  const verificationTokenRepository = {} as VerificationTokenRepository;
  const authSessionService = {} as AuthSessionService;

  const service = new AuthMethodService(
    userService,
    authMethodRepository,
    verificationTokenRepository,
    authSessionService,
  );

  const user = { id: 1, public_id: 'user_pub' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(user as never);
    // Default: the guarded revoke succeeds (another login-capable method remains / not login-capable).
    vi.mocked(authMethodRepository.revokeUnlessLastLoginCapable).mockResolvedValue({
      id: 42,
      user_id: 1,
    } as never);
  });

  it('refuses to delete the last login-capable method (PASSWORD only)', async () => {
    vi.mocked(authMethodRepository.findByPublicIdForUser).mockResolvedValue({
      id: 42,
      public_id: METHOD_PUB_A,
      user_id: 1,
      method_type: 'PASSWORD',
      revoked_at: null,
    } as never);
    // Atomic guard matches zero rows — no other login-capable method remains.
    vi.mocked(authMethodRepository.revokeUnlessLastLoginCapable).mockResolvedValue(null as never);

    await expect(service.delete('user_pub', METHOD_PUB_A)).rejects.toBeInstanceOf(ForbiddenError);
    expect(userService.clearPasswordHash).not.toHaveBeenCalled();
  });

  it('allows deletion of one of several login-capable methods (PASSWORD when OAUTH remains)', async () => {
    vi.mocked(authMethodRepository.findByPublicIdForUser).mockResolvedValue({
      id: 42,
      public_id: METHOD_PUB_A,
      user_id: 1,
      method_type: 'PASSWORD',
      revoked_at: null,
    } as never);

    await expect(service.delete('user_pub', METHOD_PUB_A)).resolves.toBeUndefined();
    // The login-capable type set is passed so the repository can build the EXISTS guard.
    expect(authMethodRepository.revokeUnlessLastLoginCapable).toHaveBeenCalledWith(
      42,
      user.id,
      expect.arrayContaining(['PASSWORD', 'OAUTH', 'EMAIL_CODE']),
    );
    // PASSWORD revocation also clears the stale hash.
    expect(userService.clearPasswordHash).toHaveBeenCalledWith('user_pub');
  });

  it('allows deletion of an MFA method even when it is the only credential — the guard is login-capable-only', async () => {
    vi.mocked(authMethodRepository.findByPublicIdForUser).mockResolvedValue({
      id: 42,
      public_id: METHOD_PUB_A,
      user_id: 1,
      method_type: 'MFA_TOTP',
      revoked_at: null,
    } as never);

    await expect(service.delete('user_pub', METHOD_PUB_A)).resolves.toBeUndefined();
    expect(authMethodRepository.revokeUnlessLastLoginCapable).toHaveBeenCalledWith(
      42,
      user.id,
      expect.any(Array),
    );
    expect(userService.clearPasswordHash).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the method does not exist (no guarded revoke)', async () => {
    vi.mocked(authMethodRepository.findByPublicIdForUser).mockResolvedValue(null);

    await expect(service.delete('user_pub', METHOD_PUB_A)).rejects.toBeInstanceOf(NotFoundError);
    expect(authMethodRepository.revokeUnlessLastLoginCapable).not.toHaveBeenCalled();
  });
});
