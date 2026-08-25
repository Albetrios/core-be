import { createHash } from 'node:crypto';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/shared/errors/index.js';
import type { Redis } from 'ioredis';
import { assertUserAccountActive } from '@/shared/utils/auth/account-status.util.js';
import { enforceMinimumDuration } from '@/shared/utils/security/anti-enumeration.util.js';
import { isDisposableEmailBlocked } from '@/shared/utils/text/email.util.js';
import { isPostgresUniqueViolation } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { incrementWithExpiryOnFirst } from '@/shared/utils/infrastructure/redis-counter.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { env } from '@/shared/config/env.config.js';
import { ensurePersonalOrganization } from '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js';
import {
  VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS,
  VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS,
  VERIFICATION_CODE_TTL_MINUTES,
  generateVerificationCode,
  hashVerificationCode,
  normalizeVerificationCode,
  STATIC_VERIFICATION_CODE,
} from '@/domains/auth/sub-domains/auth-method/verification-code.js';
import type { EmailSendCodeResult } from '@/domains/auth/auth.types.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { UserAuthRecord } from '@/domains/user/user.types.js';
import type { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import type { MfaService } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa.service.js';
import type { VerificationTokenRepository } from './verification-token/verification-token.repository.js';
import { eventBus } from '@/core/events/event-bus.js';
import { withTransaction } from '@/infrastructure/database/transaction.js';
import {
  runWithPinnedDatabaseHandle,
  type RequestScopedPostgresDatabase,
} from '@/infrastructure/database/contexts/request-database.context.js';
import { validateEmailSendCode, validateEmailLogin } from '@/domains/auth/auth.validator.js';
import {
  AUTH_EVENT,
  type EmailVerificationCodePayload,
} from '@/domains/auth/sub-domains/auth-method/events/auth.events.js';
import {
  completeFirstFactorAuth,
  type FirstFactorAuthResult,
} from '@/domains/auth/shared/complete-first-factor-auth.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';

/** Token category persisted in `verification_tokens.token_type` for the email verification-code login flow. */
const EMAIL_CODE_TOKEN_TYPE = 'EMAIL_CODE';

/** Redis key prefix for the per-user email verification-code attempt counter (brute-force cap). */
const EMAIL_CODE_VERIFY_ATTEMPT_KEY_PREFIX = 'auth:email_code_verify_attempts:';

/** Redis key prefix for the per-email verification-code send cooldown (anti-mail-bomb spacing). */
const EMAIL_CODE_SEND_COOLDOWN_KEY_PREFIX = 'auth:email_code_send_cooldown:';

/**
 * Issues and verifies email **verification codes** (alphanumeric) for the unified passwordless
 * login + auto-signup flow (`POST /auth/email/send-code` + `POST /auth/email/login`).
 *
 * @remarks
 * Algorithm:
 * - {@link EmailLoginService.sendCode} validates the email and blocks disposable domains, then
 *   find-or-creates the user: an unknown email is auto-signed-up (a passwordless user + an
 *   `EMAIL_CODE` auth-method, mirroring OAuth find-or-create). Existing and new users then follow an
 *   identical path — invalidate prior unused codes, issue a fresh single live code, and emit
 *   `AUTH_EVENT.EMAIL_VERIFICATION_CODE_REQUESTED` with the raw code in the payload.
 * - {@link EmailLoginService.login} resolves the user by email, applies a per-user attempt cap (the
 *   code space is bounded, so guessing is gated by this online cap + the short TTL + single-use
 *   consume), atomically consumes a matching code scoped to `(user_id, EMAIL_CODE)`
 *   (`UPDATE ... RETURNING` so two concurrent logins cannot both produce a session), invalidates the
 *   user's remaining live codes (single-use across the whole set), flips `is_email_verified` (the
 *   code proves email control), and mints a JWT + session (or an MFA challenge).
 *
 * Single live code: each send invalidates the user's prior unused codes, so only the most recently
 * emailed code is redeemable; the per-email send cooldown spaces issuance so a rapid accidental
 * re-request does not invalidate an in-flight code. A successful login additionally invalidates any
 * remaining live codes (defence-in-depth for the rare concurrent-send race).
 *
 * Failure modes:
 * - Disposable email → 400 `errors:disposableEmail` from `sendCode`.
 * - Unknown email on `login`, wrong/expired/used code, or attempt cap exceeded → 401
 *   `errors:invalidOrExpiredVerificationCode`.
 * - User soft-deleted between issue and login → 401 `errors:userNotFound` (resolver returns null).
 * - User suspended/locked between issue and login → 401 `errors:accountNotActive`.
 *
 * Side effects:
 * - `sendCode` may create a user + `EMAIL_CODE` auth-method (auto-signup) and best-effort provision
 *   the personal organization; it emits a domain event whose handler enqueues the code email via the
 *   mail outbox.
 * - `login` writes a single `auth_sessions` row, invalidates the user's other live codes, and may
 *   flip `users.is_email_verified`.
 *
 * Notes: raw codes never flow back to HTTP callers — the only egress is through the email handler.
 * Tests capture them via the event bus helper (`captureNextVerificationCode`). `sendCode` returns the
 * same response body for new and existing accounts and holds both to a common minimum duration, so
 * neither the body nor the latency reveals whether the account pre-existed.
 */
export class EmailLoginService {
  constructor(
    private readonly userService: UserService,
    private readonly verificationTokenRepository: VerificationTokenRepository,
    private readonly organizationSettingsService: OrganizationSettingsService,
    private readonly mfaService: MfaService,
    private readonly authSessionService: AuthSessionService,
    private readonly authMethodService: AuthMethodService,
    private readonly redis: Redis = redisConnection,
  ) {}

  /**
   * Find-or-create the user, then email them a one-time sign-in code.
   *
   * On a deployed runtime the raw code is never returned to the caller — it leaves the service only
   * through the `AUTH_EVENT.EMAIL_VERIFICATION_CODE_REQUESTED` event payload (consumed by the mail
   * handler). In-process tests capture it by subscribing to that event via `captureNextVerificationCode`
   * in `src/tests/helpers/verification-code.helper.ts`. The single exception is `env.TEST_MODE` (a
   * `.refine()` forbids it in production; never set on a deployed runtime): under it the result carries
   * `debug_verification_code` so an out-of-process test client (k6 load test) can complete the flow.
   */
  async sendCode(body: unknown, _context?: { requestId?: string }): Promise<EmailSendCodeResult> {
    const startedAtMillis = Date.now();
    const parsed = validateEmailSendCode(body);
    if (isDisposableEmailBlocked(parsed.email)) {
      throw new ValidationError('errors:disposableEmail', undefined, undefined, [
        { field: 'email', messageKey: 'errors:disposableEmail' },
      ]).withReason('disposable_email');
    }
    // Anti-mail-bomb spacing: atomically claim a per-email cooldown slot BEFORE any find-or-create.
    // If one is already held (a code was sent within VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS), skip
    // the auto-signup + issue + email entirely and fall through to the SAME uniform success. The slot
    // is keyed on the requested email regardless of account existence, so it is never an existence
    // oracle, and the constant-time floor below still applies on both paths.
    const cooldownKey = `${EMAIL_CODE_SEND_COOLDOWN_KEY_PREFIX}${createHash('sha256')
      .update(parsed.email)
      .digest('hex')}`;
    let cooldownClaimed: string | null;
    try {
      cooldownClaimed = await this.redis.set(
        cooldownKey,
        '1',
        'EX',
        VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS,
        'NX',
      );
    } catch (error) {
      // Redis unavailable — the shared client runs with enableOfflineQueue:false, so a blip
      // (failover, maintenance, brief partition) rejects this SET immediately. Fail OPEN: a
      // transient Redis outage must not turn passwordless login into a 500. The per-IP and
      // per-email rate limits (whose store already degrades to an in-process counter) remain the
      // mail-bomb backstop; losing only the finer per-email cooldown spacing is the availability
      // trade-off. Treating the slot as claimed lets the code issue + the email enqueue proceed
      // (the enqueue then degrades to the durable outbox sweeper if BullMQ/Redis is still down).
      logger.warn({ err: error }, 'email_login.send.cooldown_unavailable');
      cooldownClaimed = 'OK';
    }
    let issuedCode: string | undefined;
    if (cooldownClaimed) {
      // Auto-signup: an unknown email creates a new passwordless user (mirrors OAuth find-or-create).
      // New and existing users then run the identical issue-code path, so the response body cannot
      // reveal which case occurred; enforceMinimumDuration below masks the create-vs-existing latency
      // difference so timing is not an account-existence oracle either.
      const user =
        (await this.userService.findByEmail(parsed.email)) ??
        (await this.createEmailCodeUser(parsed.email));
      issuedCode = await this.issueVerificationCode(user);
    }
    await enforceMinimumDuration(startedAtMillis);
    return {
      messageKey: 'success:verificationCodeSent',
      expires_in_minutes: VERIFICATION_CODE_TTL_MINUTES,
      // TEST_MODE-only affordance: echo the plaintext code so an out-of-process test client (k6 load
      // test) can complete the passwordless flow. `env.TEST_MODE` is `.refine()`-forbidden in
      // production and is never set on a deployed runtime, so this key is absent everywhere real.
      // When the per-email cooldown was already held, no code was issued this call (`issuedCode`
      // undefined) — mirroring the uniform no-op response.
      ...(env.TEST_MODE && issuedCode ? { debug_verification_code: issuedCode } : {}),
    };
  }

  /**
   * Auto-signs-up a brand-new passwordless user for an unknown email: inserts the user and its
   * `EMAIL_CODE` auth-method atomically, then best-effort provisions the personal org.
   *
   * @remarks
   * The user + auth-method commit together (a failed method insert rolls the user back rather than
   * leaving a credential-less orphan). On a concurrent create race (two sends for the same new
   * email), the loser hits the unique-email index, rolls back, and falls back to the now-existing
   * user so both requests converge on issuing a code — email login is auto-signup, so a duplicate
   * email is NOT a 409 here. Personal-org provisioning runs AFTER the commit (it uses a separate
   * global-admin connection that cannot see an uncommitted user) and is best-effort, exactly
   * mirroring email/password and OAuth signup.
   */
  private async createEmailCodeUser(email: string): Promise<UserAuthRecord> {
    let user: UserAuthRecord;
    try {
      user = await withTransaction((transaction) =>
        runWithPinnedDatabaseHandle(transaction as RequestScopedPostgresDatabase, async () => {
          const created = await this.userService.createForEmailCode({
            email,
          });
          await this.authMethodService.createEmailCodeMethod(created.id, created.public_id);
          return created;
        }),
      );
    } catch (error) {
      // A concurrent send for the same new email won the create race; the unique-email index aborted
      // (and rolled back) this transaction. Re-fetch on a fresh connection and converge on the
      // existing user — the winner already created the auth-method + personal org.
      if (isPostgresUniqueViolation(error)) {
        const existing = await this.userService.findByEmail(email);
        if (existing) return existing;
      }
      throw error;
    }

    if (env.PERSONAL_ORGANIZATION_ENABLED) {
      try {
        await ensurePersonalOrganization(user.id);
      } catch (error) {
        logger.error(
          { err: error, userId: user.public_id },
          'email_login.user.personal_org_provision_failed',
        );
      }
    }
    return user;
  }

  /**
   * Issues a fresh verification code for a user (single live code): invalidates the user's prior
   * unused `EMAIL_CODE` codes, persists the keyed code hash, and emits
   * `AUTH_EVENT.EMAIL_VERIFICATION_CODE_REQUESTED` with the raw code.
   *
   * @remarks
   * audit-#11: invalidating prior codes, persisting the new code, and recording the outbound
   * mail-outbox row (done inside the EMAIL_VERIFICATION_CODE_REQUESTED handler via recordOutboxEmail)
   * must be ONE atomic unit. Otherwise a handler / Redis / process failure could invalidate the user's
   * old code AND leave a new valid code that was never delivered — stranding the user. The pinned
   * transaction makes the handler's outbox insert enrol in the same tx; queue dispatch stays
   * post-commit (the handler schedules it via scheduleCommitDispatch, backed by the outbox sweeper).
   *
   * Only one verification code is live at a time: each send invalidates the prior unused codes, so the
   * most recently emailed code is the only redeemable one (the per-email send cooldown spaces issuance
   * so an in-flight code is not invalidated by an accidental rapid re-request).
   */
  private async issueVerificationCode(user: { id: number; email: string }): Promise<string> {
    const code = generateVerificationCode();
    const expiresAt = new Date(
      Date.now() + VERIFICATION_CODE_TTL_MINUTES * MILLISECONDS_PER_MINUTE,
    );

    await withTransaction((transaction) =>
      runWithPinnedDatabaseHandle(transaction as RequestScopedPostgresDatabase, async () => {
        // Single live code: invalidate the user's prior unused codes so only the newest is redeemable.
        await this.verificationTokenRepository.invalidateAllForUser(user.id, EMAIL_CODE_TOKEN_TYPE);
        await this.verificationTokenRepository.create(
          EMAIL_CODE_TOKEN_TYPE,
          user.id,
          user.email,
          hashVerificationCode({
            tokenType: EMAIL_CODE_TOKEN_TYPE,
            userId: user.id,
            code,
          }),
          expiresAt,
        );
        await eventBus.emitStrict({
          type: AUTH_EVENT.EMAIL_VERIFICATION_CODE_REQUESTED,
          payload: {
            email: user.email,
            verification_code: code,
            expires_in_minutes: VERIFICATION_CODE_TTL_MINUTES,
          } satisfies EmailVerificationCodePayload,
          timestamp: new Date(),
        });
      }),
    );

    // A freshly issued code gets a fresh per-user verify budget: clearing the attempt counter here
    // means an attacker who burned the cap cannot keep the legitimate owner locked out — requesting a
    // new code restores their attempts. Brute-force is unaffected (each code is an independent random
    // target over a large keyspace, and `sendCode` is itself per-email + per-IP rate-limited).
    await this.clearVerifyAttemptCounter(user.id);
    return code;
  }

  /**
   * Best-effort reset of the per-user verification-code verify-attempt counter.
   *
   * @remarks
   * A Redis blip must never fail the surrounding request: the DB write (and, for `sendCode`, the
   * emitted email event) has already committed by the time this runs, and the counter key carries its
   * own TTL — so it self-heals on expiry even if this delete is skipped. Swallows Redis errors with a
   * warning rather than throwing (which, under enableOfflineQueue:false, would otherwise turn a
   * successful issue/login into a 500).
   */
  private async clearVerifyAttemptCounter(userId: number): Promise<void> {
    try {
      await this.redis.del(`${EMAIL_CODE_VERIFY_ATTEMPT_KEY_PREFIX}${userId}`);
    } catch (error) {
      logger.warn({ err: error }, 'email_login.verify_attempt_reset_unavailable');
    }
  }

  /** Verify an email verification code; returns an MFA challenge or an access token + session. */
  async login(
    body: unknown,
    ipAddress: string,
    userAgent?: string,
  ): Promise<FirstFactorAuthResult> {
    const parsed = validateEmailLogin(body);
    const normalizedEmail = parsed.email.trim().toLowerCase();

    // The code is bounded-entropy, so resolve the owner first and gate guessing with a per-user
    // attempt cap (mirrors MFA) BEFORE any DB work. An unknown email is treated like a wrong code so
    // the response is not an account-existence oracle (the route also rate-limits per email + IP).
    // Measure from before the user lookup so the fast unknown-email branch and the slower
    // known-email branch (Redis + code-consume transaction) share the same minimum duration —
    // otherwise response latency leaks which emails have accounts (parity with sendCode + login).
    const startedAtMillis = Date.now();
    const user = await this.userService.findByEmail(normalizedEmail);
    if (!user) {
      await enforceMinimumDuration(startedAtMillis);
      throw new UnauthorizedError('errors:invalidOrExpiredVerificationCode');
    }

    const attemptKey = `${EMAIL_CODE_VERIFY_ATTEMPT_KEY_PREFIX}${user.id}`;
    const attempts = await incrementWithExpiryOnFirst(
      this.redis,
      attemptKey,
      VERIFICATION_CODE_TTL_MINUTES * 60,
    );
    if (attempts > VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS) {
      await enforceMinimumDuration(startedAtMillis);
      throw new UnauthorizedError('errors:invalidOrExpiredVerificationCode');
    }

    // First successful completion for an as-yet-unverified account: the email is about to be proven,
    // so this is the moment a bare invited placeholder (created without a personal org) gets claimed.
    const isFirstVerification = !user.is_email_verified;

    // audit-#12: consume the one-time code AND complete first-factor auth (session creation, or the
    // MFA-challenge decision) in ONE pinned transaction. A transient failure after consumption would
    // otherwise permanently burn a valid single-use code. The atomic `consumeOtpForUser` UPDATE
    // (scoped to user_id + EMAIL_CODE) prevents two concurrent logins from both producing a session;
    // on a downstream failure the pinned transaction rolls the consume (and the is_email_verified
    // flip, and the invalidate-others) back, leaving the code redeemable.
    const result = await withTransaction((transaction) =>
      runWithPinnedDatabaseHandle(transaction as RequestScopedPostgresDatabase, async () => {
        // sec-r5-L2 + code scoping: consumeOtpForUser is bound to (user.id, EMAIL_CODE) so a code from
        // another flow or another user never matches/burns, and its atomic UPDATE prevents two
        // concurrent logins from both producing a session.
        // Local/dev escape hatch: while AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED is on, the
        // well-known STATIC_VERIFICATION_CODE is also accepted, so callers can log in without the
        // `send-code` round trip. The env schema permits that flag only on the `local` and
        // `development` targets, so this branch cannot exist on a deployed production runtime.
        // Everything protective around it still runs — the user must already exist (resolved
        // above), the per-user attempt cap has already been charged, and the account-active
        // assertion below is unchanged. It only skips the stored-code lookup itself.
        const usedStaticCode =
          env.AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED &&
          normalizeVerificationCode(parsed.code) === STATIC_VERIFICATION_CODE;

        if (!usedStaticCode) {
          // sec-r5-L2 + code scoping: consumeOtpForUser is bound to (user.id, EMAIL_CODE) so a code from
          // another flow or another user never matches/burns, and its atomic UPDATE prevents two
          // concurrent logins from both producing a session.
          const record = await this.verificationTokenRepository.consumeOtpForUser(
            user.id,
            EMAIL_CODE_TOKEN_TYPE,
            hashVerificationCode({
              tokenType: EMAIL_CODE_TOKEN_TYPE,
              userId: user.id,
              code: parsed.code,
            }),
          );
          if (!record) throw new UnauthorizedError('errors:invalidOrExpiredVerificationCode');
        }
        // Single-use across the whole concurrent set: redeeming any one code invalidates the rest
        // (the just-consumed row already has used_at, so it is excluded by the isNull filter).
        await this.verificationTokenRepository.invalidateAllForUser(user.id, EMAIL_CODE_TOKEN_TYPE);
        // sec-U1: reject soft-deleted/suspended users before minting a session (the resolver already
        // filters soft-deleted; this is belt-and-suspenders against a regression in either layer).
        assertUserAccountActive({
          status: user.status,
          deleted_at: user.deleted_at,
        });
        // Completing the code proves the user controls this email, so mark it verified (parity with
        // OAuth, and the natural completion of email-code auto-signup).
        if (isFirstVerification) {
          await this.userService.updateEmailVerified(user.public_id);
        }

        return completeFirstFactorAuth({
          user: {
            id: user.id,
            public_id: user.public_id,
            email: user.email,
            status: user.status,
            is_email_verified: true,
            is_mfa_enabled: user.is_mfa_enabled,
          },
          ipAddress,
          userAgent,
          organizationSettingsService: this.organizationSettingsService,
          mfaService: this.mfaService,
          authSessionService: this.authSessionService,
        });
      }),
    ).catch(async (error: unknown) => {
      // Anti-enumeration parity: the known-account failure paths (a wrong/expired code at the
      // `if (!record) throw` above, or a suspended-account rejection) must be timing-indistinguishable
      // from the floored unknown-email and attempt-cap branches — otherwise a fast known-email 401 vs
      // a slow unknown-email 401 leaks account existence (this endpoint's documented guarantee). Floor
      // before re-throwing, outside the transaction so no DB connection is held during the wait.
      await enforceMinimumDuration(startedAtMillis);
      throw error;
    });

    // Clear the attempt counter so a verified user's later legitimate flows are never pre-throttled.
    await this.clearVerifyAttemptCounter(user.id);

    // On the first successful login, ensure the personal organization exists — a bare invited
    // placeholder is created WITHOUT one, so an email-code claimer would otherwise have no personal
    // org (a brand-new passwordless signup already provisioned one at send time, making this an
    // idempotent no-op for that path). Runs post-commit in a separate global-admin connection that
    // cannot see an uncommitted user — and after the code is consumed, so a wrong code can never
    // force-provision. Best-effort + idempotent (partial unique index), matching signup / OAuth.
    if (isFirstVerification && env.PERSONAL_ORGANIZATION_ENABLED) {
      try {
        await ensurePersonalOrganization(user.id);
      } catch (error) {
        logger.error(
          { err: error, userId: user.public_id },
          'email_login.personal_org_provision_failed',
        );
      }
    }

    return result;
  }

  /**
   * Verifies an email verification-code as a **bootstrap-only** step-up factor for an authenticated
   * user, WITHOUT minting a session. Consuming the code proves current control of the account's
   * email — the same assurance a passwordless login uses — so the caller (the `/auth/step-up`
   * handler) may open a recent-step-up window and record the `email_code` factor.
   *
   * @remarks
   * - **Algorithm:** load the user; reject if MFA is enabled (preserve the MFA invariant — an MFA
   *   user must step up via MFA); reject if the account has a password (email-code step-up exists
   *   only for passwordless accounts that cannot otherwise reach the step-up gate); else atomically
   *   consume a single-use code scoped to `(user_id, EMAIL_CODE)` and invalidate the user's
   *   remaining live codes.
   * - **Failure modes:** `NotFoundError('User')`; `ForbiddenError('errors:mfaStepUpRequired')` for an
   *   MFA account; `ForbiddenError('errors:passwordStepUpRequired')` for a password account;
   *   `UnauthorizedError('errors:invalidOrExpiredVerificationCode')` for a wrong/expired/spent code.
   * - **Side effects:** consumes + invalidates verification tokens. Mints NO session (unlike
   *   {@link EmailLoginService.login}). The window this authorizes is `email_code`-tagged, so it can
   *   enroll a first factor but never satisfy the strong gate on destructive mutations.
   */
  async verifyCodeForStepUp(options: { userPublicId: string; code: string }): Promise<void> {
    const user = await this.userService.requireUserRecordByPublicId(options.userPublicId);
    if (!user) throw new NotFoundError('User');
    if (user.is_mfa_enabled) {
      throw new ForbiddenError('errors:mfaStepUpRequired');
    }
    if (user.password_hash) {
      throw new ForbiddenError('errors:passwordStepUpRequired');
    }
    // Parity with `login` (sec-review): bound online code-guessing with the same per-user attempt cap
    // (checked AFTER the MFA/password guards so a legitimate wrong-method rejection is not counted as
    // a guess), not just the route rate limit. Shares the EMAIL_CODE_VERIFY_ATTEMPT counter so login
    // and step-up draw from one budget.
    const attemptKey = `${EMAIL_CODE_VERIFY_ATTEMPT_KEY_PREFIX}${user.id}`;
    const attempts = await incrementWithExpiryOnFirst(
      this.redis,
      attemptKey,
      VERIFICATION_CODE_TTL_MINUTES * 60,
    );
    if (attempts > VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS) {
      throw new UnauthorizedError('errors:invalidOrExpiredVerificationCode');
    }
    const record = await this.verificationTokenRepository.consumeOtpForUser(
      user.id,
      EMAIL_CODE_TOKEN_TYPE,
      hashVerificationCode({
        tokenType: EMAIL_CODE_TOKEN_TYPE,
        userId: user.id,
        code: options.code,
      }),
    );
    if (!record) throw new UnauthorizedError('errors:invalidOrExpiredVerificationCode');
    await this.verificationTokenRepository.invalidateAllForUser(user.id, EMAIL_CODE_TOKEN_TYPE);
    // Clear the shared attempt counter so a later legitimate login/step-up is not pre-throttled.
    await this.clearVerifyAttemptCounter(user.id);
  }
}
