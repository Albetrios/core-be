import { createHash } from 'node:crypto';
import { NotFoundError, UnauthorizedError } from '@/shared/errors/index.js';
import { MAX_ACTIVE_SESSIONS_PER_USER } from '@/shared/constants/security.constants.js';
import { captureMessage } from '@/infrastructure/observability/sentry/sentry.js';
import type { UserService } from '@/domains/user/user.service.js';
import { generateRefreshSecret } from '@/domains/auth/auth.http.util.js';
import {
  createSessionDatabaseScope,
  withSessionDatabaseContext,
} from '@/infrastructure/database/contexts/session-database.context.js';
import type { AuthSessionRepository } from './auth-session.repository.js';
import type { AuthSessionCreateData } from './auth-session.types.js';
import {
  getCachedSessionTokenValid,
  invalidateCachedSessionToken,
  setCachedSessionTokenValid,
} from './session-token-cache.service.js';
import { runReadWithTransientRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { withPrincipalDatabaseContext } from '@/infrastructure/database/contexts/principal-database.context.js';
import { resolveVerifiedUserPrincipalScope } from '@/domains/auth/shared/verified-user-principal-scope.util.js';

function hashAccessToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function hashRefreshSecret(refreshSecret: string): string {
  return createHash('sha256').update(refreshSecret).digest('hex');
}

/**
 * Owns the lifecycle of `auth.sessions` rows used for bearer-token refresh,
 * device listing, and revocation.
 *
 * @remarks
 * - **Algorithm:** each access token is paired with a session row whose
 *   `token_hash` (SHA-256 of the JWT) is the join key. On refresh the row stays
 *   put while the hash is rotated (see {@link rotateSessionTokenHash}); on
 *   logout the row is revoked. All reads/writes run under user- or
 *   session-scoped database contexts so Postgres RLS lets them through.
 * - **Failure modes:** missing user / missing session surface `NotFoundError`;
 *   `revokeSessionByAccessToken` and `verifyActiveAccessToken` throw
 *   `UnauthorizedError` with `errors:invalidOrRevokedToken` / `errors:invalidOrExpiredSession`.
 * - **Side effects:** writes to `auth.sessions`; invalidates the Redis token
 *   cache via {@link invalidateCachedSessionToken} on every revoke / rotate so
 *   downstream bearer checks see the change immediately. On refresh-secret reuse
 *   (an already-rotated secret replayed), {@link refreshSessionCredentials}
 *   revokes the user's entire session family, not just the targeted session.
 * - **Notes:** {@link verifyActiveAccessToken} is hot-pathed by the auth
 *   middleware and uses a 60-second Redis cache to amortise DB round-trips.
 */
export class AuthSessionService {
  constructor(
    private readonly userService: UserService,
    private readonly sessionRepository: AuthSessionRepository,
  ) {}

  async list(userPublicId: string) {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    return withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(userPublicId),
      (_databaseHandle) => this.sessionRepository.listByUserId(user.id),
    );
  }

  /**
   * Lists session metadata for a GDPR data-export bundle (includes revoked sessions; capped by
   * caller).
   */
  async listForUserDataExport(options: { userPublicId: string; limit: number }) {
    const user = await this.userService.requireUserRecordByPublicId(options.userPublicId);
    return withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(options.userPublicId),
      (_databaseHandle) => this.sessionRepository.listForUserDataExport(user.id, options.limit),
    );
  }

  async revoke(userPublicId: string, sessionPublicId: string) {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    const revoked = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(userPublicId),
      (_databaseHandle) => this.sessionRepository.revoke(sessionPublicId, user.id),
    );
    if (!revoked) throw new NotFoundError('Session');
    if (revoked.token_hash) {
      await invalidateCachedSessionToken(revoked.token_hash);
    }
  }

  private async invalidateRevokedSessionCaches(
    revokedSessions: { token_hash: string | null }[],
  ): Promise<void> {
    await Promise.all(
      revokedSessions
        .map((session) => session.token_hash)
        .filter((tokenHash): tokenHash is string => Boolean(tokenHash))
        .map((tokenHash) => invalidateCachedSessionToken(tokenHash)),
    );
  }

  async revokeAllSessions(userPublicId: string): Promise<void> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    const revokedSessions = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(userPublicId),
      (_databaseHandle) => this.sessionRepository.revokeAllByUserId(user.id),
    );
    await this.invalidateRevokedSessionCaches(revokedSessions);
  }

  /**
   * Revokes every active session for a user except the one identified by the
   * supplied bearer access token, and invalidates their token caches.
   *
   * @remarks
   * - **Algorithm:** hashes `currentAccessToken` (SHA-256) and runs a single
   *   `UPDATE … WHERE user_id = ? AND is_revoked = false AND token_hash <> ?`,
   *   then invalidates the Redis token cache for each revoked hash.
   * - **Failure modes:** throws `NotFoundError('User')` when the user no longer
   *   exists. If the current token's session was already rotated/revoked, this
   *   simply revokes the remaining sessions.
   * - **Side effects:** writes `auth.sessions` rows; invalidates cached
   *   token-validity entries so revocation takes effect immediately.
   * - **Notes:** used by the authenticated change-password flow to terminate all
   *   other devices while keeping the caller's current session alive.
   */
  async revokeAllSessionsExceptCurrent({
    userPublicId,
    currentAccessToken,
  }: {
    userPublicId: string;
    currentAccessToken: string;
  }): Promise<void> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    const currentTokenHash = hashAccessToken(currentAccessToken);
    const revokedSessions = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(userPublicId),
      (_databaseHandle) =>
        this.sessionRepository.revokeAllByUserIdExcept(user.id, currentTokenHash),
    );
    await this.invalidateRevokedSessionCaches(revokedSessions);
  }

  async createSessionForUser(
    userPublicId: string,
    data: Omit<AuthSessionCreateData, 'user_id' | 'refresh_token_hash'>,
  ): Promise<{ public_id: string; refresh_secret: string }> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');
    const refreshSecret = generateRefreshSecret();
    const { session, evictedSessions } = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(userPublicId),
      async (_databaseHandle) => {
        // Bound the user's concurrent live sessions. Under a per-user advisory lock (so concurrent
        // logins cannot overshoot), evict the oldest sessions beyond MAX_ACTIVE_SESSIONS_PER_USER - 1
        // so there is room for this new one. Evicting (not rejecting) means a legitimate multi-device
        // user is never locked out — only their stalest session is dropped — while a single account
        // can no longer mint unbounded sessions (bloat + stolen-credential blast radius).
        await this.sessionRepository.acquireCreationQuotaLock(user.id);
        const evicted = await this.sessionRepository.revokeOldestActiveBeyond(
          user.id,
          MAX_ACTIVE_SESSIONS_PER_USER - 1,
        );
        const created = await this.sessionRepository.create({
          user_id: user.id,
          refresh_token_hash: hashRefreshSecret(refreshSecret),
          ...data,
        });
        return { session: created, evictedSessions: evicted };
      },
    );
    // Purge the session-token cache for any evicted session so its access token stops authenticating
    // on the next request (a revocation tombstone), mirroring explicit logout/revoke.
    await this.invalidateRevokedSessionCaches(evictedSessions);
    return { public_id: session.public_id, refresh_secret: refreshSecret };
  }

  async revokeSessionByAccessToken(token: string): Promise<void> {
    const tokenHash = hashAccessToken(token);
    await invalidateCachedSessionToken(tokenHash);
    const revoked = await withSessionDatabaseContext(
      createSessionDatabaseScope('token_hash', tokenHash),
      (_databaseHandle) => this.sessionRepository.revokeByTokenHash(tokenHash),
    );
    if (!revoked) {
      throw new UnauthorizedError('errors:invalidOrRevokedToken');
    }
  }

  /**
   * Ensures the bearer token matches an active, non-revoked session row AND that
   * the owning user is still active (not suspended or soft-deleted).
   *
   * @remarks
   * Returns `{ sessionPublicId }` so callers (auth middleware) can attach session
   * identity to `request.auth` for step-up binding (sec-A2). The positive result is
   * cached in Redis for up to 60s — the cache value is the session's `public_id`, so a
   * cache hit avoids the Postgres round-trip AND still produces the session id.
   * The cache TTL is capped to the session's remaining lifetime so a cached "valid"
   * entry can never outlive the session (see {@link setCachedSessionTokenValid}).
   *
   * **sec-new-A2:** `userPublicId` (from the JWT payload) is used to verify user
   * status on every DB-path validation (cache miss). A suspended or deleted user will
   * receive `errors:accountNotActive` instead of being allowed to continue using their
   * still-valid access token. The Redis cache caps the propagation window at ≤60 s
   * (same TTL as session validity), down from the prior ≤15 min access-token lifetime.
   */
  async verifyActiveAccessToken(
    rawToken: string,
    userPublicId: string,
  ): Promise<{ sessionPublicId: string }> {
    const tokenHash = hashAccessToken(rawToken);
    const cachedSessionPublicId = await getCachedSessionTokenValid(tokenHash);
    if (cachedSessionPublicId !== null) {
      // Cache hit: session was valid ≤60 s ago; user status is implicitly valid at
      // that point. Suspension propagates on the next cache miss (≤60 s window).
      return { sessionPublicId: cachedSessionPublicId };
    }

    // These two reads run in the auth pre-handler, outside any service transaction (autocommit), so
    // a transient managed-Postgres connection drop is safe to retry rather than spuriously 401 an
    // otherwise-authenticated request. Only connection-level errors are retried (see
    // runReadWithTransientRetry); an invalid/expired session still returns null on the first attempt.
    const session = await runReadWithTransientRetry(() =>
      withSessionDatabaseContext(
        createSessionDatabaseScope('token_hash', tokenHash),
        (_databaseHandle) => this.sessionRepository.findActiveByTokenHash(tokenHash),
      ),
    );

    if (!session) {
      throw new UnauthorizedError('errors:invalidOrExpiredSession');
    }

    // sec-new-A2: verify the owning user is still active. Runs only on cache miss
    // (first request per 60 s window) to avoid a per-request DB round-trip.
    // findUserRecordByPublicId wraps withUserDatabaseContext internally.
    const user = await runReadWithTransientRetry(() =>
      this.userService.findUserRecordByPublicId(userPublicId),
    );
    if (user?.status !== 'ACTIVE' || user.deleted_at !== null) {
      throw new UnauthorizedError('errors:accountNotActive');
    }

    await setCachedSessionTokenValid({
      tokenHash,
      sessionPublicId: session.public_id,
      sessionExpiresAt: session.expires_at,
    });
    return { sessionPublicId: session.public_id };
  }

  async findActiveSessionByPublicId(sessionPublicId: string) {
    return withSessionDatabaseContext(
      createSessionDatabaseScope('public_id', sessionPublicId),
      (_databaseHandle) => this.sessionRepository.findByPublicId(sessionPublicId),
    );
  }

  /**
   * Lookup wrapper that returns the session row even when `is_revoked = true`.
   * Used by `auth.service.refreshToken` so a refresh-secret replay against an
   * already-revoked session reaches `refreshSessionCredentials`'
   * reuse-detection block (sec-re-05). The narrow active-only
   * `findActiveSessionByPublicId` is retained for callers that genuinely need
   * to filter revoked rows.
   */
  async findSessionByPublicIdIncludingRevoked(sessionPublicId: string) {
    return withSessionDatabaseContext(
      createSessionDatabaseScope('public_id', sessionPublicId),
      (_databaseHandle) => this.sessionRepository.findByPublicIdIncludingRevoked(sessionPublicId),
    );
  }

  async rotateSessionTokenHash(sessionPublicId: string, tokenHash: string): Promise<void> {
    await withSessionDatabaseContext(
      createSessionDatabaseScope('public_id', sessionPublicId),
      async (_databaseHandle) => {
        const existing = await this.sessionRepository.findByPublicId(sessionPublicId);
        if (existing?.token_hash) {
          await invalidateCachedSessionToken(existing.token_hash);
        }
        await this.sessionRepository.rotateTokenHash(sessionPublicId, tokenHash);
      },
    );
  }

  async refreshSessionCredentials({
    sessionPublicId,
    refreshSecret,
    nextAccessToken,
  }: {
    sessionPublicId: string;
    refreshSecret: string;
    nextAccessToken: string;
  }): Promise<{ refresh_secret: string }> {
    const currentRefreshHash = hashRefreshSecret(refreshSecret);
    const nextRefreshSecret = generateRefreshSecret();
    const nextRefreshHash = hashRefreshSecret(nextRefreshSecret);
    const nextTokenHash = hashAccessToken(nextAccessToken);

    const rotated = await withSessionDatabaseContext(
      createSessionDatabaseScope('public_id', sessionPublicId),
      async (_databaseHandle) => {
        const existing = await this.sessionRepository.findByPublicId(sessionPublicId);
        if (!existing?.refresh_token_hash) {
          return null;
        }
        if (existing.token_hash) {
          await invalidateCachedSessionToken(existing.token_hash);
        }
        return this.sessionRepository.rotateSessionCredentials(
          sessionPublicId,
          currentRefreshHash,
          nextTokenHash,
          nextRefreshHash,
        );
      },
    );

    if (!rotated) {
      // Reuse detection: the presented refresh secret did not match the stored hash. If the
      // session still exists with a *different* refresh hash, an already-rotated (old/stolen)
      // secret is being replayed. Revoke the user's entire session family so a leaked refresh
      // token cannot be used to keep — or regain — access on any device (OAuth refresh-token
      // rotation reuse-detection per RFC 9700).
      //
      // sec-A finding #9: include ALREADY-REVOKED rows in the lookup. A user who clicks
      // "Log out everywhere" revokes the row but an attacker may still hold the stale
      // refresh secret. Without including the revoked row in this lookup, the family-wide
      // kill path silently no-ops and we lose the audit/Sentry signal exactly when it is
      // most informative — "we already revoked this session and someone is still trying
      // to use its refresh secret." We capture every refresh-secret mismatch to Sentry
      // for breach detection, separate from whether we re-revoke.
      const reuseDetection = await withSessionDatabaseContext(
        createSessionDatabaseScope('public_id', sessionPublicId),
        async (_databaseHandle) => {
          const existing =
            await this.sessionRepository.findByPublicIdIncludingRevoked(sessionPublicId);
          if (existing?.refresh_token_hash && existing.refresh_token_hash !== currentRefreshHash) {
            return { userId: existing.user_id, wasAlreadyRevoked: existing.is_revoked };
          }
          return null;
        },
      );
      if (reuseDetection !== null) {
        captureMessage('auth.refresh_token.reuse_detected', {
          level: 'warning',
          extra: {
            session_public_id: sessionPublicId,
            was_already_revoked: reuseDetection.wasAlreadyRevoked,
          },
        });
        if (!reuseDetection.wasAlreadyRevoked) {
          await this.revokeAllSessionsForReusedRefreshSecret(reuseDetection.userId);
        }
      }
      throw new UnauthorizedError('errors:invalidOrExpiredSession');
    }

    return { refresh_secret: nextRefreshSecret };
  }

  /**
   * Re-bind the session's active access token to a freshly minted one — used by the
   * organization-switch endpoints, which re-mint the token with a different `org` claim.
   *
   * @remarks
   * - **Algorithm:** under the session's RLS context, confirm the session is present and not
   *   revoked, invalidate the previous token's Redis cache entry, then point `token_hash` at
   *   the new token AND persist `activeOrganizationId` on the session (audit-#3) so a later
   *   `/auth/refresh` preserves the switched organization instead of recomputing the default.
   *   Unlike refresh, the refresh secret is NOT rotated — the caller is already authenticated
   *   via a valid access token for this session; only the access token moves. The previously
   *   held token immediately fails `verifyActiveAccessToken` (hash drift).
   * - **Failure modes:** `UnauthorizedError` when the session is gone or revoked.
   * - **Side effects:** one UPDATE on `auth.sessions`; two Redis cache invalidations.
   */
  async rebindAccessToken({
    sessionPublicId,
    nextAccessToken,
    activeOrganizationId,
  }: {
    sessionPublicId: string;
    nextAccessToken: string;
    activeOrganizationId: number;
  }): Promise<void> {
    const nextTokenHash = hashAccessToken(nextAccessToken);
    await withSessionDatabaseContext(
      createSessionDatabaseScope('public_id', sessionPublicId),
      async (_databaseHandle) => {
        const existing = await this.sessionRepository.findByPublicId(sessionPublicId);
        if (!existing) {
          throw new UnauthorizedError('errors:invalidOrExpiredSession');
        }
        if (existing.token_hash) {
          await invalidateCachedSessionToken(existing.token_hash);
        }
        await this.sessionRepository.rotateTokenHashAndOrganization(
          sessionPublicId,
          nextTokenHash,
          activeOrganizationId,
        );
        await invalidateCachedSessionToken(nextTokenHash);
      },
    );
  }

  /**
   * Revokes every session for the owner of a replayed refresh secret.
   *
   * @remarks
   * - **Algorithm:** resolves the owner's public id from the internal `userId`
   *   via {@link UserService.findById} (RLS-safe SECURITY DEFINER resolver),
   *   then revokes all of that user's sessions under their own `app.current_user_id`
   *   context so the `sessions_user_access` policy authorizes the family-wide update.
   * - **Failure modes:** if the owner can no longer be resolved (already
   *   hard-deleted) the revoke is skipped — the replay is rejected regardless by
   *   the `UnauthorizedError` thrown by the caller.
   * - **Side effects:** writes `auth.sessions` rows and invalidates each revoked
   *   token's Redis cache entry.
   */
  private async revokeAllSessionsForReusedRefreshSecret(userId: number): Promise<void> {
    const user = await this.userService.findById(userId);
    if (!user) return;
    const revokedSessions = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(user.public_id),
      (_databaseHandle) => this.sessionRepository.revokeAllByUserId(user.id),
    );
    await this.invalidateRevokedSessionCaches(revokedSessions);
  }
}
