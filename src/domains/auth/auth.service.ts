import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/shared/errors/index.js';
import { assertUserAccountActive } from '@/shared/utils/auth/account-status.util.js';
import { isDisposableEmailBlocked } from '@/shared/utils/text/email.util.js';
import { resolveAccessTokenRoleForUser } from '@/shared/utils/auth/global-admin-role.util.js';
import { signAccessToken } from '@/shared/utils/security/jwt.util.js';
import { DUMMY_ARGON2_HASH, verifyPassword } from '@/shared/utils/security/password.util.js';
import { enforceMinimumDuration } from '@/shared/utils/security/anti-enumeration.util.js';
import {
  ACCOUNT_LOCKOUT_MINUTES,
  IP_FAILED_LOGIN_THRESHOLD,
  IP_FAILED_LOGIN_WINDOW_SECONDS,
  MAX_FAILED_LOGIN_ATTEMPTS,
} from '@/shared/constants/index.js';
import { captureMessage } from '@/infrastructure/observability/sentry/sentry.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { incrementWithExpiryOnFirst } from '@/shared/utils/infrastructure/redis-counter.util.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import type { AuthSessionService } from './sub-domains/auth-session/auth-session.service.js';
import type { MfaService } from './sub-domains/auth-mfa/auth-mfa.service.js';
import type { AuthMethodService } from './sub-domains/auth-method/auth-method.service.js';
import { validateLogin } from './auth.validator.js';
import { completeFirstFactorAuth } from './shared/complete-first-factor-auth.js';
import {
  resolveDefaultActiveOrganizationPublicId,
  findUserActiveOrganizationByPublicId,
  findUserActiveOrganizationPublicIdByInternalId,
  ensurePersonalOrganization,
} from '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js';
import type { UserAuthRecord } from '@/domains/user/user.types.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

const IP_FAILED_LOGIN_KEY_PREFIX = 'auth:failed_login:ip:';

/**
 * Discriminated result of {@link AuthService.login}: either a fresh access token + session
 * public id, or an `mfa_required` envelope carrying a short-lived session token used by
 * the MFA login verify step.
 *
 * @remarks
 * - **Algorithm:** the password branch returns `{ access_token, session_public_id }`;
 *   when MFA is required by user opt-in or organization policy, the password is consumed
 *   without issuing a JWT and a Redis-backed MFA session token is returned instead.
 * - **Failure modes:** consumers should disambiguate via the `mfa_required` field before
 *   reading either union arm.
 * - **Side effects:** none — purely the result shape.
 * - **Notes:** the session is created server-side; clients use the session cookie for refresh.
 */
export type LoginResult =
  | {
      access_token: string;
      session_public_id: string;
      session_refresh_secret: string;
    }
  | { mfa_required: true; mfa_session_token: string };

