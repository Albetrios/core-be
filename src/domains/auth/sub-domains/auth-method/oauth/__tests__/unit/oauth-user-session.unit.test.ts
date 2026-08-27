import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ForbiddenError, UnauthorizedError } from '@/shared/errors/index.js';
import { completeOAuthUserSession } from '@/domains/auth/sub-domains/auth-method/oauth/oauth-user-session.js';
import { ensurePersonalOrganization } from '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js';

vi.mock('@/shared/utils/text/email.util.js', () => ({
  isDisposableEmailBlocked: vi.fn(() => false),
}));

vi.mock('@/shared/utils/security/jwt.util.js', () => ({
  signAccessToken: vi.fn().mockResolvedValue('access-token'),
}));

// Run the signup flow without a real database: invoke the transaction callback
// directly and pass through the pinned-handle wrapper.
vi.mock('@/infrastructure/database/transaction.js', () => ({
  withTransaction: (callback: (transaction: unknown) => Promise<unknown>) => callback({}),
}));

vi.mock(
  '@/infrastructure/database/contexts/database-context-runtime.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      runWithPinnedDatabaseHandle: (_handle: unknown, callback: () => Promise<unknown>) =>
        callback(),
    };
  },
);

vi.mock('@/domains/tenancy/sub-domains/organization/resolve-active-organization.js', () => ({
  ensurePersonalOrganization: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/domains/auth/shared/complete-first-factor-auth.js', () => ({
  completeFirstFactorAuth: vi.fn().mockResolvedValue({
    access_token: 'access-token',
    session_public_id: 'session_public',
  }),
}));

