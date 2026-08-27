import { createHash } from 'node:crypto';
import { resolveAccessTokenRoleForUser } from '@/shared/utils/auth/global-admin-role.util.js';
import { signAccessToken } from '@/shared/utils/security/jwt.util.js';
import { env } from '@/shared/config/env.config.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import {
  ensurePersonalOrganizationPublicId,
  resolveDefaultActiveOrganizationPublicId,
} from '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import type { MfaService } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa.service.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';

/** User fields required to decide MFA policy and mint a session after first-factor success. */
export interface FirstFactorAuthUser {
  id: number;
  public_id: string;
  email: string;
  status: string;
  is_email_verified: boolean;
  is_mfa_enabled: boolean;
}

/** Result of a successful first-factor authentication step (password, magic link, OAuth, WebAuthn). */
export type FirstFactorAuthResult =
  | { access_token: string; session_public_id: string; session_refresh_secret: string }
  | { mfa_required: true; mfa_session_token: string };

/**
 * Central post-first-factor gate: enforces organization MFA policy before issuing a JWT/session.
 *
 * @remarks
 * Password login, magic link, OAuth, and WebAuthn must all call this helper so tenant-required MFA
 * cannot be bypassed by alternate authentication methods.
 *
 * `ensurePersonalOrganizationOnMiss` (item #5) opts a caller into self-healing: when the user
 * resolves to NO active organization but personal orgs are enabled, provision their personal org so
 * the minted token carries it instead of `undefined`. Only **non-pinned** callers may opt in — the
 * email-code login mints inside its single-use-code transaction (audit-#12) and self-provisions
 * post-commit, so it must NOT trigger this separate-connection write. `ensurePersonalOrganizationPublicId`
 * is best-effort and never throws, so opting in cannot fail a login.
 */
export async function completeFirstFactorAuth(options: {
  user: FirstFactorAuthUser;
  ipAddress: string;
  userAgent?: string | undefined;
  organizationSettingsService: OrganizationSettingsService;
  mfaService: MfaService;
  authSessionService: AuthSessionService;
  /** Non-pinned callers only: provision a personal org when the user resolves to none (see @remarks). */
  ensurePersonalOrganizationOnMiss?: boolean;
}): Promise<FirstFactorAuthResult> {
  const organizationRequiresMfa =
    await options.organizationSettingsService.userHasOrganizationRequiringMfa(options.user.id);
  if (options.user.is_mfa_enabled || organizationRequiresMfa) {
    const mfaSessionToken = await options.mfaService.createMfaSession(options.user.public_id);
    return { mfa_required: true, mfa_session_token: mfaSessionToken };
  }

  // Default active organization for this login: personal (when enabled) else most-recent team,
  // else undefined (team-only mode with no team yet → the frontend redirects to onboarding).
  let organizationPublicId = await resolveDefaultActiveOrganizationPublicId(options.user.id);
  // Item #5: a personal-org user who resolves to nothing (a signup-time provisioning miss) would be
  // stranded on the onboarding wizard. Self-heal on the opted-in non-pinned paths so the token
  // carries their personal org. Best-effort + idempotent — never fails the login.
  if (
    !organizationPublicId &&
    options.ensurePersonalOrganizationOnMiss &&
    env.PERSONAL_ORGANIZATION_ENABLED
  ) {
    organizationPublicId = await ensurePersonalOrganizationPublicId(options.user.id);
  }

  const jsonWebToken = await signAccessToken({
    userId: options.user.public_id,
    role: resolveAccessTokenRoleForUser({
      email: options.user.email,
      status: options.user.status,
      isEmailVerified: options.user.is_email_verified,
    }),
    organizationPublicId,
  });

  const sessionTokenHash = createHash('sha256').update(jsonWebToken).digest('hex');
  const sessionMaxAgeDays = env.AUTH_SESSION_MAX_AGE_DAYS;
  const expiresAt = new Date(Date.now() + sessionMaxAgeDays * MILLISECONDS_PER_DAY);

  const session = await options.authSessionService.createSessionForUser(
    options.user.public_id,
    omitUndefined({
      token_hash: sessionTokenHash,
      ip_address: options.ipAddress,
      user_agent: options.userAgent,
      expires_at: expiresAt,
    }),
  );

  // First-factor login deliberately does NOT grant a step-up window: a sensitive
  // credential mutation must be preceded by an explicit re-authentication (MFA verify
  // for MFA users, or `POST /auth/step-up` with the password for password users) so a
  // stolen bearer token alone cannot mutate credentials. See `requireRecentStepUpPreHandler`.
  return {
    access_token: jsonWebToken,
    session_public_id: session.public_id,
    session_refresh_secret: session.refresh_secret,
  };
}
