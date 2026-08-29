import { createHash, randomBytes } from 'node:crypto';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/shared/errors/index.js';
import { MAX_LINKED_AUTH_METHODS_PER_USER } from '@/shared/constants/security.constants.js';
import type { Redis } from 'ioredis';
import { isDisposableEmailBlocked } from '@/shared/utils/text/email.util.js';
import { enforceMinimumDuration } from '@/shared/utils/security/anti-enumeration.util.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { WebauthnCredentialRepository } from '@/domains/auth/sub-domains/auth-webauthn/webauthn-credential.repository.js';
import { VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS } from '@/domains/auth/sub-domains/auth-method/verification-code.js';
import { hashPassword, verifyPassword } from '@/shared/utils/security/password.util.js';
import { eventBus } from '@/core/events/event-bus.js';
import type { UserService } from '@/domains/user/user.service.js';
import {
  AUTH_EVENT,
  type PasswordResetEmailPayload,
} from '@/domains/auth/sub-domains/auth-method/events/auth.events.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { AUTH_METHOD_TYPE } from '@/domains/auth/sub-domains/auth-method/auth-method.constants.js';
import { withTransaction } from '@/infrastructure/database/transaction.js';
import {
  runWithPinnedDatabaseHandle,
  type RequestScopedPostgresDatabase,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { UserAuthRecord } from '@/domains/user/user.types.js';
import type { AuthMethodCreateData } from './auth-method.types.js';
import type { AuthMethodRepository } from './auth-method.repository.js';
import type { VerificationTokenRepository } from './verification-token/verification-token.repository.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import {
  validateCreateAuthMethod,
  validateForgotPassword,
  validateResetPassword,
  validateChangePassword,
} from '@/domains/auth/auth.validator.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

const PASSWORD_RESET_EXPIRES_IN_MINUTES = 60;

/** Redis key prefix for the per-email password-reset send cooldown (anti-mail-bomb spacing). */
const PASSWORD_RESET_COOLDOWN_KEY_PREFIX = 'auth:password_reset_cooldown:';

/**
 * Auth-method types that can mint a session on their own (sec-A5). Used by
 * {@link AuthMethodService.delete} to refuse revoking the user's last login surface.
 * MFA types are intentionally excluded — they are second factors and never the only
 * credential a user has.
 */
const LOGIN_CAPABLE_METHOD_TYPES = new Set<string>([
  AUTH_METHOD_TYPE.PASSWORD,
  AUTH_METHOD_TYPE.OAUTH,
  AUTH_METHOD_TYPE.EMAIL_CODE,
]);

/**
 * Owns the lifecycle of {@link auth_methods} rows and the password/email
 * verification flows that share the unified verification-token table.
 *
 * @remarks
 * - **Algorithm:** authenticated callers manage their linked auth methods
 *   (PASSWORD / OAUTH / EMAIL_CODE / MFA_TOTP) via `list` / `create` / `delete`.
 *   Password reset mints a random 32-byte token, persists its SHA-256 hash with a TTL
 *   ({@link PASSWORD_RESET_EXPIRES_IN_MINUTES}), and atomically consumes it via
 *   {@link VerificationTokenRepository.consumeIfValid} to guard against replay.
 * - **Failure modes:** disposable-email submissions throw `ValidationError`;
 *   unknown users surface `NotFoundError`; bad/expired tokens or wrong current
 *   password throw `UnauthorizedError` with i18n keys.
 * - **Side effects:** invalidates outstanding tokens before issuing new ones;
 *   emits `AUTH_EVENT.PASSWORD_RESET_REQUESTED` (mail enqueue happens in the
 *   auth-method event handlers); rehashes user
 *   passwords via {@link UserService.updatePassword}. A password reset revokes
 *   all of the user's sessions, marks the email verified (the reset token proves email control), and
 *   clears any failed-login lockout, then returns the user so the caller can auto-login; an
 *   authenticated change revokes every session except the caller's current one (or all sessions when
 *   no current token is supplied) via {@link AuthSessionService}.
 * - **Notes:** the forgot-password flow always returns the same success message
 *   even when the email is unknown, to prevent account enumeration. OAuth
 *   linkage is idempotent via {@link AuthMethodService.linkOAuthProviderIfMissing}.
 */