/**
 * Password-login orchestrator for the auth domain.
 *
 * @remarks
 * - **Algorithm:** lookup user by email, verify password (argon2 with optional rehash),
 *   then either issue a JWT + persisted session or return an `mfa_required` token when MFA
 *   is enabled on the user or required by org policy via
 *   {@link OrganizationSettingsService.userHasOrganizationRequiringMfa}. The account-lockout
 *   window is checked *after* password verification so a correct credential always bypasses
 *   it — the lock only rejects further failed attempts, preventing a victim-account DoS.
 * - **Failure modes:** disposable-email check throws `ValidationError`; bad password,
 *   missing user, locked account, expired session, inactive user all throw
 *   `UnauthorizedError` with i18n keys (`errors:invalidEmailOrPassword`,
 *   `errors:accountLocked`, `errors:invalidOrExpiredSession`, `errors:accountNotActive`).
 * - **Side effects:** increments / clears `users.failed_login_count` and sets
 *   `account_locked_until` after {@link MAX_FAILED_LOGIN_ATTEMPTS} failures; rehashes the
 *   stored password when argon2 parameters drift; creates and rotates rows in
 *   `auth.sessions` via {@link AuthSessionService}.
 * - **Notes:** access tokens are signed RS256 with a SHA-256 hash persisted on the
 *   session row (refresh uses the session, not the JWT, as the source of truth).
 */
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly authSessionService: AuthSessionService,
    private readonly mfaService: MfaService,
    private readonly organizationSettingsService: OrganizationSettingsService,
    private readonly redis: Redis,
    private readonly authMethodService: AuthMethodService,
  ) {}

  private buildIpKey(ipAddress: string): string {
    return `${IP_FAILED_LOGIN_KEY_PREFIX}${createHash('sha256').update(ipAddress).digest('hex')}`;
  }

  private async checkIpLoginLimit(ipAddress: string): Promise<void> {
    try {
      const raw = await this.redis.get(this.buildIpKey(ipAddress));
      if (raw !== null && Number(raw) >= IP_FAILED_LOGIN_THRESHOLD) {
        throw new UnauthorizedError('errors:rateLimited');
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      // Redis unavailable — fail open; per-user lockout and rate-limit middleware still protect.
      logger.warn({ error }, 'auth.ip_limit.check.failed');
    }
  }

  private async recordIpFailedLogin(ipAddress: string): Promise<void> {
    try {
      const key = this.buildIpKey(ipAddress);
      // Atomic INCR + first-increment EXPIRE (route-audit C5) — a crash between a separate INCR and
      // EXPIRE would otherwise leave a no-TTL counter that throttles the IP indefinitely.
      const count = await incrementWithExpiryOnFirst(
        this.redis,
        key,
        IP_FAILED_LOGIN_WINDOW_SECONDS,
      );
      if (count === IP_FAILED_LOGIN_THRESHOLD) {
        captureMessage('auth.ip_failed_login.threshold_reached', {
          level: 'warning',
          extra: { ip_hash: this.buildIpKey(ipAddress), count },
        });
        logger.warn(
          { ip_hash: this.buildIpKey(ipAddress), count },
          'auth.ip_failed_login.threshold_reached',
        );
      }
    } catch (error) {
      logger.warn({ error }, 'auth.ip_limit.record.failed');
    }
  }

  async login(body: unknown, ipAddress: string, userAgent?: string): Promise<LoginResult> {
    const parsed = validateLogin(body);
    if (isDisposableEmailBlocked(parsed.email)) {
      throw new ValidationError('errors:disposableEmail', undefined, undefined, [
        { field: 'email', messageKey: 'errors:disposableEmail' },
      ]).withReason('disposable_email');
    }

    // Reject before expensive argon2 work when this IP has exceeded its failure budget.
    // Fail open on Redis errors so a Redis outage never locks out legitimate users.
    await this.checkIpLoginLimit(ipAddress);

    // audit-#15d: floor every failure branch to a common minimum duration. argon2 is
    // equalized between unknown-email and wrong-password, but the wrong-password branch
    // additionally performs a Postgres write (registerFailedLoginAttempt) that the
    // unknown-email branch lacks — a residual timing oracle the other anti-enumeration
    // endpoints (magic-link, forgot-password) already mask. Measure from before the
    // branch divergence (the user lookup) so both paths share the same floor.
    const startedAtMillis = Date.now();

    const user = await this.userService.findByEmail(parsed.email);
    if (!user?.password_hash) {
      // Run a verification against a fixed dummy hash and discard the result so
      // the "unknown email" path takes the same ~argon2 time as a wrong password,
      // preventing user enumeration via response timing.
      await verifyPassword(parsed.password, DUMMY_ARGON2_HASH);
      await this.recordIpFailedLogin(ipAddress);
      await enforceMinimumDuration(startedAtMillis);
      throw new UnauthorizedError('errors:invalidEmailOrPassword');
    }

    // Lockout is verified AFTER the password so that a correct credential always bypasses it.
    // Keying the hard lockout purely on the account makes it a victim-DoS vector: anyone who
    // knows the email could submit wrong passwords to lock the real owner out. Online brute
    // force is already bounded by the per-IP + per-email rate limits and CAPTCHA on /login, so
    // the lockout's job is narrowed to throttling *failed* attempts, never denying the owner.
    const isLockedOut = Boolean(
      user.account_locked_until && new Date(user.account_locked_until) > new Date(),
    );

    const { valid: isValid, needsRehash } = await verifyPassword(
      parsed.password,
      user.password_hash,
    );

    if (!isValid) {
      // Atomic SQL increment + conditional lock — never a read-modify-write — so two
      // simultaneous wrong-password attempts cannot both read the same stale count and
      // collapse two failures into one, which would let an attacker undercount toward lockout.
      await this.userService.registerFailedLoginAttempt(user.public_id, {
        maxAttempts: MAX_FAILED_LOGIN_ATTEMPTS,
        lockoutMinutes: ACCOUNT_LOCKOUT_MINUTES,
      });
      await this.recordIpFailedLogin(ipAddress);
      // sec-A finding #23: surface a UNIFORM error message for unknown-email, wrong-
      // password, and currently-locked-out wrong-password. The prior code returned
      // `errors:accountLocked` only when the email was real AND inside the lockout
      // window AND the password was wrong — a narrow enumeration oracle that a
      // credential-stuffing operator could use to confirm "this account has recently
      // received >= MAX_FAILED_LOGIN_ATTEMPTS failed logins". The lockout itself is
      // still observable server-side via the structured log below for ops/security
      // dashboards; the client sees the same response regardless of state.
      if (isLockedOut) {
        logger.info({ user_public_id: user.public_id }, 'auth.login.attempt_during_lockout');
      }
      // audit-#15d: same floor as the unknown-email branch so the extra Postgres write
      // above is not observable as a latency difference.
      await enforceMinimumDuration(startedAtMillis);
      throw new UnauthorizedError('errors:invalidEmailOrPassword');
    }

    // First factor verified — refuse to issue (or escalate to MFA for) a session
    // for a suspended/locked/deleted account before any token is minted. Passing the row
    // (not just `status`) also rejects soft-deleted users (sec-U1 defense in depth).
    assertUserAccountActive({
      status: user.status,
      deleted_at: user.deleted_at,
    });

    // Correct password clears the failure counter and lifts any active lock so the owner is
    // never held out by attacker-driven failed attempts.
    if ((user.failed_login_count ?? 0) > 0 || isLockedOut) {
      await this.userService.updateLoginAttempt(user.public_id, 0, null);
    }

    if (needsRehash) {
      const { hashPassword } = await import('@/shared/utils/security/password.util.js');
      const newHash = await hashPassword(parsed.password);
      await this.userService.updatePassword(user.public_id, newHash);
    }

    return completeFirstFactorAuth({
      user: {
        id: user.id,
        public_id: user.public_id,
        email: user.email,
        status: user.status,
        is_email_verified: user.is_email_verified,
        is_mfa_enabled: user.is_mfa_enabled,
      },
      ipAddress,
      userAgent,
      organizationSettingsService: this.organizationSettingsService,
      mfaService: this.mfaService,
      authSessionService: this.authSessionService,
      // Non-pinned path: self-heal a missing personal org into the token (item #5).
      ensurePersonalOrganizationOnMiss: true,
    });
  }

  /**
   * Completes `POST /auth/password/reset` and logs the user straight back in.
   *
   * @remarks
   * - **Algorithm:** delegate the token-consume + password-update + revoke-all-sessions to
   *   {@link AuthMethodService.resetPassword} (one pinned transaction), then mint a fresh session via
   *   {@link completeFirstFactorAuth} AFTER that commits — so the resetter's new session is the only
   *   live one, while any attacker-held session from before the reset is gone.
   * - **Failure modes:** invalid/expired token → `UnauthorizedError` (from the delegate); a
   *   suspended/locked/deleted account is refused a session via {@link assertUserAccountActive} even
   *   though its password was reset (mirrors `login`); an MFA user gets the `mfa_required` arm of
   *   {@link LoginResult} (the reset never bypasses MFA).
   * - **Side effects:** the delegate's writes (password, token invalidation, session revoke) plus one
   *   new `auth_sessions` row (unless MFA is required). The caller sets the session cookie + audits.
   */
  async resetPassword(body: unknown, ipAddress: string, userAgent?: string): Promise<LoginResult> {
    const user = await this.authMethodService.resetPassword(body);
    // The password was reset, but a suspended/locked/deleted account is never issued a session.
    assertUserAccountActive({
      status: user.status,
      deleted_at: user.deleted_at,
    });
    return completeFirstFactorAuth({
      user: {
        id: user.id,
        public_id: user.public_id,
        email: user.email,
        status: user.status,
        is_email_verified: user.is_email_verified,
        is_mfa_enabled: user.is_mfa_enabled,
      },
      ipAddress,
      userAgent,
      organizationSettingsService: this.organizationSettingsService,
      mfaService: this.mfaService,
      authSessionService: this.authSessionService,
      // Non-pinned path: self-heal a missing personal org into the token (item #5).
      ensurePersonalOrganizationOnMiss: true,
    });
  }

  async logout(token: string): Promise<void> {
    await this.authSessionService.revokeSessionByAccessToken(token);
  }

  async refreshToken({
    sessionPublicId,
    refreshSecret,
  }: {
    sessionPublicId: string;
    refreshSecret: string;
  }): Promise<{ access_token: string; refresh_secret: string }> {
    // sec-re-05: look the session up via the INCLUDING-REVOKED path so a
    // refresh-secret replay against an already-revoked session reaches
    // `refreshSessionCredentials`'s reuse-detection block (the sec-A #9
    // `findByPublicIdIncludingRevoked` lookup). The prior
    // `findActiveSessionByPublicId` filtered `is_revoked = true` rows out
    // here and threw `errors:invalidOrExpiredSession` before the rotation
    // ran — silently disabling the Sentry `auth.refresh_token.reuse_detected`
    // signal exactly when it is most informative. Revoked sessions still
    // fail to refresh because `refreshSessionCredentials`'s rotation UPDATE
    // filters `is_revoked = false` internally and throws after firing the
    // reuse-detection block.
    const session =
      await this.authSessionService.findSessionByPublicIdIncludingRevoked(sessionPublicId);
    if (!session) {
      throw new UnauthorizedError('errors:invalidOrExpiredSession');
    }

    if (new Date(session.expires_at) <= new Date()) {
      throw new UnauthorizedError('errors:sessionExpired');
    }

    const user = await this.userService.findById(session.user_id);
    if (!user) throw new UnauthorizedError('errors:userNotFound');

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedError('errors:accountNotActive');
    }

    // audit-#3: preserve the organization the caller switched to. The selected org is
    // persisted on the session (`organization_id`) by `rebindAccessToken`; refresh must
    // revalidate it (the user could have lost membership, or the org could have been
    // deleted/suspended) and only fall back to the default when it is no longer valid —
    // never silently move the caller to a different tenant while the UI still shows A.
    const persistedOrganizationPublicId =
      session.organization_id != null
        ? await findUserActiveOrganizationPublicIdByInternalId(user.id, session.organization_id)
        : undefined;
    const organizationPublicId =
      persistedOrganizationPublicId ?? (await resolveDefaultActiveOrganizationPublicId(user.id));

    const jsonWebToken = await signAccessToken({
      userId: user.public_id,
      role: resolveAccessTokenRoleForUser({
        email: user.email,
        status: user.status,
        isEmailVerified: user.is_email_verified,
      }),
      organizationPublicId,
    });

    const rotated = await this.authSessionService.refreshSessionCredentials({
      sessionPublicId,
      refreshSecret,
      nextAccessToken: jsonWebToken,
    });

    return {
      access_token: jsonWebToken,
      refresh_secret: rotated.refresh_secret,
    };
  }

  /**
   * Switch the active organization to a TEAM (or any) organization the caller is an active
   * member of: validate membership, re-mint the access token with the new `org` claim, and
   * re-bind the session to it. Rejects with 403 when the caller is not an active member.
   */
  async switchToOrganization({
    userPublicId,
    sessionPublicId,
    organizationPublicId,
  }: {
    userPublicId: string;
    sessionPublicId: string;
    organizationPublicId: string;
  }): Promise<{ access_token: string; organization_public_id: string }> {
    // Both reads below run under `app.current_user_public_id` set to the SAME value, so they share one
    // context instead of opening a transaction each. `findUserActiveOrganizationByPublicId` takes
    // an INTERNAL id and resolves it back to the public id we already hold — inside the shared
    // context that resolve is a plain query on an open checkout rather than a second BEGIN.
    //
    // `mintForActiveOrganization` stays OUTSIDE deliberately. It re-binds the session under
    // `app.current_session_public_id`, a different guc, so it must own its transaction — and
    // nesting it here would hold this checkout open across it, making the request peak at two
    // concurrent connections instead of taking them one after another.
    const { user, resolved } = await withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      async () => {
        const record = await this.userService.requireUserRecordByPublicId(userPublicId);
        if (record.status !== 'ACTIVE') throw new UnauthorizedError('errors:accountNotActive');
        const organization = await findUserActiveOrganizationByPublicId(
          record.id,
          organizationPublicId,
        );
        if (!organization) throw new ForbiddenError('errors:insufficientOrganizationPermissions');
        return { user: record, resolved: organization };
      },
    );
    return this.mintForActiveOrganization(user, sessionPublicId, resolved);
  }

  /**
   * Switch the active organization to the caller's own PERSONAL organization. No body — the
   * server resolves the personal organization from the authenticated user; it can never 403
   * (you always own your personal organization). 404 only if personal is disabled / missing.
   */
  async switchToPersonal({
    userPublicId,
    sessionPublicId,
  }: {
    userPublicId: string;
    sessionPublicId: string;
  }): Promise<{ access_token: string; organization_public_id: string }> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (user.status !== 'ACTIVE') throw new UnauthorizedError('errors:accountNotActive');
    // Self-heal: provision the personal org on demand when personal is enabled but missing,
    // so this can no longer 404 for a personal-enabled deployment. Returns undefined only when
    // personal organizations are disabled → 404 as before.
    const personal = await ensurePersonalOrganization(user.id);
    if (!personal) throw new NotFoundError('Personal organization');
    return this.mintForActiveOrganization(user, sessionPublicId, personal);
  }

  /**
   * Mint an access token scoped to the given organization and re-bind the session
   * to it, persisting the active organization's internal id on the session so a
   * later `/auth/refresh` preserves the selection (audit-#3).
   */
  private async mintForActiveOrganization(
    user: UserAuthRecord,
    sessionPublicId: string,
    organization: { id: number; public_id: string },
  ): Promise<{ access_token: string; organization_public_id: string }> {
    const jsonWebToken = await signAccessToken({
      userId: user.public_id,
      role: resolveAccessTokenRoleForUser({
        email: user.email,
        status: user.status,
        isEmailVerified: user.is_email_verified,
      }),
      organizationPublicId: organization.public_id,
    });
    await this.authSessionService.rebindAccessToken({
      sessionPublicId,
      nextAccessToken: jsonWebToken,
      activeOrganizationId: organization.id,
    });
    return {
      access_token: jsonWebToken,
      organization_public_id: organization.public_id,
    };
  }
}
