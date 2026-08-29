import { ForbiddenError } from '@/shared/errors/index.js';
import { assertUserAccountActive } from '@/shared/utils/auth/account-status.util.js';
import { isDisposableEmailBlocked } from '@/shared/utils/text/email.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { withTransaction } from '@/infrastructure/database/transaction.js';
import {
  runWithPinnedDatabaseHandle,
  type RequestScopedPostgresDatabase,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import type { MfaService } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa.service.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import { AUTH_METHOD_TYPE } from '@/domains/auth/sub-domains/auth-method/auth-method.constants.js';
import {
  completeFirstFactorAuth,
  type FirstFactorAuthResult,
} from '@/domains/auth/shared/complete-first-factor-auth.js';
import { env } from '@/shared/config/env.config.js';
import { ensurePersonalOrganization } from '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js';
import type { OAuthProfile, OAuthProvider } from './oauth.types.js';
import type { UserAuthRecord } from '@/domains/user/user.types.js';

/** Account-takeover guard + bare-placeholder claim for an OAuth find-or-link into a PRE-EXISTING account. Refuses to silently merge into an account whose email is unverified — throwing `ForbiddenError('errors:oauthLinkRequiresVerifiedAccount')` — UNLESS this OAuth identity is already linked, the account's email is already verified, or the account is a bare invited placeholder (no password, no login-capable method, and no WebAuthn passkey), which has no credential or data to take over and whose email the provider has now proven. A claimed bare placeholder has its email flipped to verified (parity with a fresh OAuth signup, and so the claimer can accept their organization invite). Returns the (possibly re-read) user row and whether a bare placeholder was claimed. Extracted from {@link completeOAuthUserSession} to keep that function under the cognitive-complexity budget. */
async function resolveExistingOAuthAccount(parameters: {
  authMethodService: AuthMethodService;
  userService: UserService;
  existingUser: UserAuthRecord;
  provider: OAuthProvider;
  profile: OAuthProfile;
}): Promise<{ user: UserAuthRecord; claimedBareAccount: boolean }> {
  const { authMethodService, userService, provider, profile } = parameters;
  let resolvedUser = parameters.existingUser;

  const existingProviderMethod = await authMethodService.findByProviderUserId(
    provider,
    profile.provider_user_id,
  );
  const isOAuthIdentityAlreadyLinked = existingProviderMethod?.user_id === resolvedUser.id;
  // A bare placeholder has NO usable credential of any kind: no password, no login-capable auth
  // method, AND no WebAuthn passkey. Counting passkeys (not just `hasLoginCapableMethod`) means
  // takeover safety does not rely on the implicit "passkey ⇒ verified email" invariant. Check the
  // password first so the credential DB read is skipped when a password already exists.
  const hasUsableCredential =
    Boolean(resolvedUser.password_hash) ||
    (await authMethodService.hasActiveLoginCredential(resolvedUser.public_id));
  const isUnclaimedBareAccount = !hasUsableCredential;
  if (!(isOAuthIdentityAlreadyLinked || resolvedUser.is_email_verified || isUnclaimedBareAccount)) {
    logger.warn({ email: profile.email, provider }, 'oauth.user.link_blocked_unverified_account');
    throw new ForbiddenError('errors:oauthLinkRequiresVerifiedAccount');
  }

  // Claiming a bare invited placeholder: the provider verified the email, so mark it verified.
  let claimedBareAccount = false;
  if (isUnclaimedBareAccount && !resolvedUser.is_email_verified) {
    const verified = await userService.updateEmailVerified(resolvedUser.public_id);
    if (verified) resolvedUser = verified;
    claimedBareAccount = true;
  }

  return { user: resolvedUser, claimedBareAccount };
}

/** Final stage of an OAuth callback: finds-or-creates the user and idempotently links the OAuth provider (via {@link AuthMethodService.linkOAuthProviderIfMissing}) inside one {@link withTransaction} pinned through {@link runWithPinnedDatabaseHandle}, so a failed auth-method insert (e.g. the `method_type` CHECK) rolls back the freshly created user instead of leaving a verified orphan. AFTER that transaction commits, a first-time signup — or a freshly-claimed bare invited placeholder — best-effort provisions the personal organization — it runs in a separate global-admin connection that cannot see an uncommitted user, so it must run post-commit — then mints an access token + persisted session via {@link completeFirstFactorAuth} so the issued token carries the personal-organization claim. Inserts use {@link AUTH_METHOD_TYPE.OAUTH} to match the database CHECK constraint. Rejects disposable emails for first-time signups. Refuses to silently find-or-link into a pre-existing account whose email is not verified, throwing `ForbiddenError` to prevent account takeover — EXCEPT when this OAuth identity is already linked, or the account is a bare invited placeholder (no password, no login-capable method, and no WebAuthn passkey), which has no credential or data to take over and whose email the provider has now proven; that placeholder is claimed (its email flipped to verified). Rejects suspended/locked accounts with `UnauthorizedError('errors:accountNotActive')` before issuing a session. */
export async function completeOAuthUserSession(parameters: {
  userService: UserService;
  authMethodService: AuthMethodService;
  authSessionService: AuthSessionService;
  organizationSettingsService: OrganizationSettingsService;
  mfaService: MfaService;
  provider: OAuthProvider;
  profile: OAuthProfile;
  ipAddress: string;
  userAgent?: string;
}): Promise<FirstFactorAuthResult & { user: UserAuthRecord }> {
  const {
    userService,
    authMethodService,
    authSessionService,
    organizationSettingsService,
    mfaService,
    provider,
    profile,
  } = parameters;

  // route-audit: normalize the provider email (case-insensitive mailbox) the SAME way every other
  // entry point does (login/magic-link/forgot all use trimmedEmail → lowercase). Without this, OAuth
  // find-or-create exact-matched the raw mixed-case email against the case-sensitive
  // `idx_users_email_unique`, so `Victim@x.com` FORKED a second account instead of matching the
  // existing `victim@x.com` — duplicating identity and sidestepping the link-into-verified guard.
  const normalizedEmail = profile.email.trim().toLowerCase();

  // Find-or-create the user and link the OAuth credential in ONE transaction (pinned in ALS so every
  // repository call shares the checkout), so a failed auth-method link rolls the freshly created user
  // back instead of leaving a verified orphan. Provisioning + session minting run AFTER the commit
  // (below) — they cannot run correctly inside this transaction.
  const { user, isNewUser, claimedBareAccount } = await withTransaction((transaction) =>
    runWithPinnedDatabaseHandle(transaction as RequestScopedPostgresDatabase, async () => {
      let resolvedUser = await userService.findByEmail(normalizedEmail);
      let createdNow = false;
      let claimedBare = false;
      if (!resolvedUser) {
        if (isDisposableEmailBlocked(normalizedEmail)) {
          throw new ForbiddenError('errors:disposableEmail').withReason('disposable_email');
        }
        const nameParts = profile.name?.split(' ') ?? [];
        resolvedUser = await userService.createFromOAuth(
          omitUndefined({
            email: normalizedEmail,
            first_name: nameParts[0],
            last_name: nameParts.slice(1).join(' ') || undefined,
            avatar_url: profile.avatar_url,
            is_email_verified: true,
          }),
        );
        createdNow = true;
        logger.info({ email: normalizedEmail, provider }, 'oauth.user.created');
      } else {
        // Pre-existing account: enforce the takeover guard and, for a bare invited placeholder, claim
        // it (verify its email). Extracted to keep this function under the complexity budget.
        const resolved = await resolveExistingOAuthAccount({
          authMethodService,
          userService,
          existingUser: resolvedUser,
          provider,
          profile,
        });
        resolvedUser = resolved.user;
        claimedBare = resolved.claimedBareAccount;
      }

      await authMethodService.linkOAuthProviderIfMissing({
        ownerPublicId: resolvedUser.public_id,
        data: {
          user_id: resolvedUser.id,
          method_type: AUTH_METHOD_TYPE.OAUTH,
          provider,
          provider_user_id: profile.provider_user_id,
          is_primary: false,
          created_by_user_id: resolvedUser.id,
        },
      });

      // A pre-existing account may have been suspended/locked/soft-deleted since signup; never mint a
      // session for it via the OAuth callback. Passing the row (not just `status`) also rejects
      // soft-deleted users (sec-U1 defense in depth).
      assertUserAccountActive({
        status: resolvedUser.status,
        deleted_at: resolvedUser.deleted_at,
      });

      return {
        user: resolvedUser,
        isNewUser: createdNow,
        claimedBareAccount: claimedBare,
      };
    }),
  );

  // Account-level personal organization for a first-time onboard — a brand-new OAuth user OR a
  // freshly-claimed bare invited placeholder (which `findOrCreateInvitedByEmail` created without one,
  // so the claimer would otherwise have no personal organization). Provisioned AFTER the user commits: it runs
  // in a SEPARATE global-admin transaction (its own pool connection) which cannot see an uncommitted
  // user, so doing it inside the transaction above always FK-failed and was silently swallowed;
  // post-commit it succeeds. Best-effort + idempotent (the partial unique index makes a retry a no-op
  // and tool:backfill-personal-organizations recovers a miss). Team-only mode skips it.
  if ((isNewUser || claimedBareAccount) && env.PERSONAL_ORGANIZATION_ENABLED) {
    try {
      await ensurePersonalOrganization(user.id);
      logger.info({ userId: user.public_id, provider }, 'oauth.user.personal_org_provisioned');
    } catch (error) {
      logger.error(
        { err: error, userId: user.public_id },
        'oauth.user.personal_org_provision_failed',
      );
    }
  }

  // Mint the session AFTER provisioning so the access token carries the personal-organization claim. Like
  // login, completeFirstFactorAuth runs on the request handle (no pinned transaction needed).
  const authResult = await completeFirstFactorAuth({
    user: {
      id: user.id,
      public_id: user.public_id,
      email: user.email,
      status: user.status,
      is_email_verified: user.is_email_verified,
      is_mfa_enabled: user.is_mfa_enabled,
    },
    ipAddress: parameters.ipAddress,
    userAgent: parameters.userAgent,
    organizationSettingsService,
    mfaService,
    authSessionService,
  });

  return { ...authResult, user };
}
