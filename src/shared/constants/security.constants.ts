/** Authentication lockout, credential limits, and related security thresholds. */

/**
 * AES-256-GCM IV length in bytes — the recommended 96-bit nonce for GCM mode
 * (`crypto.createCipheriv('aes-256-gcm', key, iv)`). Used by both the generic
 * `encryptPayload`/`decryptPayload` helpers and the versioned field-secret
 * encryption utility; centralized so the value is a single source of truth.
 */
export const AES_GCM_IV_LENGTH = 12;

/** AES-256-GCM cipher identifier passed to Node `crypto.createCipheriv` / `createDecipheriv`. */
export const AES_GCM_ALGORITHM = 'aes-256-gcm';

/** Failed login attempts before the account is temporarily locked. */
export const MAX_FAILED_LOGIN_ATTEMPTS = 10;

/**
 * Maximum active (non-revoked) auth-method rows a single user may hold.
 *
 * @remarks
 * `POST /auth/me/auth-methods` only ever inserts credential-less `MAGIC_LINK` rows, so the risk is
 * benign self-bloat (a user accumulating rows that also truncate their own capped list view) rather
 * than a credential issue. This ceiling — enforced under the credential-mutation advisory lock so
 * concurrent creates cannot overshoot — bounds that growth well above any legitimate need.
 */
export const MAX_LINKED_AUTH_METHODS_PER_USER = 20;

/**
 * Maximum active (non-revoked) WebAuthn passkeys a single user may register.
 *
 * @remarks
 * Each registration already requires an authenticated session, a recent step-up, and a real
 * authenticator completing a cryptographic ceremony, so abuse potential is low; this cap simply
 * bounds unbounded accumulation. Enforced under the credential-mutation advisory lock.
 */
export const MAX_WEBAUTHN_CREDENTIALS_PER_USER = 20;

/** Account lockout duration after max failed login attempts (minutes). */
export const ACCOUNT_LOCKOUT_MINUTES = 30;

/**
 * Maximum concurrent active (non-revoked, non-expired) sessions per user.
 *
 * @remarks
 * Each successful login mints a new session row. Without a ceiling a single account (or a holder of
 * valid credentials) could mint unbounded sessions — table bloat plus a wide stolen-credential blast
 * radius. On login the oldest sessions beyond this cap are evicted (revoked) rather than rejecting
 * the login, so a legitimate multi-device user is never locked out — only their stalest session is
 * dropped. Set generously so no normal user is affected; tune down for higher-assurance deployments.
 */
export const MAX_ACTIVE_SESSIONS_PER_USER = 30;

/**
 * Failed MFA verification attempts (TOTP or recovery code) per user before MFA
 * verification is temporarily locked (audit-#12).
 *
 * @remarks
 * The `/auth/me/mfa/verify` step-up and `/auth/mfa/login` second factor were gated only by
 * a per-user rate limit with no account-level lockout, unlike the password path. With a
 * stolen-but-valid bearer token an attacker could keep guessing TOTP codes indefinitely.
 * This per-user counter mirrors {@link MAX_FAILED_LOGIN_ATTEMPTS} and locks verification
 * for {@link MFA_VERIFICATION_LOCKOUT_TTL_SECONDS} after the threshold.
 */
export const MAX_MFA_VERIFICATION_ATTEMPTS = 10;

/** Failed login attempts from a single IP before that IP is blocked for the window. */
export const IP_FAILED_LOGIN_THRESHOLD = 50;

/** Sliding window duration for the per-IP failed-login counter (seconds). */
export const IP_FAILED_LOGIN_WINDOW_SECONDS = 15 * 60;

/**
 * Grace window (ms) during which the refresh compare-and-swap also accepts the immediately-previous
 * refresh hash (audit-#2).
 *
 * @remarks
 * Two concurrent legitimate refreshes presenting the same cookie can race: one rotates the stored
 * hash and the loser would otherwise observe a different hash and be misclassified as stolen-token
 * reuse — revoking the user's whole session family. Accepting the just-rotated previous hash for a
 * few seconds lets the concurrent duplicate succeed; a replay AFTER this window still falls through
 * to reuse detection / family revocation. Kept short to bound the relaxation of reuse detection.
 */
export const REFRESH_TOKEN_REUSE_GRACE_MS = 10_000;
