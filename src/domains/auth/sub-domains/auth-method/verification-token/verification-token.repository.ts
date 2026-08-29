import { and, eq, gt, isNull } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { verification_tokens } from './verification-token.schema.js';

/** Enum of token categories that share the unified {@link verification_tokens} table. */
export type VerificationTokenType = 'EMAIL_CODE' | 'PASSWORD_RESET' | 'EMAIL_CHANGE';

/**
 * Drizzle repository for the shared `verification_tokens` table.
 *
 * @remarks
 * - **Algorithm:** `consumeIfValid` performs an atomic `UPDATE … SET used_at`
 *   guarded by `expires_at > now()` and `used_at IS NULL`, which serializes
 *   concurrent consumers via row locking; only the winning caller observes the
 *   row.
 * - **Failure modes:** returns `null` when the token hash is unknown, expired,
 *   or already used — the caller maps this to `UnauthorizedError`.
 * - **Side effects:** writes only via Drizzle; honours request-scoped RLS via
 *   {@link getRequestDatabase}. `invalidateAllForUser` revokes outstanding
 *   tokens of a category in bulk before a new one is minted.
 * - **Notes:** invariant — a token may be consumed at most once. The replay
 *   tests in `verification-token.replay.db.unit.test.ts` assert this property.
 */
export class VerificationTokenRepository {
  async create(
    tokenType: VerificationTokenType,
    userId: number,
    email: string,
    tokenHash: string,
    expiresAt: Date,
  ) {
    const rows = await getRequestDatabase()
      .insert(verification_tokens)
      .values({
        token_type: tokenType,
        token_hash: tokenHash,
        user_id: userId,
        email,
        expires_at: expiresAt,
      })
      .returning();
    return rows[0]!;
  }

  async findValidByTokenHash(tokenHash: string) {
    const rows = await getRequestDatabase()
      .select()
      .from(verification_tokens)
      .where(
        and(
          eq(verification_tokens.token_hash, tokenHash),
          gt(verification_tokens.expires_at, new Date()),
          isNull(verification_tokens.used_at),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Atomically consume a token: mark used only if it is still valid, unused, and of the
   * `expectedType`. Returns the row when this caller actually consumed the token; returns
   * null when the token is missing, expired, already consumed by a concurrent caller, or
   * of a different category.
   * Use this instead of `findValidByTokenHash` + `markUsed` to prevent TOCTOU double-consume races.
   *
   * @remarks
   * sec-r5-L2: the `token_type` predicate is pinned into the atomic `UPDATE … WHERE` itself
   * rather than checked after consumption. Token hashes are globally unique, so cross-type
   * collision is practically impossible — but scoping the write by category means a token of
   * the wrong flow (e.g. a `PASSWORD_RESET` token replayed against the magic-link verify path)
   * is never matched, locked, or burned in the first place, instead of relying on the caller's
   * surrounding transaction to roll the consume back. The match is fail-closed against the
   * caller's declared type.
   */
  async consumeIfValid(tokenHash: string, expectedType: VerificationTokenType) {
    const rows = await getRequestDatabase()
      .update(verification_tokens)
      .set({ used_at: new Date() })
      .where(
        and(
          eq(verification_tokens.token_hash, tokenHash),
          eq(verification_tokens.token_type, expectedType),
          gt(verification_tokens.expires_at, new Date()),
          isNull(verification_tokens.used_at),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Atomically consume a verification code scoped to a specific user and token type: marks the row
   * used only if a matching, unexpired, unused row exists. Returns the row when this caller consumed
   * it, else `null` (missing / expired / already used / wrong code).
   *
   * @remarks
   * Unlike {@link VerificationTokenRepository.consumeIfValid} — which looks up by the high-entropy
   * 32-byte token hash (plus its `expectedType`) — a verification code is short, so the lookup MUST be
   * bound to `user_id` + `token_type` (and gated by a per-user attempt cap at the call site). Without
   * that scoping an attacker could spray codes against ANY pending code across all users. The single
   * atomic UPDATE also prevents two concurrent verifies from both succeeding. After a winning consume,
   * the caller invalidates the user's remaining live codes via {@link invalidateAllForUser} so the
   * whole concurrent set is single-use the instant any one is redeemed.
   */
  async consumeOtpForUser(userId: number, tokenType: VerificationTokenType, codeHash: string) {
    const rows = await getRequestDatabase()
      .update(verification_tokens)
      .set({ used_at: new Date() })
      .where(
        and(
          eq(verification_tokens.user_id, userId),
          eq(verification_tokens.token_type, tokenType),
          eq(verification_tokens.token_hash, codeHash),
          gt(verification_tokens.expires_at, new Date()),
          isNull(verification_tokens.used_at),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /** Invalidate all unused tokens of a given type for a user. */
  async invalidateAllForUser(userId: number, tokenType: VerificationTokenType) {
    await getRequestDatabase()
      .update(verification_tokens)
      .set({ used_at: new Date() })
      .where(
        and(
          eq(verification_tokens.user_id, userId),
          eq(verification_tokens.token_type, tokenType),
          isNull(verification_tokens.used_at),
        ),
      );
  }

  /**
   * Invalidate ALL outstanding tokens for a user across every token type. Used by the
   * offboarding sequence (sec-U1) so an email-code / password-reset / email-verify token
   * issued seconds before soft-delete cannot mint a session for the deleted user.
   */
  async invalidateAllByUser(userId: number) {
    await getRequestDatabase()
      .update(verification_tokens)
      .set({ used_at: new Date() })
      .where(and(eq(verification_tokens.user_id, userId), isNull(verification_tokens.used_at)));
  }
}
