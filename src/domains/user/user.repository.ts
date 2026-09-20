import { createHash } from 'node:crypto';
import { databaseNowTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { and, asc, eq, ilike, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { countWithCap } from '@/infrastructure/database/utils/capped-count.util.js';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { users } from '@/domains/user/user.schema.js';
import { escapeLikePattern } from '@/shared/utils/validation/validation.util.js';
import {
  buildAscendingCreatedAtIdCursorCondition,
  createOpaqueCursorFromRow,
  parseListCursor,
} from '@/shared/utils/http/pagination.util.js';

/** Drizzle-inferred `auth.users` row shape returned by every {@link UserRepository} read. */
type UserRow = typeof users.$inferSelect;

/**
 * Normalises a raw SECURITY DEFINER resolver row (postgres.js returns the `bigint` `id` column as a
 * string) into the typed {@link UserRow} the application consumes. All other columns already arrive
 * as the correct JavaScript types (timestamptz → Date, int4 → number, bool → boolean).
 */
function mapResolverRowToUserRow(row: Record<string, unknown>): UserRow {
  return { ...(row as UserRow), id: Number((row as { id: unknown }).id) };
}

function extractResolverRows(result: unknown): Record<string, unknown>[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Record<
    string,
    unknown
  >[];
}

/** Pagination + filter inputs for {@link UserRepository.findMany} (admin user listing). */
export interface UserListPagination {
  after?: string;
  limit: number;
  status?: string;
  search?: string;
  include_total?: boolean;
}

/**
 * Drizzle data-access for `auth.users`.
 *
 * @remarks
 * - **Algorithm:** all queries scope by `isNull(deleted_at)` so soft-deleted rows are invisible to
 *   the application; admin list uses keyset pagination on `(created_at, id)` with `limit + 1` to
 *   detect `has_more`. Optional `count(*)` only when callers opt in via `include_total`.
 * - **Failure modes:** lookups return `null` when missing; updates return `null` when the row was
 *   concurrently soft-deleted. Public-id generation uses
 *   `runInsertWithPublicIdentifierRetry` so unique-violation collisions retry transparently.
 * - **Side effects:** writes `auth.users` only; cross-domain side effects (sessions, uploads,
 *   exports) live in {@link UserService.softDeleteUserWithOffboarding}.
 * - **Notes:** OAuth signup hashes email lowercased to populate `email_hash` for case-insensitive
 *   lookups; case search is `LIKE %term%` over email + name with backslash-escaped patterns.
 */
export class UserRepository {
  async findByPublicId(public_id: string) {
    const rows = await getRequestDatabase()
      .select()
      .from(users)
      .where(and(eq(users.public_id, public_id), isNull(users.deleted_at)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Resolves `auth.users.public_id` → internal id, and nothing else.
   *
   * @remarks
   * Goes through the `auth.resolve_user_id_by_public_id` SECURITY DEFINER resolver rather than a
   * direct SELECT, so it works from ANY database context — including one whose GUC names a
   * different user, or an organization-scoped context where `auth.users` (FORCE RLS, self-scoped)
   * would match zero rows. That is what lets a caller resolve the id inside the transaction it
   * already has open instead of paying for a second one; see
   * {@link UserService.resolveInternalIdByPublicId}. Returns `null` for an unknown or soft-deleted
   * user (the resolver filters `deleted_at IS NULL`).
   */
  async resolveInternalIdByPublicId(public_id: string): Promise<number | null> {
    const result = await getRequestDatabase().execute<{ id: string | number | null }>(
      sql`SELECT auth.resolve_user_id_by_public_id(${public_id}) AS id`,
    );
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as { id: string | number | null }[];
    const rawId = rows[0]?.id ?? null;
    return rawId === null ? null : Number(rawId);
  }

  /**
   * Resolves a user by email for the pre-session authentication phase (login, forgot-password,
   * webauthn auth-options, OAuth find-or-create). Goes through the `auth.resolve_user_*` SECURITY
   * DEFINER resolver because `auth.users` is FORCE RLS and no `app.current_user_public_id` is set yet — a
   * plain SELECT would resolve the owner policy to NULL and return zero rows, rejecting every login.
   */
  async findByEmail(email: string): Promise<UserRow | null> {
    const result = await getRequestDatabase().execute(
      sql`SELECT * FROM auth.resolve_user_for_authentication_by_email(${email})`,
    );
    const rows = extractResolverRows(result);
    return rows[0] ? mapResolverRowToUserRow(rows[0]) : null;
  }

  /**
   * Resolves a user by internal id for the pre-session token-consume flows (magic-link verify,
   * password reset, email verify) and session refresh — same FORCE RLS rationale as
   * {@link UserRepository.findByEmail}. Mirrors the historical no-`deleted_at`-filter behaviour.
   */
  async findById(identifier: number): Promise<UserRow | null> {
    const result = await getRequestDatabase().execute(
      sql`SELECT * FROM auth.resolve_user_by_internal_id(${identifier})`,
    );
    const rows = extractResolverRows(result);
    return rows[0] ? mapResolverRowToUserRow(rows[0]) : null;
  }

  async updatePassword(publicId: string, passwordHash: string) {
    const rows = await getRequestDatabase()
      .update(users)
      .set({
        password_hash: passwordHash,
        last_password_change_at: new Date(),
        updated_at: databaseNowTimestamp,
      })
      .where(and(eq(users.public_id, publicId), isNull(users.deleted_at)))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Sets `users.password_hash = NULL` for the given user (sec-r5-auth-session-info-1).
   *
   * @remarks
   * Called by {@link AuthMethodService.delete} when revoking a PASSWORD auth_method
   * row so the user-facing "I removed my password" view matches the auth view
   * (`POST /auth/login` no longer authenticates with the previous credential).
   * Pre-fix, removing the PASSWORD auth-method only flipped `auth_methods.revoked_at`
   * but left the stale hash on `auth.users`, so the credential remained valid.
   * Caller MUST be inside `withAppDatabaseContext (user scope)` so the FORCE-RLS owner-access
   * policy is satisfied.
   */
  async clearPasswordHash(publicId: string) {
    const rows = await getRequestDatabase()
      .update(users)
      .set({
        password_hash: null,
        last_password_change_at: new Date(),
        updated_at: databaseNowTimestamp,
      })
      .where(and(eq(users.public_id, publicId), isNull(users.deleted_at)))
      .returning();
    return rows[0] ?? null;
  }

  async updateEmailVerified(publicId: string) {
    const rows = await getRequestDatabase()
      .update(users)
      .set({
        is_email_verified: true,
        updated_at: databaseNowTimestamp,
      })
      .where(and(eq(users.public_id, publicId), isNull(users.deleted_at)))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Stamps `onboarding_completed_at` on first completion. Idempotent: the
   * `IS NULL` guard means a repeat call (double-submit, retry) is a no-op that
   * preserves the original timestamp rather than moving it forward.
   */
  async markOnboardingComplete(publicId: string) {
    const rows = await getRequestDatabase()
      .update(users)
      .set({
        onboarding_completed_at: databaseNowTimestamp,
        updated_at: databaseNowTimestamp,
      })
      .where(
        and(
          eq(users.public_id, publicId),
          isNull(users.deleted_at),
          isNull(users.onboarding_completed_at),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  private async updateByPublicId(
    public_id: string,
    data: Record<string, unknown>,
  ): Promise<typeof users.$inferSelect | null> {
    const rows = await getRequestDatabase()
      .update(users)
      .set({
        ...data,
        updated_at: databaseNowTimestamp,
      })
      .where(and(eq(users.public_id, public_id), isNull(users.deleted_at)))
      .returning();
    return rows[0] ?? null;
  }

  async update(
    public_id: string,
    data: {
      first_name?: string | null;
      last_name?: string | null;
      job_title?: string | null;
      avatar_url?: string | null;
    },
  ) {
    return this.updateByPublicId(public_id, data as Record<string, unknown>);
  }

  /**
   * Inserts a user from an OAuth profile (no password) with a caller-supplied `public_id`.
   *
   * Public-id generation, unique-collision retry, and the `withAppDatabaseContext (user scope)` wrapper that
   * satisfies the FORCE RLS owner WITH CHECK (`public_id = app.current_user_public_id`) live in
   * {@link UserService.createFromOAuth}: the context must be set to the exact `public_id` used for
   * the insert, so the service owns the generate → enter-context → insert sequence per attempt.
   */
  async insertOAuthUser(
    publicId: string,
    data: {
      email: string;
      first_name?: string;
      last_name?: string;
      avatar_url?: string;
      is_email_verified: boolean;
    },
  ) {
    const emailHash = createHash('sha256').update(data.email.toLowerCase()).digest('hex');
    const rows = await getRequestDatabase()
      .insert(users)
      .values({
        public_id: publicId,
        email: data.email,
        email_hash: emailHash,
        first_name: data.first_name ?? null,
        last_name: data.last_name ?? null,
        avatar_url: data.avatar_url ?? null,
        is_email_verified: data.is_email_verified,
        status: 'ACTIVE',
      })
      .returning();
    return rows[0]!;
  }

  // ── Admin methods ──────────────────────────────────────────

  async findMany(pagination: UserListPagination) {
    const { after, limit, status, search } = pagination;
    const includeTotal = pagination.include_total === true;
    const filterConditions: SQL[] = [isNull(users.deleted_at)];
    if (status) {
      filterConditions.push(eq(users.status, status));
    }
    if (search) {
      // audit #13: case-INSENSITIVE search (was `like` — "john" missed "John") targeting the
      // trigram-indexed shapes so the GIN indexes are actually used instead of a full seq scan:
      // `email` engages idx_users_email_trgm; the concatenated display-name expression must match
      // idx_users_display_name_trgm verbatim. `escapeLikePattern` neutralises %/_ (injection-safe).
      const pattern = `%${escapeLikePattern(search)}%`;
      const displayName = sql`(coalesce(${users.first_name}, '') || ' ' || coalesce(${users.last_name}, ''))`;
      filterConditions.push(or(ilike(users.email, pattern), sql`${displayName} ILIKE ${pattern}`)!);
    }
    const countWhere = and(...filterConditions);
    const cursorCondition = buildAscendingCreatedAtIdCursorCondition(
      users.created_at,
      users.id,
      parseListCursor(after),
    );
    const where =
      cursorCondition !== undefined ? and(...filterConditions, cursorCondition) : countWhere;

    // Fetch one extra row so has_more is accurate without depending on count(*).
    const rowsPromise = getRequestDatabase()
      .select()
      .from(users)
      .where(where)
      .orderBy(asc(users.created_at), asc(users.id))
      .limit(limit + 1);

    const countPromise = includeTotal
      ? countWithCap({ database: getRequestDatabase(), table: users, where: countWhere })
      : Promise.resolve(null);

    const [fetchedRows, total] = await Promise.all([rowsPromise, countPromise]);
    const hasMore = fetchedRows.length > limit;
    const items = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
    const lastItem = items.at(-1);
    const nextCursor =
      hasMore && lastItem !== undefined ? createOpaqueCursorFromRow(lastItem) : null;
    return {
      items,
      total,
      limit,
      has_more: hasMore,
      next_cursor: nextCursor,
    };
  }

  async adminUpdate(
    public_id: string,
    data: { first_name?: string | null; last_name?: string | null; status?: string },
  ) {
    return this.updateByPublicId(public_id, data as Record<string, unknown>);
  }

  async suspend(public_id: string) {
    const rows = await getRequestDatabase()
      .update(users)
      .set({ status: 'SUSPENDED', updated_at: databaseNowTimestamp })
      .where(and(eq(users.public_id, public_id), isNull(users.deleted_at)))
      .returning();
    return rows[0] ?? null;
  }

  async unsuspend(public_id: string) {
    const rows = await getRequestDatabase()
      .update(users)
      .set({ status: 'ACTIVE', updated_at: databaseNowTimestamp })
      .where(and(eq(users.public_id, public_id), isNull(users.deleted_at)))
      .returning();
    return rows[0] ?? null;
  }

  async markDeletionStarted(public_id: string) {
    const rows = await getRequestDatabase()
      .update(users)
      .set({ deletion_started_at: databaseNowTimestamp, updated_at: databaseNowTimestamp })
      .where(and(eq(users.public_id, public_id), isNull(users.deleted_at)))
      .returning();
    return rows[0] ?? null;
  }

  async softDelete(public_id: string) {
    const rows = await getRequestDatabase()
      .update(users)
      .set({ deleted_at: databaseNowTimestamp, updated_at: databaseNowTimestamp })
      .where(
        and(
          eq(users.public_id, public_id),
          isNull(users.deleted_at),
          isNotNull(users.deletion_started_at),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async updateLoginAttempt(
    publicId: string,
    failedLoginCount: number,
    accountLockedUntil: Date | null,
  ) {
    const rows = await getRequestDatabase()
      .update(users)
      .set({
        failed_login_count: failedLoginCount,
        account_locked_until: accountLockedUntil,
        updated_at: databaseNowTimestamp,
      })
      .where(and(eq(users.public_id, publicId), isNull(users.deleted_at)))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Atomically record one failed login: increment `failed_login_count` in SQL
   * (`count + 1`, never a read-modify-write) and, in the same statement, set the
   * lockout window once the new count reaches `maxAttempts`. Computing both from
   * the live row value eliminates the lost-update race where two simultaneous
   * failures each read the same stale count and write back the same `+1`.
   */
  async incrementFailedLoginAttempt(
    publicId: string,
    options: { maxAttempts: number; lockoutMinutes: number },
  ) {
    const rows = await getRequestDatabase()
      .update(users)
      .set({
        // COALESCE keeps the +1 null-safe (the column is NOT NULL today, but this preserves the
        // old `(count ?? 0) + 1` intent and is correct regardless of the row's prior value).
        failed_login_count: sql`COALESCE(${users.failed_login_count}, 0) + 1`,
        account_locked_until: sql`CASE
          WHEN COALESCE(${users.failed_login_count}, 0) + 1 >= ${options.maxAttempts}
          THEN now() + make_interval(mins => ${options.lockoutMinutes})
          ELSE ${users.account_locked_until}
        END`,
        updated_at: databaseNowTimestamp,
      })
      .where(and(eq(users.public_id, publicId), isNull(users.deleted_at)))
      .returning();
    return rows[0] ?? null;
  }

  async updateMfaEnabled(publicId: string, enabled: boolean) {
    const rows = await getRequestDatabase()
      .update(users)
      .set({ is_mfa_enabled: enabled, updated_at: databaseNowTimestamp })
      .where(and(eq(users.public_id, publicId), isNull(users.deleted_at)))
      .returning();
    return rows[0] ?? null;
  }
}
