import { and, desc, eq, gt, inArray, ne, or, sql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  RESOURCE_QUOTA_LOCK_NAMESPACE,
  acquireResourceQuotaLock,
} from '@/infrastructure/database/resource-quota-lock.util.js';
import { DEFAULT_REPOSITORY_LIST_LIMIT } from '@/shared/constants/query-limits.constants.js';
import { REFRESH_TOKEN_REUSE_GRACE_MS } from '@/shared/constants/security.constants.js';
import { capListWithWarning } from '@/shared/utils/infrastructure/list-cap.util.js';
import { sessions } from '@/domains/auth/sub-domains/auth-session/auth-session.schema.js';
import { databaseNowTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import type { AuthSessionCreateData } from './auth-session.types.js';

/** Row shape returned by {@link AuthSessionRepository.listForUserDataExport}. */
export interface AuthSessionUserDataExportRow {
  ip_address: string | null;
  last_active_at: Date;
  created_at: Date;
}

/** Drizzle repository for the {@link sessions} table; uses {@link generatePublicId} + {@link runInsertWithPublicIdentifierRetry} for collision-safe inserts and operates under request-scoped RLS contexts so users only see their own sessions. */
export class AuthSessionRepository {
  async listForUserDataExport(
    userId: number,
    limit: number,
  ): Promise<AuthSessionUserDataExportRow[]> {
    return getRequestDatabase()
      .select({
        ip_address: sessions.ip_address,
        last_active_at: sessions.last_active_at,
        created_at: sessions.created_at,
      })
      .from(sessions)
      .where(eq(sessions.user_id, userId))
      .orderBy(desc(sessions.created_at))
      .limit(limit);
  }

  async listByUserId(userId: number, limit = DEFAULT_REPOSITORY_LIST_LIMIT) {
    // Fetch one extra row so a hit on the cap is observable instead of a silent truncation.
    const rows = await getRequestDatabase()
      .select()
      .from(sessions)
      .where(and(eq(sessions.user_id, userId), eq(sessions.is_revoked, false)))
      .orderBy(desc(sessions.last_active_at))
      .limit(limit + 1);
    return capListWithWarning({ rows, limit, resource: 'auth.sessions', context: { userId } });
  }

  async findByPublicId(publicId: string) {
    const rows = await getRequestDatabase()
      .select()
      .from(sessions)
      .where(and(eq(sessions.public_id, publicId), eq(sessions.is_revoked, false)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Same as {@link findByPublicId} but DOES NOT filter `is_revoked = false`. Used by the
   * refresh-token reuse-detection path so a replayed refresh secret against an already-
   * revoked session still triggers the family-wide kill / audit signal (sec-A finding #9).
   * Without this variant, the reuse detection silently no-ops once a user has logged out
   * everywhere — losing forensic visibility into stolen refresh secrets exactly when it
   * matters most.
   */
  async findByPublicIdIncludingRevoked(publicId: string) {
    const rows = await getRequestDatabase()
      .select()
      .from(sessions)
      .where(eq(sessions.public_id, publicId))
      .limit(1);
    return rows[0] ?? null;
  }

  async findByPublicIdForUser(publicId: string, userId: number) {
    const rows = await getRequestDatabase()
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.public_id, publicId),
          eq(sessions.user_id, userId),
          eq(sessions.is_revoked, false),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async updateLastActiveAt(publicId: string) {
    await getRequestDatabase()
      .update(sessions)
      .set({ last_active_at: databaseNowTimestamp })
      .where(eq(sessions.public_id, publicId));
  }

  /**
   * Rotate the session's stored access-token hash and bump last_active_at.
   * Called on `/auth/refresh` so that `revokeByTokenHash(currentBearerToken)` (logout)
   * keeps working after a JWT rotation; otherwise the hash drifts and logout silently fails.
   */
  async rotateTokenHash(publicId: string, sessionTokenHash: string) {
    await getRequestDatabase()
      .update(sessions)
      .set({ token_hash: sessionTokenHash, last_active_at: databaseNowTimestamp })
      .where(eq(sessions.public_id, publicId));
  }

  /**
   * Rotate the session's access-token hash AND persist the active organization
   * (audit-#3) so `/auth/refresh` can preserve the organization the caller switched to
   * instead of recomputing the default. Used by the organization-switch path.
   */
  async rotateTokenHashAndOrganization(
    publicId: string,
    sessionTokenHash: string,
    organizationId: number,
  ) {
    await getRequestDatabase()
      .update(sessions)
      .set({
        token_hash: sessionTokenHash,
        organization_id: organizationId,
        last_active_at: databaseNowTimestamp,
      })
      .where(eq(sessions.public_id, publicId));
  }

  async rotateSessionCredentials(
    publicId: string,
    currentRefreshTokenHash: string,
    nextTokenHash: string,
    nextRefreshTokenHash: string,
  ) {
    // audit-#2: accept either the CURRENT refresh hash or the immediately-PREVIOUS one within a
    // short grace window. Two concurrent legitimate refreshes presenting the same cookie race on
    // this single-row compare-and-swap; the loser previously saw the already-rotated hash and was
    // misclassified as stolen-token reuse, revoking the user's entire session family. The grace
    // branch lets the loser rotate from the just-superseded hash instead, so both succeed; a replay
    // AFTER the window finds neither hash and still falls through to reuse detection.
    const reuseGraceCutoff = new Date(Date.now() - REFRESH_TOKEN_REUSE_GRACE_MS);
    const rows = await getRequestDatabase()
      .update(sessions)
      .set({
        // Shift the consumed CURRENT hash into the previous slot and stamp the rotation time so the
        // next concurrent duplicate can match the grace branch above.
        previous_refresh_token_hash: sql`${sessions.refresh_token_hash}`,
        refresh_token_rotated_at: databaseNowTimestamp,
        token_hash: nextTokenHash,
        refresh_token_hash: nextRefreshTokenHash,
        last_active_at: databaseNowTimestamp,
      })
      .where(
        and(
          eq(sessions.public_id, publicId),
          eq(sessions.is_revoked, false),
          gt(sessions.expires_at, databaseNowTimestamp),
          or(
            eq(sessions.refresh_token_hash, currentRefreshTokenHash),
            and(
              eq(sessions.previous_refresh_token_hash, currentRefreshTokenHash),
              gt(sessions.refresh_token_rotated_at, reuseGraceCutoff),
            ),
          ),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async findByTokenHash(sessionTokenHash: string) {
    const rows = await getRequestDatabase()
      .select()
      .from(sessions)
      .where(and(eq(sessions.token_hash, sessionTokenHash), eq(sessions.is_revoked, false)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Active session for bearer validation (not revoked, not expired). */
  async findActiveByTokenHash(sessionTokenHash: string) {
    const rows = await getRequestDatabase()
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.token_hash, sessionTokenHash),
          eq(sessions.is_revoked, false),
          gt(sessions.expires_at, databaseNowTimestamp),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async revoke(publicId: string, userId: number) {
    const rows = await getRequestDatabase()
      .update(sessions)
      .set({ is_revoked: true })
      .where(and(eq(sessions.public_id, publicId), eq(sessions.user_id, userId)))
      .returning({ token_hash: sessions.token_hash });
    return rows[0] ?? null;
  }

  async revokeByTokenHash(sessionTokenHash: string) {
    const rows = await getRequestDatabase()
      .update(sessions)
      .set({ is_revoked: true })
      .where(eq(sessions.token_hash, sessionTokenHash))
      .returning();
    return rows[0] ?? null;
  }

  async revokeAllByUserId(userId: number) {
    return getRequestDatabase()
      .update(sessions)
      .set({ is_revoked: true })
      .where(and(eq(sessions.user_id, userId), eq(sessions.is_revoked, false)))
      .returning({ token_hash: sessions.token_hash });
  }

  async revokeAllByUserIdExcept(userId: number, exceptTokenHash: string) {
    return getRequestDatabase()
      .update(sessions)
      .set({ is_revoked: true })
      .where(
        and(
          eq(sessions.user_id, userId),
          eq(sessions.is_revoked, false),
          ne(sessions.token_hash, exceptTokenHash),
        ),
      )
      .returning({ token_hash: sessions.token_hash });
  }

  /**
   * Takes the per-user session creation-quota advisory lock (auto-releases at commit).
   *
   * @remarks
   * Must run inside the same transaction as the subsequent eviction + insert so concurrent logins
   * cannot each pass the cap check and overshoot {@link MAX_ACTIVE_SESSIONS_PER_USER}.
   */
  async acquireCreationQuotaLock(userId: number): Promise<void> {
    await acquireResourceQuotaLock(RESOURCE_QUOTA_LOCK_NAMESPACE.AUTH_SESSION, userId);
  }

  /**
   * Revokes the user's oldest active (non-revoked, non-expired) sessions beyond the newest
   * `keepCount`, returning their token hashes so the caller can invalidate the session-token cache.
   *
   * @remarks
   * Keeps the `keepCount` most-recently-created live sessions and revokes the rest (oldest-first), so
   * minting one more leaves the user at most `keepCount + 1` live sessions. Two statements (select the
   * ids to revoke via `OFFSET`, then revoke by id) run under the creation-quota advisory lock; expired
   * rows are excluded so the daily cleanup worker's not-yet-purged rows never count toward the cap.
   */
  async revokeOldestActiveBeyond(userId: number, keepCount: number) {
    const liveCondition = and(
      eq(sessions.user_id, userId),
      eq(sessions.is_revoked, false),
      gt(sessions.expires_at, sql`now()`),
    );
    const oldest = await getRequestDatabase()
      .select({ id: sessions.id })
      .from(sessions)
      .where(liveCondition)
      .orderBy(desc(sessions.created_at), desc(sessions.id))
      .offset(keepCount);
    if (oldest.length === 0) return [] as { token_hash: string | null }[];
    return getRequestDatabase()
      .update(sessions)
      .set({ is_revoked: true })
      .where(
        inArray(
          sessions.id,
          oldest.map((row) => row.id),
        ),
      )
      .returning({ token_hash: sessions.token_hash });
  }

  async create(data: AuthSessionCreateData) {
    return runInsertWithPublicIdentifierRetry(async () => {
      const publicId = generatePublicId('authSession');
      const rows = await getRequestDatabase()
        .insert(sessions)
        .values({
          public_id: publicId,
          user_id: data.user_id,
          token_hash: data.token_hash,
          refresh_token_hash: data.refresh_token_hash,
          ip_address: data.ip_address,
          user_agent: data.user_agent,
          expires_at: data.expires_at,
        })
        .returning();
      return rows[0]!;
    });
  }
}
