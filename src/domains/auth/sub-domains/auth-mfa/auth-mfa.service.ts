import { generateSecret, generateURI, verify } from 'otplib';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import {
  decryptFieldSecret,
  encryptFieldSecret,
} from '@/shared/utils/security/field-secret-encryption.util.js';
import { ForbiddenError, UnauthorizedError } from '@/shared/errors/index.js';
import {
  assertEmailVerifiedForCredentialEnrollment,
  assertUserAccountActive,
} from '@/shared/utils/auth/account-status.util.js';
import { resolveAccessTokenRoleForUser } from '@/shared/utils/auth/global-admin-role.util.js';
import { env } from '@/shared/config/env.config.js';
import { signAccessToken } from '@/shared/utils/security/jwt.util.js';
import { resolveDefaultActiveOrganizationPublicId } from '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import {
  MAX_MFA_VERIFICATION_ATTEMPTS,
  MILLISECONDS_PER_DAY,
  MFA_RECOVERY_CODE_COUNT,
  MFA_TOTP_CODE_REPLAY_TTL_SECONDS,
  MFA_TOTP_ENROLLMENT_STAGE_TTL_SECONDS,
  MFA_TOTP_TOLERANCE_STEPS,
  MFA_VERIFICATION_LOCKOUT_TTL_SECONDS,
  TOTP_STEP_SECONDS,
} from '@/shared/constants/index.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { incrementWithExpiryOnFirst } from '@/shared/utils/infrastructure/redis-counter.util.js';
import { TOTP_ISSUER } from '@/shared/constants/project-identity.constants.js';
import {
  validateMfaVerify,
  validateMfaEnroll,
  validateMfaEnrollConfirm,
  validateMfaLoginVerify,
} from '@/domains/auth/auth.validator.js';
import {
  createMfaSession,
  verifyMfaSession,
} from '@/domains/auth/sub-domains/auth-mfa-session/auth-mfa-session.js';
import {
  consumeMfaRecoveryCode,
  hashMfaRecoveryCode,
  insertMfaRecoveryCodes,
  invalidateAllUnusedRecoveryCodesForUser,
} from './auth-mfa-recovery-code.repository.js';
import { generateMfaRecoveryCodes } from './auth-mfa-recovery-code.util.js';
import { withPrincipalDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';
import { resolveVerifiedUserPrincipalScope } from '@/shared/utils/identity/verified-principal-scope.util.js';

const ERROR_KEY_MFA_USER_NOT_FOUND = 'errors:mfaUserNotFound';
const ERROR_KEY_MFA_INVALID_OR_EXPIRED_CODE = 'errors:mfaInvalidOrExpiredCode';

/** Redis key prefix marking a TOTP code consumed by a user, used to reject replay within its validity window. */
const MFA_TOTP_CONSUMED_KEY_PREFIX = 'mfa:totp:consumed:';

/** Redis key prefix for the per-user failed-MFA-verification counter (audit-#12 lockout). */
const MFA_VERIFICATION_FAILURE_KEY_PREFIX = 'mfa:verify:fail:';

/**
 * Redis key prefix for the staged TOTP enrollment secret keyed by user public id
 * (sec-A finding #3 — two-phase enrollment). The encrypted secret lives here until
 * `enrollConfirm` consumes it atomically via `GETDEL`.
 */
const MFA_TOTP_ENROLLMENT_STAGE_KEY_PREFIX = 'mfa:enroll:';

/**
 * TOTP-based MFA and recovery-code orchestrator for the auth domain.
 *
 * @remarks
 * - **Algorithm:** enrollment generates an otplib secret, encrypts it via
 *   {@link encryptFieldSecret}, and persists it as an `MFA_TOTP` row in
 *   {@link auth_methods}. Login uses a Redis-backed MFA session
 *   ({@link createMfaSession} / {@link verifyMfaSession}); the verify step accepts
 *   either a TOTP code or a single-use recovery code consumed atomically by
 *   {@link consumeMfaRecoveryCode}.
 * - **Failure modes:** unknown user / wrong code / expired MFA session all throw
 *   `UnauthorizedError` with i18n keys (`errors:mfaInvalidOrExpiredCode`,
 *   `errors:mfaInvalidOrExpiredSession`, `errors:mfaUserNotFound`,
 *   `errors:mfaInvalidOrExpiredRecoveryCode`). A suspended/locked account is
 *   rejected on the login-verify step with `errors:accountNotActive`.
 * - **Side effects:** writes to {@link auth_methods}, {@link mfa_recovery_codes},
 *   and `auth.sessions`; flips `users.is_mfa_enabled` on enroll and on the last
 *   method removal; refreshes `auth_methods.last_used_at` on every successful
 *   verification; records each consumed TOTP code in Redis for
 *   {@link MFA_TOTP_CODE_REPLAY_TTL_SECONDS} to reject replay.
 * - **Notes:** secrets are encrypted at rest using the field-secret KMS path;
 *   recovery codes are stored only as SHA-256 hashes and consumed exactly once
 *   via an atomic `UPDATE … WHERE used_at IS NULL`. The public login step is
 *   reachable only with a valid `mfa_session_token` minted by `auth.login`
 *   after first-factor (password) verification — there is no TOTP-only login.
 */
export class MfaService {
  constructor(
    private readonly userService: UserService,
    private readonly authMethodService: AuthMethodService,
    private readonly authSessionService: AuthSessionService,
    private readonly redis: Redis,
    private readonly organizationSettingsService?: OrganizationSettingsService,
  ) {}

  async createMfaSession(userPublicId: string): Promise<string> {
    return createMfaSession(this.redis, userPublicId);
  }

  async verifyMfaSession(mfaSessionToken: string): Promise<{ user_public_id: string }> {
    return verifyMfaSession(this.redis, mfaSessionToken);
  }

  /** Public login step: verify TOTP or recovery code, then issue JWT + session. */
  async verifyLoginMfa(
    body: unknown,
    ipAddress: string,
    userAgent?: string,
  ): Promise<{
    access_token: string;
    session_public_id: string;
    session_refresh_secret: string;
    factor: 'totp' | 'recovery_code';
  }> {
    const parsed = validateMfaLoginVerify(body);
    const session = await verifyMfaSession(this.redis, parsed.mfa_session_token);
    const user = await this.userService.requireUserRecordByPublicId(session.user_public_id);
    if (!user) {
      throw new UnauthorizedError(ERROR_KEY_MFA_USER_NOT_FOUND);
    }
    // sec-U1: also rejects soft-deleted users.
    assertUserAccountActive({ status: user.status, deleted_at: user.deleted_at });

    let verified = false;
    let factor: 'totp' | 'recovery_code' = 'totp';
    if (parsed.totp_code) {
      // audit-#12 / reaudit-#3: the brute-force lockout gates ONLY the TOTP path (6-digit,
      // guessable). Recovery codes are single-use high-entropy break-glass and are
      // intentionally NOT subject to it — otherwise an attacker who knows the password could
      // burn TOTP attempts to also lock the victim out of their recovery path (victim DoS).
      // route-audit-#4: atomically count this attempt up-front so concurrent guesses can't
      // overspend the budget; a successful verify clears the counter below.
      await this.consumeMfaVerificationAttempt(user.id);
      // auth.auth_methods is FORCE RLS (audit #7); pin the owner context for every credential
      // read/write — the MFA session already authenticated this user.
      const totpMethod = await withPrincipalDatabaseContext(
        resolveVerifiedUserPrincipalScope(user.public_id),
        () => this.authMethodService.findTotpByUserId(user.id),
      );
      if (!totpMethod?.encrypted_secret) {
        throw new UnauthorizedError('errors:mfaNotEnabled');
      }
      const result = await verify({
        secret: decryptFieldSecret(totpMethod.encrypted_secret),
        token: parsed.totp_code,
        epochTolerance: MFA_TOTP_TOLERANCE_STEPS * TOTP_STEP_SECONDS,
      });
      if (!result.valid) {
        // The attempt was already counted in consumeMfaVerificationAttempt above (route-audit-#4).
        throw new UnauthorizedError(ERROR_KEY_MFA_INVALID_OR_EXPIRED_CODE);
      }
      await this.rejectReplayedTotpCode(user.id, parsed.totp_code);
      await withPrincipalDatabaseContext(resolveVerifiedUserPrincipalScope(user.public_id), () =>
        this.authMethodService.updateAuthMethodLastUsedAt(totpMethod.id, user.id),
      );
      verified = true;
    } else if (parsed.recovery_code) {
      // auth.mfa_recovery_codes is FORCE RLS keyed on app.current_user_public_id; the MFA session already
      // identifies the user, so consume the single-use code inside that user's context.
      const recoveryCode = parsed.recovery_code;
      const consumed = await withPrincipalDatabaseContext(
        resolveVerifiedUserPrincipalScope(user.public_id),
        () => consumeMfaRecoveryCode(user.id, recoveryCode),
      );
      if (!consumed) {
        // reaudit-#3: a wrong recovery code does NOT increment the TOTP lockout counter,
        // so recovery attempts can never lock the user out of TOTP (or vice versa). Recovery
        // codes are bounded by the route rate limit + their own high entropy + single use.
        throw new UnauthorizedError('errors:mfaInvalidOrExpiredRecoveryCode');
      }
      verified = true;
      factor = 'recovery_code';
    }

    if (!verified) {
      throw new UnauthorizedError(ERROR_KEY_MFA_INVALID_OR_EXPIRED_CODE);
    }

    // audit-#12: successful second factor clears the failure counter.
    await this.clearMfaVerificationFailures(user.id);
    const issued = await this.issueAccessTokenAndSession(user, ipAddress, userAgent);
    // Surface the factor so the handler can audit recovery-code use (the TOTP-bypass break-glass
    // path) distinctly from a normal TOTP second factor.
    return { ...issued, factor };
  }

  /**
   * Marks a freshly-verified TOTP code as consumed in Redis and rejects it if it
   * was already used. `SET NX` makes the check-and-set atomic so two concurrent
   * requests carrying the same valid code cannot both succeed; a replay surfaces
   * as the generic invalid-code error to avoid leaking that the code was valid.
   */
  private async rejectReplayedTotpCode(userId: number, totpCode: string): Promise<void> {
    const codeHash = createHash('sha256').update(totpCode).digest('hex');
    const key = `${MFA_TOTP_CONSUMED_KEY_PREFIX}${userId}:${codeHash}`;
    const stored = await this.redis.set(key, '1', 'EX', MFA_TOTP_CODE_REPLAY_TTL_SECONDS, 'NX');
    if (stored === null) {
      throw new UnauthorizedError(ERROR_KEY_MFA_INVALID_OR_EXPIRED_CODE);
    }
  }

  /**
   * Atomically registers one MFA verification attempt and rejects once the per-user budget of
   * {@link MAX_MFA_VERIFICATION_ATTEMPTS} is exhausted (audit-#12 + route-audit-#4).
   *
   * @remarks
   * Closes the brute-force gap on `/auth/me/mfa/verify` + `/auth/mfa/login`, which had only a rate
   * limit and no account-level lockout. route-audit-#4: the previous design did a read-only GET
   * check BEFORE verifying the code and INCR'd the counter separately on failure, so N concurrent
   * wrong codes all passed the gate before any increment landed — a burst could spend far more
   * than the budget in one window. Now the `INCR` happens atomically UP FRONT and its returned
   * value gates the attempt, so concurrent requests get distinct counts and everything past the
   * budget is rejected. A successful verification clears the counter (see
   * {@link clearMfaVerificationFailures}), so legitimate retries never lock out. The response
   * stays the generic invalid-code error so the lockout is not an oracle; the lockout is logged.
   */
  private async consumeMfaVerificationAttempt(userId: number): Promise<void> {
    const key = `${MFA_VERIFICATION_FAILURE_KEY_PREFIX}${userId}`;
    // Atomic INCR + first-increment EXPIRE (route-audit C5) — a crash between a separate INCR and
    // EXPIRE would otherwise leave a no-TTL counter that locks the user out indefinitely.
    const count = await incrementWithExpiryOnFirst(
      this.redis,
      key,
      MFA_VERIFICATION_LOCKOUT_TTL_SECONDS,
    );
    if (count > MAX_MFA_VERIFICATION_ATTEMPTS) {
      logger.warn({ userId }, 'auth.mfa.verification_locked_out');
      throw new UnauthorizedError(ERROR_KEY_MFA_INVALID_OR_EXPIRED_CODE);
    }
  }

  /** Clears the per-user verification-attempt counter after a successful verification. */
  private async clearMfaVerificationFailures(userId: number): Promise<void> {
    await this.redis.del(`${MFA_VERIFICATION_FAILURE_KEY_PREFIX}${userId}`);
  }

  private async issueAccessTokenAndSession(
    user: {
      id: number;
      public_id: string;
      email: string;
      status: string;
      is_email_verified: boolean;
    },
    ipAddress: string,
    userAgent?: string,
  ): Promise<{ access_token: string; session_public_id: string; session_refresh_secret: string }> {
    // Bake the active-organization `org` claim into the token, mirroring the first-factor path
    // (`complete-first-factor-auth.ts`). Without this an MFA login mints an org-less token and the
    // user is locked out of every org-scoped route (which resolve the active org from the claim
    // post-flatten) until they call a switch endpoint — a regression that hit MFA-enforcing tenants.
    const organizationPublicId = await resolveDefaultActiveOrganizationPublicId(user.id);
    const jsonWebToken = await signAccessToken({
      userId: user.public_id,
      role: resolveAccessTokenRoleForUser({
        email: user.email,
        status: user.status,
        isEmailVerified: user.is_email_verified,
      }),
      organizationPublicId,
    });
    const tokenHash = createHash('sha256').update(jsonWebToken).digest('hex');
    const sessionMaxAgeDays = env.AUTH_SESSION_MAX_AGE_DAYS;
    const expiresAt = new Date(Date.now() + sessionMaxAgeDays * MILLISECONDS_PER_DAY);
    const authSession = await this.authSessionService.createSessionForUser(
      user.public_id,
      omitUndefined({
        token_hash: tokenHash,
        ip_address: ipAddress,
        user_agent: userAgent,
        expires_at: expiresAt,
      }),
    );
    return {
      access_token: jsonWebToken,
      session_public_id: authSession.public_id,
      session_refresh_secret: authSession.refresh_secret,
    };
  }

  /** Verify TOTP code for the current user. Requires authenticated request (user public_id). */
  async verify(userPublicId: string, body: unknown): Promise<{ verified: boolean }> {
    const parsed = validateMfaVerify(body);
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new UnauthorizedError(ERROR_KEY_MFA_USER_NOT_FOUND);
    // audit-#12 / route-audit-#4: atomically count this attempt up-front and reject once the
    // per-user budget is exhausted — concurrent guesses can no longer overspend it.
    await this.consumeMfaVerificationAttempt(user.id);
    const totpMethod = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(user.public_id),
      () => this.authMethodService.findTotpByUserId(user.id),
    );
    if (!totpMethod?.encrypted_secret) {
      throw new UnauthorizedError('errors:mfaNotEnabled');
    }
    const result = await verify({
      secret: decryptFieldSecret(totpMethod.encrypted_secret),
      token: parsed.code,
      epochTolerance: MFA_TOTP_TOLERANCE_STEPS * TOTP_STEP_SECONDS,
    });
    if (!result.valid) {
      // Already counted in consumeMfaVerificationAttempt above (route-audit-#4).
      throw new UnauthorizedError(ERROR_KEY_MFA_INVALID_OR_EXPIRED_CODE);
    }
    await this.rejectReplayedTotpCode(user.id, parsed.code);
    // audit-#12: successful step-up clears the failure counter.
    await this.clearMfaVerificationFailures(user.id);
    await withPrincipalDatabaseContext(resolveVerifiedUserPrincipalScope(user.public_id), () =>
      this.authMethodService.updateAuthMethodLastUsedAt(totpMethod.id, user.id),
    );
    return { verified: true };
  }

  /**
   * Phase 1 of the two-phase MFA TOTP enrollment ceremony (sec-A finding #3).
   *
   * @remarks
   * Generates a fresh otplib secret, stages it in Redis (encrypted at rest) under a
   * per-user key with `MFA_TOTP_ENROLLMENT_STAGE_TTL_SECONDS`, and returns the
   * plaintext secret + provisioning URI to the caller. **Nothing is written to
   * Postgres** and `is_mfa_enabled` is **NOT** flipped — the user has not yet
   * proved their authenticator can produce a valid code from this secret. The
   * matching `POST /auth/me/mfa/enroll/confirm` request consumes the staged secret,
   * verifies a fresh code, and only then atomically persists the auth_methods row,
   * generates and hashes the recovery codes, and flips `is_mfa_enabled`. Without
   * this proof-of-possession gate, a user who closes the dialog or mis-transcribes
   * the secret can permanently lock themselves out of their account — in an MFA-
   * required organization the lockout is absolute and requires admin SQL bypass.
   *
   * Re-running INIT before CONFIRM overwrites the staged secret (last-write wins),
   * matching natural retry semantics.
   */
  async enrollInit(
    userPublicId: string,
    body: unknown,
  ): Promise<{ secret: string; provisioning_uri: string }> {
    const parsed = validateMfaEnroll(body);
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new UnauthorizedError(ERROR_KEY_MFA_USER_NOT_FOUND);
    // Pre-hijacking guard: an unverified (e.g. attacker-pre-registered) account must not seed an
    // MFA factor that would survive the real owner's password-reset recovery (sec — account
    // pre-hijacking, Trojan-credential variant).
    assertEmailVerifiedForCredentialEnrollment(user);
    if (parsed.method_type !== 'MFA_TOTP') {
      throw new UnauthorizedError('errors:mfaOnlyTotpSupported');
    }
    const secret = generateSecret();
    const provisioningUri = generateURI({
      issuer: TOTP_ISSUER,
      label: user.email,
      secret,
    });
    const stageKey = `${MFA_TOTP_ENROLLMENT_STAGE_KEY_PREFIX}${user.public_id}`;
    await this.redis.set(
      stageKey,
      encryptFieldSecret(secret),
      'EX',
      MFA_TOTP_ENROLLMENT_STAGE_TTL_SECONDS,
    );
    return {
      secret,
      provisioning_uri: provisioningUri,
    };
  }

  /**
   * Phase 2 of the two-phase MFA TOTP enrollment ceremony (sec-A finding #3).
   *
   * @remarks
   * Atomically pops the staged secret from Redis (`GETDEL`), verifies the submitted
   * 6-digit code against it (with the same tolerance window as login-time verify),
   * and on success persists the auth_methods row, generates {@link MFA_RECOVERY_CODE_COUNT}
   * recovery codes, hashes them via SHA-256 and bulk-inserts the hashes, then flips
   * `is_mfa_enabled`. Returns the plaintext recovery codes EXACTLY ONCE — the server
   * never holds them again.
   *
   * Failure modes:
   * - Stage key expired or missing → `errors:mfaEnrollExpired` (user must restart INIT)
   * - Code does not verify → `errors:mfaInvalidOrExpiredCode` (stage was already
   *   GETDEL'd; user must restart INIT, which is acceptable because the secret is
   *   one-time-use and a wrong-code attempt is most often a fat-fingered transcription
   *   that warrants regenerating to be safe)
   */
  async enrollConfirm(
    userPublicId: string,
    body: unknown,
  ): Promise<{ recovery_codes: string[]; method_public_id: string }> {
    const parsed = validateMfaEnrollConfirm(body);
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new UnauthorizedError(ERROR_KEY_MFA_USER_NOT_FOUND);

    const stageKey = `${MFA_TOTP_ENROLLMENT_STAGE_KEY_PREFIX}${user.public_id}`;
    // GETDEL is atomic in Redis 6.2+; a single network round-trip prevents two
    // concurrent confirm requests from both seeing the same staged secret.
    const encryptedStagedSecret = await this.redis.getdel(stageKey);
    if (!encryptedStagedSecret) {
      throw new UnauthorizedError('errors:mfaEnrollExpired');
    }

    const secret = decryptFieldSecret(encryptedStagedSecret);
    const result = await verify({
      secret,
      token: parsed.code,
      epochTolerance: MFA_TOTP_TOLERANCE_STEPS * TOTP_STEP_SECONDS,
    });
    if (!result.valid) {
      throw new UnauthorizedError(ERROR_KEY_MFA_INVALID_OR_EXPIRED_CODE);
    }

    // Mark the code consumed so it can't double as both an enroll-verify and an
    // immediate step-up verify within the replay window.
    await this.rejectReplayedTotpCode(user.id, parsed.code);

    const plaintextRecoveryCodes = generateMfaRecoveryCodes(MFA_RECOVERY_CODE_COUNT);
    const recoveryCodeHashes = plaintextRecoveryCodes.map(hashMfaRecoveryCode);

    const record = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(user.public_id),
      async () => {
        // Serialize against every other credential mutation for this user (deleteMfa takes the same
        // lock) so the revoke-old → insert-new → flip-is_mfa_enabled sequence can't interleave with a
        // concurrent enroll/delete under READ COMMITTED and leave is_mfa_enabled inconsistent with the
        // actual method rows (route-audit D3 — the lock was previously only half-deployed).
        await this.authMethodService.acquireCredentialMutationLock(user.id);
        // sec-re-04: a re-enrollment (lost device, new phone) must replace the
        // previous TOTP factor — not silently add a second active one. Without
        // this dedup, two active MFA_TOTP rows existed and login picked an
        // arbitrary one via `findTotpByUserId(.limit(1))`, frequently rejecting
        // the user's codes against a stale secret. Revoking old factors AND
        // invalidating unused recovery codes BEFORE inserting the new ones keeps
        // the whole transition inside one `withPrincipalDatabaseContext (user scope)` transaction
        // — a crash partway through rolls everything back and the user can
        // simply restart the enroll-confirm flow.
        const existingMfaMethods = await this.authMethodService.listMfaMethodsByUserId(user.id);
        for (const existing of existingMfaMethods) {
          if (existing.method_type === 'MFA_TOTP') {
            await this.authMethodService.revokeAuthMethod(existing.id, user.id);
          }
        }
        await invalidateAllUnusedRecoveryCodesForUser(user.id);

        const created = await this.authMethodService.createAuthMethodRecord({
          user_id: user.id,
          method_type: 'MFA_TOTP',
          encrypted_secret: encryptFieldSecret(secret),
          is_primary: false,
          created_by_user_id: user.id,
        });
        await insertMfaRecoveryCodes(user.id, recoveryCodeHashes);
        // sec-re-06: flip is_mfa_enabled INSIDE the same withPrincipalDatabaseContext (user scope)
        // callback so it is part of the same transaction as the auth_methods insert
        // and recovery-codes insert. Previously it ran AFTER commit on a separate
        // connection; a crash / pool timeout between commit and the flip left the
        // user with valid TOTP + recovery codes but is_mfa_enabled = false, so the
        // next login skipped the MFA challenge entirely.
        // The nested withPrincipalDatabaseContext (user scope) call reuses the already-pinned handle
        // (the outer callback is still inside the same transaction), so no separate
        // transaction is opened — all three writes still commit atomically.
        await this.userService.updateMfaEnabled(user.public_id, true);
        return created;
      },
    );

    return {
      recovery_codes: plaintextRecoveryCodes,
      method_public_id: record.public_id,
    };
  }

  /**
   * Delete (revoke) an MFA method for the current user.
   *
   * @remarks
   * Refuses with `ForbiddenError('errors:lastMfaRequiredByOrganization')` when removing
   * the method would leave the user with zero MFA factors AND any organization the user
   * belongs to has `organization_settings.require_mfa = true` (sec-A4). Without this
   * guard, a member of an MFA-required org could silently downgrade themselves to
   * password-only authentication in direct contradiction of org policy. The check
   * pre-computes the remaining-count by listing first, so the revoke does NOT execute
   * when the policy would be violated. Non-last deletions and users in MFA-non-required
   * orgs are unaffected.
   */
  async deleteMfa(userPublicId: string, mfaMethodPublicId: string): Promise<void> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new UnauthorizedError(ERROR_KEY_MFA_USER_NOT_FOUND);
    await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(user.public_id),
      async () => {
        // route-audit C1 (deleteMfa sibling): serialize concurrent credential mutations for this user
        // so the "would this remove the last MFA factor?" count + revoke cannot interleave with a
        // sibling delete and strip the user to zero factors in an MFA-required org.
        await this.authMethodService.acquireCredentialMutationLock(user.id);
        // route-#10: resolve by opaque public id (not the leaked sequential id); the resolved row
        // still yields its numeric id for the user-scoped revoke below.
        const found = await this.authMethodService.findAuthMethodByPublicIdForUser(
          mfaMethodPublicId,
          user.id,
        );
        if (!found) throw new UnauthorizedError('errors:mfaMethodNotFound');
        if (found.method_type !== 'MFA_TOTP') {
          throw new UnauthorizedError('errors:mfaNotTotpMethod');
        }
        // Pre-check: would this revoke leave zero MFA methods? If yes AND any of the user's
        // orgs requires MFA, refuse BEFORE executing the revoke (sec-A4).
        const currentMethods = await this.authMethodService.listMfaMethodsByUserId(user.id);
        const wouldBeLastRemoval = currentMethods.length <= 1;
        if (wouldBeLastRemoval && this.organizationSettingsService) {
          const requiresMfa =
            await this.organizationSettingsService.userHasOrganizationRequiringMfa(user.id);
          if (requiresMfa) {
            throw new ForbiddenError('errors:lastMfaRequiredByOrganization');
          }
        }
        await this.authMethodService.revokeAuthMethod(found.id, user.id);
        const remaining = await this.authMethodService.listMfaMethodsByUserId(user.id);
        // sec-new-A4: flip is_mfa_enabled INSIDE the same withPrincipalDatabaseContext (user scope)
        // transaction as the revoke so there is no TOCTOU window where a concurrent
        // enroll could set is_mfa_enabled = true between the delete and the flag flip.
        // The nested withPrincipalDatabaseContext (user scope) call reuses the already-pinned handle.
        if (remaining.length === 0) {
          await this.userService.updateMfaEnabled(user.public_id, false);
        }
      },
    );
  }

  /** List MFA methods for the current user. */
  async listMfaMethods(userPublicId: string) {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new UnauthorizedError(ERROR_KEY_MFA_USER_NOT_FOUND);
    const methods = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(user.public_id),
      () => this.authMethodService.listMfaMethodsByUserId(user.id),
    );
    return methods.map((method) => ({
      // route-#10: expose the opaque public id (not the sequential DB id); DELETE /mfa/:mfa_method_id
      // accepts this value, so the round-trip is unchanged for clients.
      id: method.public_id,
      method_type: method.method_type,
      last_used_at: method.last_used_at,
      created_at: method.created_at,
    }));
  }
}