export class AuthMethodService {
  constructor(
    private readonly userService: UserService,
    private readonly authMethodRepository: AuthMethodRepository,
    private readonly verificationTokenRepository: VerificationTokenRepository,
    private readonly authSessionService: AuthSessionService,
    private readonly redis: Redis = redisConnection,
    private readonly webauthnCredentialRepository: WebauthnCredentialRepository = new WebauthnCredentialRepository(),
  ) {}

  async list(userPublicId: string) {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    // auth.auth_methods is FORCE RLS (audit #7); pin the owner context so the owner policy authorizes
    // the read for this user's own credentials.
    return withAppDatabaseContext(PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }), () =>
      this.authMethodRepository.listByUserId(user.id),
    );
  }

  /**
   * Whether the user retains at least one active login-capable auth method
   * (`PASSWORD` / `OAUTH` / `EMAIL_CODE`) — i.e. a way to authenticate that does NOT depend on a
   * passkey.
   *
   * @remarks
   * - **Algorithm:** lists the user's active `auth_methods` under the owner DB context and tests
   *   membership in {@link LOGIN_CAPABLE_METHOD_TYPES} (the same set used by the last-method delete
   *   guard). MFA factors (`MFA_TOTP`) are second factors and are intentionally excluded.
   * - **Failure modes:** `NotFoundError` when the user record is missing.
   * - **Side effects:** transient owner-scoped DB context only.
   * - **Notes:** sec-r5-M3 — consulted by {@link WebauthnService.revokeCredential} so a passkey-only
   *   user cannot delete their last passkey and lock themselves out, while a user with a password /
   *   OAuth / email-code method may remove every passkey.
   */
  async hasLoginCapableMethod(userPublicId: string): Promise<boolean> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    const methods = await withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      () => this.authMethodRepository.listByUserId(user.id),
    );
    return methods.some((method) => LOGIN_CAPABLE_METHOD_TYPES.has(String(method.method_type)));
  }

  /**
   * Whether the user holds ANY active authentication credential — a login-capable `auth_methods`
   * row (`PASSWORD` / `OAUTH` / `EMAIL_CODE`) **or** an active WebAuthn passkey. Used to decide
   * whether a pre-existing account is a still-unclaimed bare invited placeholder (and therefore
   * safe to claim via OAuth / signup) vs. a real account that must never be silently merged into.
   *
   * @remarks
   * - **Algorithm:** under the owner DB context, short-circuits on the first login-capable
   *   `auth_methods` row; otherwise checks for at least one non-revoked `webauthn_credentials` row.
   *   Both tables are FORCE RLS keyed on the owner, so the read runs inside `withAppDatabaseContext (user scope)`.
   * - **Failure modes:** `NotFoundError` when the user record is missing.
   * - **Side effects:** transient owner-scoped DB context only.
   * - **Notes:** unlike {@link AuthMethodService.hasLoginCapableMethod} (which intentionally EXCLUDES
   *   passkeys so a passkey-only user can still delete their last passkey), this counts passkeys —
   *   the account-claim guards must treat a passkey-only account as a real, non-bare account so
   *   takeover safety does not rely on the implicit "passkey ⇒ verified email" invariant.
   */
  async hasActiveLoginCredential(userPublicId: string): Promise<boolean> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    return withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      async () => {
        const methods = await this.authMethodRepository.listByUserId(user.id);
        if (methods.some((method) => LOGIN_CAPABLE_METHOD_TYPES.has(String(method.method_type)))) {
          return true;
        }
        const passkeys = await this.webauthnCredentialRepository.listActiveByUserId(user.id);
        return passkeys.length > 0;
      },
    );
  }

  async create(userPublicId: string, body: unknown) {
    // route-#3: the DTO restricts method_type to EMAIL_CODE — the only type that is a functional
    // credential-less row. PASSWORD/MFA_* (need a stored secret) and OAUTH (proves an external
    // identity, written only by the verified callback) are rejected at validation, so none can be
    // inserted here as non-functional phantom rows that the last-credential guard would miscount.
    const parsed = validateCreateAuthMethod(body);
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    return withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      async () => {
        // Serialize the count + insert under the same per-user credential-mutation advisory lock the
        // delete guard uses, so concurrent creates cannot both pass the cap check and overshoot
        // MAX_LINKED_AUTH_METHODS_PER_USER. The xact lock auto-releases at commit.
        await this.authMethodRepository.acquireCredentialMutationLock(user.id);
        const activeCount = await this.authMethodRepository.countActiveByUserId(user.id);
        if (activeCount >= MAX_LINKED_AUTH_METHODS_PER_USER) {
          throw new ConflictError('errors:authMethodMaxReached', {
            max: MAX_LINKED_AUTH_METHODS_PER_USER,
          });
        }
        return this.authMethodRepository.create(
          omitUndefined({
            user_id: user.id,
            method_type: parsed.method_type,
            is_primary: parsed.is_primary,
            created_by_user_id: user.id,
          }),
        );
      },
    );
  }

  /**
   * Revokes a user's auth method identified by its opaque `public_id` (sec-new-B4).
   *
   * @remarks
   * sec-A5: refuses to revoke the user's LAST login-capable credential. Login-capable
   * types are `PASSWORD`, `OAUTH`, and `EMAIL_CODE` (server-issued auth methods of those
   * kinds) — MFA factors (`MFA_TOTP`, `MFA_SMS`, `MFA_EMAIL`) are second factors and
   * never grant a session on their own, so revoking the last MFA method is permitted
   * here (the org-policy guard on `MfaService.deleteMfa` covers the MFA-required-by-org
   * case — sec-A4). Without this guard, a user could revoke their only PASSWORD/OAUTH
   * and lock themselves out of every login surface — recovery requires admin intervention.
   */
  async delete(userPublicId: string, methodPublicId: string) {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    await withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }),
      async () => {
        const existing = await this.authMethodRepository.findByPublicIdForUser(
          methodPublicId,
          user.id,
        );
        if (!existing) throw new NotFoundError('Auth method');
        const isLoginCapable = LOGIN_CAPABLE_METHOD_TYPES.has(existing.method_type);
        // Atomic count-aware revoke: the "is another login-capable method still active?" check and
        // the revoke run in ONE statement, so two concurrent deletes cannot each see "one other left"
        // and both succeed, zeroing out the user's credentials (route-audit C1 lockout race).
        const revoked = await this.authMethodRepository.revokeUnlessLastLoginCapable(
          existing.id,
          user.id,
          [...LOGIN_CAPABLE_METHOD_TYPES],
        );
        if (!revoked) {
          // `existing` was found above, so a zero-row update means either the last-login-capable guard
          // tripped (for a login-capable method) or the row was concurrently revoked.
          if (isLoginCapable) throw new ForbiddenError('errors:cannotRemoveLastAuthMethod');
          throw new NotFoundError('Auth method');
        }

        // sec-r5-auth-session-info-1: revoking the PASSWORD auth_method row only
        // flipped `auth_methods.revoked_at` but left the stale `users.password_hash`
        // intact, so `POST /auth/login` continued to accept the old credential
        // — the user-facing "I removed my password" view did not match the
        // auth-layer view. Clear the hash atomically in the same
        // withAppDatabaseContext (user scope) transaction so the invariant is real.
        if (existing.method_type === 'PASSWORD') {
          await this.userService.clearPasswordHash(userPublicId);
        }
      },
    );
  }

  async revokeAllForUser(userPublicId: string): Promise<void> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    await withAppDatabaseContext(PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }), () =>
      this.authMethodRepository.revokeAllByUserId(user.id),
    );
  }

  /**
   * Invalidate every outstanding verification token (email-code, password-reset, email-
   * verify, email-change) for a user. Called by the user-offboarding sequence (sec-U1)
   * so a token issued seconds before soft-delete cannot be redeemed to mint a session
   * for the deleted user.
   *
   * @remarks
   * Runs inside `withAppDatabaseContext (user scope)` so the RLS-scoped UPDATE only touches rows
   * owned by the target user; the operation is idempotent (already-used or expired
   * tokens are no-ops). Safe to call at any point in the offboarding sequence — there is
   * no rollback risk because invalidation is a strict superset of natural token expiry.
   */
  async invalidateAllVerificationTokensForUser(userPublicId: string): Promise<void> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    await withAppDatabaseContext(PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }), () =>
      this.verificationTokenRepository.invalidateAllByUser(user.id),
    );
  }

  async findByProviderUserId(provider: string, provider_user_id: string) {
    return this.authMethodRepository.findByProviderUserId(provider, provider_user_id);
  }

  async linkOAuthProviderIfMissing({
    ownerPublicId,
    data,
  }: {
    ownerPublicId: string;
    data: AuthMethodCreateData;
  }): Promise<void> {
    if (!(data.provider && data.provider_user_id)) {
      return;
    }
    // findByProviderUserId goes through the SECURITY DEFINER resolver (pre-session safe); the INSERT
    // must satisfy the owner WITH CHECK, so pin the owner context for the linkage write.
    const existing = await this.authMethodRepository.findByProviderUserId(
      data.provider,
      data.provider_user_id,
    );
    if (!existing) {
      await withAppDatabaseContext(PRINCIPAL_SCOPE.VERIFIED({ userPublicId: ownerPublicId }), () =>
        this.authMethodRepository.create(data),
      );
    }
  }

  async findTotpByUserId(user_id: number) {
    return this.authMethodRepository.findTotpByUserId(user_id);
  }

  async createAuthMethodRecord(data: AuthMethodCreateData) {
    return this.authMethodRepository.create(data);
  }

  /**
   * Creates the user's `EMAIL_CODE` auth_method row during email verification-code auto-signup.
   *
   * @remarks
   * - **Algorithm:** inserts one `method_type=EMAIL_CODE` row owned by the user, pinning the owner
   *   `withAppDatabaseContext (user scope)` so the FORCE-RLS owner WITH CHECK authorizes the write. Intended to
   *   run inside the auto-signup pinned transaction so it commits atomically with the user row.
   * - **Failure modes:** propagates the insert error (e.g. a CHECK/constraint violation) to roll the
   *   auto-signup transaction back.
   * - **Side effects:** one `auth.auth_methods` insert.
   * - **Notes:** `EMAIL_CODE` is a functional credential-less row (no stored secret), so an
   *   email-code-only user has a real login-capable method that appears in
   *   `GET /auth/me/auth-methods` and is counted by the last-login-capable-credential guard.
   */
  async createEmailCodeMethod(userId: number, userPublicId: string): Promise<void> {
    await withAppDatabaseContext(PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }), () =>
      this.authMethodRepository.create({
        user_id: userId,
        method_type: AUTH_METHOD_TYPE.EMAIL_CODE,
        is_primary: true,
        created_by_user_id: userId,
      }),
    );
  }

  async updateAuthMethodLastUsedAt(methodId: number, userId: number): Promise<void> {
    await this.authMethodRepository.updateLastUsedAt(methodId, userId);
  }

  async findAuthMethodByIdForUser(methodId: number, userId: number) {
    return this.authMethodRepository.findByIdForUser(methodId, userId);
  }

  /** route-#10: resolves an auth method by its opaque public id (scoped to the owning user). */
  async findAuthMethodByPublicIdForUser(methodPublicId: string, userId: number) {
    return this.authMethodRepository.findByPublicIdForUser(methodPublicId, userId);
  }

  async listMfaMethodsByUserId(userId: number) {
    return this.authMethodRepository.listMfaByUserId(userId);
  }

  /**
   * Serializes concurrent credential mutations for one user via a transaction-scoped advisory lock.
   * Must be called inside the caller's `withAppDatabaseContext (user scope)` transaction, before a
   * count-then-mutate, so concurrent requests cannot interleave the count and the write.
   */
  async acquireCredentialMutationLock(userId: number): Promise<void> {
    await this.authMethodRepository.acquireCredentialMutationLock(userId);
  }

  async revokeAuthMethod(methodId: number, userId: number): Promise<void> {
    const revoked = await this.authMethodRepository.revoke(methodId, userId);
    if (!revoked) throw new NotFoundError('Auth method');
  }

  // ── Password Reset ────────────────────────────────────────────

  async forgotPassword(
    body: unknown,
    _context?: { requestId?: string },
  ): Promise<{
    messageKey: string;
    messageParams?: Record<string, string | number>;
  }> {
    const startedAtMillis = Date.now();
    const parsed = validateForgotPassword(body);
    if (isDisposableEmailBlocked(parsed.email)) {
      throw new ValidationError('errors:disposableEmail', undefined, undefined, [
        { field: 'email', messageKey: 'errors:disposableEmail' },
      ]).withReason('disposable_email');
    }

    // Anti-mail-bomb spacing: atomically claim a per-email cooldown slot. If one is already held
    // (a reset was requested within VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS), skip issuing/sending entirely
    // and fall through to the SAME uniform success — the cooldown is keyed on the requested email
    // regardless of whether an account exists, so it never becomes an existence oracle.
    const cooldownKey = `${PASSWORD_RESET_COOLDOWN_KEY_PREFIX}${createHash('sha256')
      .update(parsed.email)
      .digest('hex')}`;
    const cooldownClaimed = await this.redis.set(
      cooldownKey,
      '1',
      'EX',
      VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS,
      'NX',
    );
    if (cooldownClaimed) {
      await this.issuePasswordResetIfUserExists(parsed.email);
    }
    // Both branches return the same body; hold them to a common minimum duration so the extra
    // token-issuing writes on the known-account path cannot leak existence via response latency.
    await enforceMinimumDuration(startedAtMillis);
    return { messageKey: 'success:passwordResetEmailSent' };
  }

  private async issuePasswordResetIfUserExists(email: string): Promise<void> {
    const user = await this.userService.findByEmail(email);
    if (!user) return;

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRES_IN_MINUTES * 60_000);

    // audit-#11: invalidate prior tokens, persist the new token, and record the outbound
    // mail-outbox row (done inside the PASSWORD_RESET_REQUESTED handler) as ONE atomic unit.
    // Otherwise a handler/Redis/process failure could invalidate the old link and leave a new
    // valid token that was never delivered — the user has no usable recovery email. Queue dispatch
    // stays post-commit (handler schedules it via scheduleCommitDispatch, backed by the sweeper).
    await withTransaction((transaction) =>
      runWithPinnedDatabaseHandle(transaction as RequestScopedPostgresDatabase, async () => {
        await this.verificationTokenRepository.invalidateAllForUser(user.id, 'PASSWORD_RESET');
        await this.verificationTokenRepository.create(
          'PASSWORD_RESET',
          user.id,
          user.email,
          tokenHash,
          expiresAt,
        );
        await eventBus.emitStrict({
          type: AUTH_EVENT.PASSWORD_RESET_REQUESTED,
          payload: {
            email: user.email,
            reset_token: rawToken,
            expires_in_minutes: PASSWORD_RESET_EXPIRES_IN_MINUTES,
          } satisfies PasswordResetEmailPayload,
          timestamp: new Date(),
        });
      }),
    );
  }

  async resetPassword(body: unknown): Promise<UserAuthRecord> {
    const parsed = validateResetPassword(body);
    const tokenHash = createHash('sha256').update(parsed.token).digest('hex');

    // Hash the new password BEFORE opening the transaction: argon2 is CPU-bound (~100ms) and
    // must not hold a pooled connection open inside the transaction.
    const passwordHash = await hashPassword(parsed.password);

    // Token consume, password update, token invalidation and session revocation must be atomic.
    // A partial apply (password changed but sessions not revoked) would leave a potentially
    // compromised account's existing sessions live after a recovery reset. One pinned
    // transaction makes every nested `withAppDatabaseContext (user scope)` call reuse it (all-or-nothing);
    // a mid-operation failure rolls the password change back rather than committing it alone.
    // Returns the reset user so the caller (AuthService.resetPassword) can mint a fresh session
    // AFTER this revoke-all-sessions, leaving the resetter's new session as the only live one.
    return withTransaction((transaction) =>
      runWithPinnedDatabaseHandle(transaction as RequestScopedPostgresDatabase, async () => {
        // Atomic UPDATE also prevents two concurrent resets from both succeeding.
        // sec-r5-L2: the consume is scoped to PASSWORD_RESET, so a token of another flow
        // is never matched (returns null) rather than burned and then rejected.
        const record = await this.verificationTokenRepository.consumeIfValid(
          tokenHash,
          'PASSWORD_RESET',
        );
        if (!record) {
          throw new UnauthorizedError('errors:invalidOrExpiredResetToken');
        }

        const user = await this.userService.findById(record.user_id);
        if (!user) throw new NotFoundError('User');

        await this.userService.updatePassword(user.public_id, passwordHash);
        // Completing a reset proves control of the email (the token was delivered there), so verify
        // it — parity with email-code / OAuth, and it unblocks an invited user from accepting their
        // org invitation after recovering access.
        await this.userService.updateEmailVerified(user.public_id);
        // The password just changed, so any prior failed-login lockout is moot — clear the counter +
        // lock window (mirrors a successful login) so the owner is not held out of the next sign-in.
        const recovered = await this.userService.updateLoginAttempt(user.public_id, 0, null);
        await this.verificationTokenRepository.invalidateAllForUser(user.id, 'PASSWORD_RESET');

        // A reset is the recovery path for a potentially compromised account, so every existing
        // session is revoked. The Redis token-cache invalidation inside `revokeAllSessions` is a
        // sub-millisecond local call; on rollback it merely causes a cache miss, never a leak.
        await this.authSessionService.revokeAllSessions(user.public_id);
        // `recovered` carries every in-transaction change (new password, verified flag, cleared
        // lockout); fall back to the pre-update row only on the soft-deleted edge (guarded UPDATEs
        // return null), where the caller's assertUserAccountActive then refuses a session anyway.
        return recovered ?? user;
      }),
    );
  }

  async changePassword(
    userPublicId: string,
    body: unknown,
    options?: { currentAccessToken?: string },
  ): Promise<void> {
    const parsed = validateChangePassword(body);
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    if (!user.password_hash) throw new UnauthorizedError('errors:passwordAuthNotEnabled');
    const { valid } = await verifyPassword(parsed.current_password, user.password_hash);
    if (!valid) throw new UnauthorizedError('errors:currentPasswordIncorrect');
    // Hash BEFORE the transaction: argon2 is CPU-bound (~100 ms) and must not hold a pooled
    // connection open inside the transaction.
    const passwordHash = await hashPassword(parsed.new_password);

    // audit-#4: the password update and the session revocation MUST be one atomic unit (the same
    // pinned-transaction pattern `resetPassword` already uses). Previously the password committed
    // first and session revocation ran afterward as a separate operation — a DB/Redis/process
    // failure in between left the new password in place while every existing (potentially
    // attacker-held) session stayed live, so a user changing their password to evict an attacker
    // could believe the account was secured while the stolen bearer token remained usable. The
    // pinned transaction makes nested `withAppDatabaseContext (user scope)` calls reuse it, so a mid-operation
    // failure rolls the password change back rather than committing it alone.
    await withTransaction((transaction) =>
      runWithPinnedDatabaseHandle(transaction as RequestScopedPostgresDatabase, async () => {
        const updatedUser = await this.userService.updatePassword(user.public_id, passwordHash);
        if (!updatedUser) throw new NotFoundError('User');

        // An authenticated change keeps the caller's current session and terminates
        // every other device. Without a current token we cannot single one out, so
        // fall back to revoking all sessions.
        if (options?.currentAccessToken) {
          await this.authSessionService.revokeAllSessionsExceptCurrent({
            userPublicId: user.public_id,
            currentAccessToken: options.currentAccessToken,
          });
        } else {
          await this.authSessionService.revokeAllSessions(user.public_id);
        }
      }),
    );
  }

  /**
   * Re-verifies the caller's password for a step-up ("sudo") re-authentication, without
   * mutating any state. Used by `POST /auth/step-up` so password users can open a short
   * recent-step-up window before a sensitive credential mutation. Throws on a missing user,
   * a passwordless account, or an incorrect password.
   *
   * @remarks
   * MFA-enabled users are rejected with `ForbiddenError('errors:mfaStepUpRequired')` BEFORE
   * the password hash is even compared. Without this, a transient stolen-session + known
   * password defeats the MFA invariant — the attacker could open the step-up window with
   * `/auth/step-up` and then immediately `DELETE /auth/me/mfa/:id` to convert a 15-minute
   * stolen bearer into permanent password-only access. MFA users must step up via
   * `/auth/me/mfa/verify` (which records the same recent-step-up sentinel). The check fires
   * before `verifyPassword` to avoid a password-timing oracle for MFA users (sec-A1).
   */
  async verifyPasswordForStepUp(options: {
    userPublicId: string;
    password: string;
  }): Promise<void> {
    const { userPublicId, password } = options;
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    if (user.is_mfa_enabled) {
      throw new ForbiddenError('errors:mfaStepUpRequired');
    }
    if (!user.password_hash) throw new UnauthorizedError('errors:passwordAuthNotEnabled');
    const { valid } = await verifyPassword(password, user.password_hash);
    if (!valid) throw new UnauthorizedError('errors:currentPasswordIncorrect');
  }
}
