import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/domains/tenancy/sub-domains/organization/resolve-active-organization.js', () => ({
  resolveDefaultActiveOrganizationPublicId: vi.fn(),
  ensurePersonalOrganizationPublicId: vi.fn(),
}));

vi.mock('@/shared/utils/security/jwt.util.js', () => ({
  signAccessToken: vi.fn().mockResolvedValue('signed.jwt.token'),
}));

vi.mock('@/shared/utils/auth/global-admin-role.util.js', () => ({
  resolveAccessTokenRoleForUser: vi.fn().mockReturnValue('user'),
}));

import { completeFirstFactorAuth } from '@/domains/auth/shared/complete-first-factor-auth.js';
import {
  resolveDefaultActiveOrganizationPublicId,
  ensurePersonalOrganizationPublicId,
} from '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js';
import { signAccessToken } from '@/shared/utils/security/jwt.util.js';

const user = {
  id: 42,
  public_id: 'usr_test',
  email: 'test@example.com',
  status: 'ACTIVE',
  is_email_verified: true,
  is_mfa_enabled: false,
};

function buildServices() {
  return {
    organizationSettingsService: {
      userHasOrganizationRequiringMfa: vi.fn().mockResolvedValue(false),
    } as never,
    mfaService: { createMfaSession: vi.fn() } as never,
    authSessionService: {
      createSessionForUser: vi
        .fn()
        .mockResolvedValue({ public_id: 'ses_test', refresh_secret: 'refresh_secret' }),
    } as never,
  };
}

describe('completeFirstFactorAuth — personal-organization self-heal (item #5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(signAccessToken).mockResolvedValue('signed.jwt.token');
  });

  it('provisions a personal organization into the token when the user resolves to none and the caller opts in', async () => {
    vi.mocked(resolveDefaultActiveOrganizationPublicId).mockResolvedValue(undefined);
    vi.mocked(ensurePersonalOrganizationPublicId).mockResolvedValue('org_personalnew');

    await completeFirstFactorAuth({
      user,
      ipAddress: '127.0.0.1',
      ...buildServices(),
      ensurePersonalOrganizationOnMiss: true,
    });

    expect(ensurePersonalOrganizationPublicId).toHaveBeenCalledWith(user.id);
    expect(signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: 'org_personalnew' }),
    );
  });

  it('does NOT self-heal when the caller does not opt in (the email-code / pinned paths)', async () => {
    vi.mocked(resolveDefaultActiveOrganizationPublicId).mockResolvedValue(undefined);

    await completeFirstFactorAuth({
      user,
      ipAddress: '127.0.0.1',
      ...buildServices(),
    });

    expect(ensurePersonalOrganizationPublicId).not.toHaveBeenCalled();
    expect(signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: undefined }),
    );
  });

  it('does not self-heal when the user already resolves to an organization', async () => {
    vi.mocked(resolveDefaultActiveOrganizationPublicId).mockResolvedValue('org_existing');

    await completeFirstFactorAuth({
      user,
      ipAddress: '127.0.0.1',
      ...buildServices(),
      ensurePersonalOrganizationOnMiss: true,
    });

    expect(ensurePersonalOrganizationPublicId).not.toHaveBeenCalled();
    expect(signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: 'org_existing' }),
    );
  });
});
