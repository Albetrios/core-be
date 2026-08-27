import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

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

import { ForbiddenError } from '@/shared/errors/index.js';
import { MfaService } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';

/**
 * Regression for sec-A4 (High): when an organization the user belongs to requires MFA via
 * its `organization_settings.require_mfa` policy, `DELETE /auth/me/mfa/:id` must NOT allow
 * the user to remove their last MFA method — that would silently downgrade them to
 * password-only authentication in direct contradiction of org policy. Removing any
 * non-last MFA method (i.e. another factor remains) is still allowed; this guard fires
 * only when the deletion would empty the user's MFA set.
 */
describe('MfaService.deleteMfa — organization MFA policy guard (sec-A4)', () => {
  const userService = {
    requireUserRecordByPublicId: vi.fn(),
    updateMfaEnabled: vi.fn().mockResolvedValue(undefined),
  } as unknown as UserService;

  const authMethodService = {
    findAuthMethodByPublicIdForUser: vi.fn(),
    revokeAuthMethod: vi.fn().mockResolvedValue(undefined),
    listMfaMethodsByUserId: vi.fn(),
    acquireCredentialMutationLock: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthMethodService;

  const authSessionService = {} as AuthSessionService;
  const redis = {} as Redis;

  const organizationSettingsService = {
    userHasOrganizationRequiringMfa: vi.fn(),
  } as unknown as OrganizationSettingsService;

  const service = new MfaService(
    userService,
    authMethodService,
    authSessionService,
    redis,
    organizationSettingsService,
  );

  const user = {
    id: 7,
    public_id: 'user_pub',
    email: 'mfa@example.com',
    status: 'ACTIVE',
    is_mfa_enabled: true,
  };

  const totpMethod = { id: 42, user_id: 7, method_type: 'MFA_TOTP', revoked_at: null };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(user as never);
    vi.mocked(authMethodService.findAuthMethodByPublicIdForUser).mockResolvedValue(
      totpMethod as never,
    );
  });

  it('refuses to delete the LAST MFA method when the user belongs to an MFA-required org', async () => {
    // Pre-revoke list returns [target] — exactly 1 method, so revoke would empty the set.
    vi.mocked(authMethodService.listMfaMethodsByUserId).mockResolvedValue([
      { id: 42, user_id: 7, method_type: 'MFA_TOTP' },
    ] as never);
    vi.mocked(organizationSettingsService.userHasOrganizationRequiringMfa).mockResolvedValue(true);

    await expect(service.deleteMfa('user_pub', 'mfamethodpublicid0001')).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    // The org-policy guard fires AFTER the candidate-method lookup but BEFORE the revoke;
    // the revoke must NOT execute and is_mfa_enabled must NOT flip.
    expect(authMethodService.revokeAuthMethod).not.toHaveBeenCalled();
    expect(userService.updateMfaEnabled).not.toHaveBeenCalled();
  });

  it('allows deleting the last MFA method when no org of the user requires MFA', async () => {
    // Pre-revoke list: 1 method (target). Post-revoke list: empty → flips is_mfa_enabled.
    vi.mocked(authMethodService.listMfaMethodsByUserId)
      .mockResolvedValueOnce([{ id: 42, user_id: 7, method_type: 'MFA_TOTP' }] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(organizationSettingsService.userHasOrganizationRequiringMfa).mockResolvedValue(false);

    await expect(service.deleteMfa('user_pub', 'mfamethodpublicid0001')).resolves.toBeUndefined();

    expect(authMethodService.revokeAuthMethod).toHaveBeenCalledWith(42, user.id);
    expect(userService.updateMfaEnabled).toHaveBeenCalledWith('user_pub', false);
  });

  it('allows deleting a non-last MFA method even when org policy requires MFA (another factor remains)', async () => {
    // Pre-revoke list: 2 methods (the target id 42 + another). Post-revoke list (returned
    // after the revoke completes): 1 method left, so is_mfa_enabled stays true.
    vi.mocked(authMethodService.listMfaMethodsByUserId)
      .mockResolvedValueOnce([
        { id: 42, user_id: 7, method_type: 'MFA_TOTP' },
        { id: 99, user_id: 7, method_type: 'MFA_TOTP' },
      ] as never)
      .mockResolvedValueOnce([{ id: 99, user_id: 7, method_type: 'MFA_TOTP' }] as never);
    vi.mocked(organizationSettingsService.userHasOrganizationRequiringMfa).mockResolvedValue(true);

    await expect(service.deleteMfa('user_pub', 'mfamethodpublicid0001')).resolves.toBeUndefined();

    expect(authMethodService.revokeAuthMethod).toHaveBeenCalledWith(42, user.id);
    // Not the last method → is_mfa_enabled stays true.
    expect(userService.updateMfaEnabled).not.toHaveBeenCalled();
  });
});