describe('completeOAuthUserSession', () => {
  const userService = {
    findByEmail: vi.fn().mockResolvedValue(null),
    createFromOAuth: vi.fn().mockResolvedValue({
      id: 1,
      public_id: 'user_public',
      email: 'new@example.com',
      status: 'ACTIVE',
      is_email_verified: true,
    }),
    updateEmailVerified: vi.fn().mockResolvedValue(null),
  };
  const authMethodService = {
    linkOAuthProviderIfMissing: vi.fn().mockResolvedValue(undefined),
    findByProviderUserId: vi.fn().mockResolvedValue(null),
    hasActiveLoginCredential: vi.fn().mockResolvedValue(false),
  };
  const authSessionService = {
    createSessionForUser: vi.fn().mockResolvedValue({ public_id: 'session_public' }),
  };

  const organizationSettingsService = {
    userHasOrganizationRequiringMfa: vi.fn().mockResolvedValue(false),
  };
  const mfaService = {
    createMfaSession: vi.fn(),
  };

  function callCompleteOAuthUserSession() {
    return completeOAuthUserSession({
      userService: userService as never,
      authMethodService: authMethodService as never,
      authSessionService: authSessionService as never,
      organizationSettingsService: organizationSettingsService as never,
      mfaService: mfaService as never,
      provider: 'google',
      profile: {
        email: 'victim@example.com',
        provider_user_id: 'google-1',
      },
      ipAddress: '127.0.0.1',
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    userService.findByEmail.mockResolvedValue(null);
    userService.updateEmailVerified.mockResolvedValue(null);
    authMethodService.findByProviderUserId.mockResolvedValue(null);
    authMethodService.hasActiveLoginCredential.mockResolvedValue(false);
  });

  it('blocks OAuth signup when disposable email is not allowed', async () => {
    const { isDisposableEmailBlocked } = await import('@/shared/utils/text/email.util.js');
    vi.mocked(isDisposableEmailBlocked).mockReturnValueOnce(true);

    await expect(
      completeOAuthUserSession({
        userService: userService as never,
        authMethodService: authMethodService as never,
        authSessionService: authSessionService as never,
        organizationSettingsService: organizationSettingsService as never,
        mfaService: mfaService as never,
        provider: 'google',
        profile: {
          email: 'test@yopmail.com',
          provider_user_id: 'google-1',
        },
        ipAddress: '127.0.0.1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(userService.createFromOAuth).not.toHaveBeenCalled();
  });

  it('blocks find-or-link into a pre-existing password account whose email is unverified', async () => {
    // Credential-bearing (has a password) but unverified: a squatter who registered with the
    // victim's email must not be silently merged into via an OAuth find-or-link.
    userService.findByEmail.mockResolvedValue({
      id: 42,
      public_id: 'victim_public',
      email: 'victim@example.com',
      status: 'ACTIVE',
      is_email_verified: false,
      password_hash: 'hashed-password',
    });

    const error = await callCompleteOAuthUserSession().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({ messageKey: 'errors:oauthLinkRequiresVerifiedAccount' });
    expect(authMethodService.linkOAuthProviderIfMissing).not.toHaveBeenCalled();
    expect(authSessionService.createSessionForUser).not.toHaveBeenCalled();
    // The account already has a credential, so the bare-claim path is never even probed.
    expect(authMethodService.hasActiveLoginCredential).not.toHaveBeenCalled();
    expect(userService.updateEmailVerified).not.toHaveBeenCalled();
  });

  it('sec-U1: refuses to mint a session for a returning VERIFIED account that was suspended since signup', async () => {
    // A verified pre-existing account clears the find-or-link takeover checks, but if it has since
    // been suspended the OAuth callback must NOT issue a session (the method docstring promises to
    // reject suspended/locked accounts before minting).
    userService.findByEmail.mockResolvedValue({
      id: 42,
      public_id: 'returning_public',
      email: 'returning@example.com',
      status: 'SUSPENDED',
      is_email_verified: true,
    });

    const error = await callCompleteOAuthUserSession().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(authSessionService.createSessionForUser).not.toHaveBeenCalled();
  });

  it('blocks find-or-link into an unverified passkey-only account (passkey counts as a credential)', async () => {
    // No password, but a real credential exists — here a WebAuthn passkey, which hasActiveLoginCredential
    // counts (hasLoginCapableMethod would NOT). This is NOT a bare placeholder, so the guard must still
    // block the silent merge even though the email is unverified. Regression guard for the latent
    // takeover gap where account-claim safety relied on the "passkey ⇒ verified" invariant.
    userService.findByEmail.mockResolvedValue({
      id: 42,
      public_id: 'passkey_public',
      email: 'victim@example.com',
      status: 'ACTIVE',
      is_email_verified: false,
      password_hash: null,
    });
    authMethodService.hasActiveLoginCredential.mockResolvedValue(true);

    const error = await callCompleteOAuthUserSession().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error).toMatchObject({ messageKey: 'errors:oauthLinkRequiresVerifiedAccount' });
    expect(authMethodService.linkOAuthProviderIfMissing).not.toHaveBeenCalled();
    expect(userService.updateEmailVerified).not.toHaveBeenCalled();
  });

  it('claims a bare unverified invited placeholder: verifies the email, links the provider, issues a session', async () => {
    // A pre-provisioned invited placeholder — no password, no login-capable method, unverified. The
    // provider proves control of the email, so the OAuth callback claims it instead of throwing.
    userService.findByEmail.mockResolvedValue({
      id: 42,
      public_id: 'invited_public',
      email: 'victim@example.com',
      status: 'ACTIVE',
      is_email_verified: false,
      password_hash: null,
    });
    authMethodService.hasActiveLoginCredential.mockResolvedValue(false);
    userService.updateEmailVerified.mockResolvedValue({
      id: 42,
      public_id: 'invited_public',
      email: 'victim@example.com',
      status: 'ACTIVE',
      is_email_verified: true,
    });

    const result = await callCompleteOAuthUserSession();

    expect(userService.updateEmailVerified).toHaveBeenCalledWith('invited_public');
    expect(authMethodService.linkOAuthProviderIfMissing).toHaveBeenCalledTimes(1);
    expect(userService.createFromOAuth).not.toHaveBeenCalled();
    expect('session_public_id' in result && result.session_public_id).toBe('session_public');
  });

  it('auto-links into a pre-existing account whose email is already verified', async () => {
    userService.findByEmail.mockResolvedValue({
      id: 42,
      public_id: 'verified_public',
      email: 'victim@example.com',
      status: 'ACTIVE',
      is_email_verified: true,
    });

    const result = await callCompleteOAuthUserSession();

    expect('session_public_id' in result && result.session_public_id).toBe('session_public');
    expect(authMethodService.linkOAuthProviderIfMissing).toHaveBeenCalledTimes(1);
    expect(userService.createFromOAuth).not.toHaveBeenCalled();
  });

  it('issues a session for a returning OAuth user even if the account email is unverified', async () => {
    userService.findByEmail.mockResolvedValue({
      id: 42,
      public_id: 'returning_public',
      email: 'victim@example.com',
      status: 'ACTIVE',
      is_email_verified: false,
      password_hash: null,
    });
    // A returning OAuth user already has a linked (login-capable) OAuth method, so this is the
    // already-linked path — not a bare-placeholder claim.
    authMethodService.hasActiveLoginCredential.mockResolvedValue(true);
    authMethodService.findByProviderUserId.mockResolvedValue({
      id: 7,
      user_id: 42,
      provider: 'google',
      provider_user_id: 'google-1',
    });

    const result = await callCompleteOAuthUserSession();

    expect('session_public_id' in result && result.session_public_id).toBe('session_public');
    // The identity is already linked, so the unverified-email is left untouched (no silent claim).
    expect(userService.updateEmailVerified).not.toHaveBeenCalled();
  });

  it('creates a new user on first-time OAuth signup', async () => {
    userService.findByEmail.mockResolvedValue(null);

    const result = await callCompleteOAuthUserSession();

    expect(userService.createFromOAuth).toHaveBeenCalledTimes(1);
    expect('session_public_id' in result && result.session_public_id).toBe('session_public');
  });

  it('provisions the personal org through the idempotent resolver on first-time signup', async () => {
    // Must be `ensurePersonalOrganization`, not raw `provisionPersonalOrganization`:
    // the raw insert trips `idx_org_one_personal_per_owner` (23505) whenever the org
    // already exists, which logged a spurious ERROR on every such login.
    userService.findByEmail.mockResolvedValue(null);

    await callCompleteOAuthUserSession();

    expect(vi.mocked(ensurePersonalOrganization)).toHaveBeenCalledWith(1);
  });

  it('still issues a session when personal-org provisioning fails (best-effort)', async () => {
    // Provisioning is deliberately best-effort — `tool:backfill-personal-orgs` and the
    // self-heal path recover a miss. A failure here must never cost the user their login.
    userService.findByEmail.mockResolvedValue(null);
    vi.mocked(ensurePersonalOrganization).mockRejectedValueOnce(new Error('provisioning down'));

    const result = await callCompleteOAuthUserSession();

    expect('session_public_id' in result && result.session_public_id).toBe('session_public');
  });

  it('route-audit: normalizes a mixed-case/padded provider email (no duplicate-account fork)', async () => {
    userService.findByEmail.mockResolvedValue(null);

    await completeOAuthUserSession({
      userService: userService as never,
      authMethodService: authMethodService as never,
      authSessionService: authSessionService as never,
      organizationSettingsService: organizationSettingsService as never,
      mfaService: mfaService as never,
      provider: 'google',
      profile: { email: '  Victim@Example.COM ', provider_user_id: 'google-1' },
      ipAddress: '127.0.0.1',
    });

    // Lookup uses the lowercased email — otherwise it would miss an existing `victim@example.com`
    // row (case-sensitive unique index) and fork a second account, sidestepping the link guard.
    expect(userService.findByEmail).toHaveBeenCalledWith('victim@example.com');
    // And a first-time signup persists the normalized email, not the raw mixed-case/padded one.
    expect(userService.createFromOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'victim@example.com' }),
    );
  });
});
