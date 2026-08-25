import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '@/shared/config/env.config.js';

/** Number of characters in an email verification code. */
export const VERIFICATION_CODE_LENGTH = 6;

/**
 * Alphanumeric alphabet a verification code is drawn from. Crockford-style: uppercase letters +
 * digits with the ambiguous glyphs `0 O 1 I L` removed so a code read off a screen and typed back
 * is unlikely to be transcribed wrong. 31 symbols → {@link VERIFICATION_CODE_LENGTH}=6 gives a
 * ~31^6 ≈ 887M keyspace (far larger than a 6-digit numeric OTP's 1e6).
 */
export const VERIFICATION_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Minutes an issued verification code stays valid before it must be re-requested. */
export const VERIFICATION_CODE_TTL_MINUTES = 15;

/**
 * Per-user verification attempts allowed within a code's lifetime before further tries are rejected.
 * This online cap (paired with the short TTL + single-use consume + the bounded number of concurrent
 * live codes) is what makes guessing infeasible — mirrors the MFA TOTP verification budget.
 */
export const VERIFICATION_CODE_MAX_VERIFY_ATTEMPTS = 5;

/** Seconds a caller must wait between successive code resends for the same purpose (anti-spam). */
export const VERIFICATION_CODE_RESEND_COOLDOWN_SECONDS = 60;

/**
 * The one code `POST /auth/email/login` also accepts while
 * `AUTH_STATIC_VERIFICATION_CODE_ACCEPT_ENABLED` is on, so local work and load tests can reach an
 * authenticated state without the `send-code` round trip.
 *
 * @remarks
 * A constant rather than configuration: the value is not a secret — the flag is what carries the
 * risk, and the env schema only permits that flag on a developer machine or the development
 * deploy target. Drawn from {@link VERIFICATION_CODE_CHARSET} at {@link VERIFICATION_CODE_LENGTH}
 * so it is indistinguishable in shape from a real issued code.
 */
export const STATIC_VERIFICATION_CODE = 'TEST24';

/**
 * Memoized HMAC pepper derived from the required {@link env.SECRETS_ENCRYPTION_KEY}.
 *
 * @remarks
 * Derived lazily (not at module load) so importing this util never depends on env being validated
 * first. A labelled SHA-256 sub-key keeps the verification-code pepper domain-separated from any
 * other use of the master secret.
 */
let cachedPepper: Buffer | null = null;
function verificationCodePepper(): Buffer {
  cachedPepper ??= createHash('sha256')
    .update(`verification-code-pepper:${env.SECRETS_ENCRYPTION_KEY}`)
    .digest();
  return cachedPepper;
}

/**
 * Generates a cryptographically-random alphanumeric verification code of
 * {@link VERIFICATION_CODE_LENGTH} characters drawn from {@link VERIFICATION_CODE_CHARSET}.
 *
 * @remarks
 * - **Algorithm:** one `crypto.randomInt(0, charset.length)` draw per position (uniform CSPRNG —
 *   never `Math.random`), so every code is exactly {@link VERIFICATION_CODE_LENGTH} chars.
 * - **Side effects:** none.
 * - **Notes:** the raw code is emailed to the user and never persisted; only
 *   {@link hashVerificationCode} of it is stored. Guess-resistance comes from the large keyspace,
 *   short TTL, single-use consume, and per-user attempt cap.
 */
export function generateVerificationCode(): string {
  let code = '';
  for (let index = 0; index < VERIFICATION_CODE_LENGTH; index += 1) {
    code += VERIFICATION_CODE_CHARSET[randomInt(0, VERIFICATION_CODE_CHARSET.length)];
  }
  return code;
}

/**
 * Normalizes a user-submitted verification code: trims surrounding whitespace, removes internal
 * spaces/hyphens (some clients chunk the code for readability), and uppercases it so input is
 * case-insensitive and matches the stored hash regardless of how the user typed it.
 *
 * @remarks
 * - **Side effects:** none.
 * - **Notes:** generation only ever emits {@link VERIFICATION_CODE_CHARSET} characters, so a valid
 *   code is always in-charset after normalization; a transcription error simply fails to match and
 *   surfaces as the uniform "invalid or expired" rejection rather than a validation error.
 */
export function normalizeVerificationCode(raw: string): string {
  return raw.trim().replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Keyed, user-scoped HMAC digest of a verification code — the only form persisted (in
 * `verification_tokens.token_hash`).
 *
 * @remarks
 * - **Algorithm:** `HMAC_SHA256(pepper, \`${tokenType}:${userId}:${normalizedCode}\`)` hex (64 chars,
 *   matching the column width). The pepper ({@link verificationCodePepper}) is derived from the
 *   server secret, so a database-only leak cannot rainbow-reverse the small code space; binding the
 *   user id additionally makes the digest unique per user, so the global `UNIQUE(token_hash)`
 *   constraint never cross-user-collides for two users who happen to draw the same code.
 * - **Side effects:** none.
 * - **Notes:** the consume lookup is still scoped to `(user_id, token_type)` and gated by a per-user
 *   attempt cap — the keyed hash hardens at-rest storage, it is not on its own the access control.
 */
export function hashVerificationCode(options: {
  tokenType: string;
  userId: number;
  code: string;
}): string {
  const normalized = normalizeVerificationCode(options.code);
  return createHmac('sha256', verificationCodePepper())
    .update(`${options.tokenType}:${options.userId}:${normalized}`)
    .digest('hex');
}

/** Constant-time comparison of two hex digests of equal length (defence-in-depth for hash matching). */
export function verificationHashesEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
