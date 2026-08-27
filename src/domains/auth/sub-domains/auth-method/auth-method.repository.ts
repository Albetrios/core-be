import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { DEFAULT_REPOSITORY_LIST_LIMIT } from '@/shared/constants/query-limits.constants.js';
import { capListWithWarning } from '@/shared/utils/infrastructure/list-cap.util.js';
import { auth_methods } from '@/domains/auth/sub-domains/auth-method/auth-method.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { AuthMethodCreateData, AuthMethodProviderLookup } from './auth-method.types.js';

/**
 * Postgres advisory-lock namespace (`classid`, ASCII `ACRD`) serializing per-user credential
 * mutations. Combined with a positive int4 hash of the user's internal id as `objid` in the two-key
 * `pg_advisory_xact_lock(classid, objid)` form so it occupies a distinct lock space from other
 * advisory locks (e.g. the upload-quota namespace). The hash keeps `bigserial` ids beyond int4's
 * 2.1B max from overflowing the int4 `objid` (B-1). Only its stability matters.
 */
const CREDENTIAL_MUTATION_ADVISORY_LOCK_NAMESPACE = 0x41_43_52_44;

/** Drizzle repository for the {@link auth_methods} table; reads and writes use the request-scoped database handle so Postgres RLS enforces organization isolation. Soft-deletes via `revoked_at` rather than physical deletion. */
export class AuthMethodRepository {
  async listByUserId(userId: number) {
    // audit #36: bound this user-self-scoped read (limit+1 + capListWithWarning).
    const rows = await getRequestDatabase()
      .select()
      .from(auth_methods)
      .where(and(eq(auth_methods.user_id, userId), isNull(auth_methods.revoked_at)))
      .limit(DEFAULT_REPOSITORY_LIST_LIMIT + 1);
    return capListWithWarning({
      rows,
      limit: DEFAULT_REPOSITORY_LIST_LIMIT,
      resource: 'auth.auth_methods',
      context: { userId },
    });
  }

  async countActiveByUserId(userId: number): Promise<number> {
    const rows = await getRequestDatabase()
      .select({ value: sql<number>`count(*)::int` })
      .from(auth_methods)
      .where(and(eq(auth_methods.user_id, userId), isNull(auth_methods.revoked_at)));
    return rows[0]?.value ?? 0;
  }

  async listMfaByUserId(userId: number) {
    // audit #36: bound this user-self-scoped read (limit+1 + capListWithWarning).
    const rows = await getRequestDatabase()
      .select()
      .from(auth_methods)
      .where(
        and(
          eq(auth_methods.user_id, userId),
          eq(auth_methods.method_type, 'MFA_TOTP'),
          isNull(auth_methods.revoked_at),
        ),
      )
      .limit(DEFAULT_REPOSITORY_LIST_LIMIT + 1);
    return capListWithWarning({
      rows,
      limit: DEFAULT_REPOSITORY_LIST_LIMIT,
      resource: 'auth.auth_methods.mfa',
      context: { userId },
    });
  }

  async findTotpByUserId(userId: number) {
    // sec-re-04: ORDER BY ensures `limit(1)` returns the most-recently created active
    // TOTP row when historical duplicates exist (which the new partial UNIQUE index
    // prevents going forward). Without an explicit order, Postgres returned an
    // arbitrary row and login could land on a stale secret the user no longer holds —
    // soft-locking re-enrolled accounts.
    const rows = await getRequestDatabase()
      .select()
      .from(auth_methods)
      .where(
        and(
          eq(auth_methods.user_id, userId),
          eq(auth_methods.method_type, 'MFA_TOTP'),
          isNull(auth_methods.revoked_at),
        ),
      )
      .orderBy(desc(auth_methods.created_at), desc(auth_methods.id))
      .limit(1);
    return rows[0] ?? null;
  }

  async updateLastUsedAt(id: number, userId: number) {
    const rows = await getRequestDatabase()
      .update(auth_methods)
      .set({ last_used_at: new Date() })
      .where(and(eq(auth_methods.id, id), eq(auth_methods.user_id, userId)))
      .returning();
    return rows[0] ?? null;
  }

  async findByIdForUser(id: number, userId: number) {
    const rows = await getRequestDatabase()
      .select()
      .from(auth_methods)
      .where(
        and(
          eq(auth_methods.id, id),
          eq(auth_methods.user_id, userId),
          isNull(auth_methods.revoked_at),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Resolves a single active auth-method row by its opaque `public_id` for the
   * authenticated delete flow (sec-new-B4). Returns `null` when no matching
   * non-revoked row exists for this user.
   */
  async findByPublicIdForUser(publicId: string, userId: number) {
    const rows = await getRequestDatabase()
      .select()
      .from(auth_methods)
      .where(
        and(
          eq(auth_methods.public_id, publicId),
          eq(auth_methods.user_id, userId),
          isNull(auth_methods.revoked_at),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Resolves a linked credential by `(provider, provider_user_id)` for the pre-session OAuth
   * callback via the `auth.resolve_auth_method_by_provider` SECURITY DEFINER resolver. `auth_methods`
   * is FORCE RLS and the callback has no `app.current_user_public_id` yet, so a plain SELECT would resolve
   * the owner policy to NULL and return zero rows. Returns the row plus the owning `user_public_id`.
   */
  async findByProviderUserId(
    provider: string,
    providerUserId: string,
  ): Promise<AuthMethodProviderLookup | null> {
    const result = await getRequestDatabase().execute(
      sql`SELECT * FROM auth.resolve_auth_method_by_provider(${provider}, ${providerUserId})`,
    );
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return null;
    // Explicit field mapping (no blanket `as unknown` cast): the row is an untyped SQL-function
    // result, so map each field by name — a future change to AuthMethodProviderLookup then fails
    // the compile here instead of silently drifting.
    return {
      id: Number(row.id),
      user_id: Number(row.user_id),
      user_public_id: String(row.user_public_id),
      method_type: String(row.method_type),
      provider: (row.provider as string | null) ?? null,
      provider_user_id: (row.provider_user_id as string | null) ?? null,
      is_primary: Boolean(row.is_primary),
      verified_at: (row.verified_at as Date | null) ?? null,
      last_used_at: (row.last_used_at as Date | null) ?? null,
      created_at: (row.created_at as Date | null) ?? null,
      revoked_at: (row.revoked_at as Date | null) ?? null,
    };
  }

  /** Inserts a new auth-method row, auto-generating a crypto-secure `public_id` (sec-new-B4). */
  async create(data: AuthMethodCreateData) {
    const rows = await getRequestDatabase()
      .insert(auth_methods)
      .values({ ...data, public_id: generatePublicId('authMethod') })
      .returning();
    return rows[0]!;
  }

  async revoke(id: number, userId: number) {
    const rows = await getRequestDatabase()
      .update(auth_methods)
      .set({ revoked_at: new Date() })
      .where(and(eq(auth_methods.id, id), eq(auth_methods.user_id, userId)))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Atomically revokes an auth method, refusing to revoke the user's LAST login-capable credential.
   *
   * @remarks
   * The "is there another login-capable method?" check and the revoke happen in ONE `UPDATE`
   * statement (an `EXISTS` sub-select over the user's other active rows), so two concurrent deletes
   * cannot each read "one other method left" and both succeed — the count-then-act lockout race
   * (route-audit C1). Returns the revoked row, or `null` when the row is already gone/revoked OR
   * revoking it would leave the user with zero login-capable methods. Pass the login-capable
   * `method_type` values so the repository need not depend on the service's policy constant.
   */
  /**
   * Takes a transaction-scoped advisory lock serializing concurrent credential mutations for one
   * user. Released automatically at COMMIT/ROLLBACK, so it must be acquired inside the same
   * `withUserDatabaseContext` transaction as a subsequent count-then-mutate (e.g. the MFA-delete
   * "would this remove the last factor?" check), closing that race (route-audit C1 / deleteMfa).
   */
  async acquireCredentialMutationLock(userId: number): Promise<void> {
    await getRequestDatabase().execute(
      sql`SELECT pg_advisory_xact_lock(${CREDENTIAL_MUTATION_ADVISORY_LOCK_NAMESPACE}::int, (hashtextextended(${userId}::text, 0) & 2147483647::bigint)::int)`,
    );
  }

  async revokeUnlessLastLoginCapable(
    id: number,
    userId: number,
    loginCapableMethodTypes: readonly string[],
  ) {
    const loginCapableList = sql.join(
      loginCapableMethodTypes.map((methodType) => sql`${methodType}`),
      sql`, `,
    );
    const rows = await getRequestDatabase()
      .update(auth_methods)
      .set({ revoked_at: new Date() })
      .where(
        and(
          eq(auth_methods.id, id),
          eq(auth_methods.user_id, userId),
          isNull(auth_methods.revoked_at),
          sql`(
            ${auth_methods.method_type} NOT IN (${loginCapableList})
            OR EXISTS (
              SELECT 1
              FROM ${auth_methods} AS other
              WHERE other.user_id = ${userId}
                AND other.id <> ${id}
                AND other.revoked_at IS NULL
                AND other.method_type IN (${loginCapableList})
            )
          )`,
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async revokeAllByUserId(userId: number): Promise<number> {
    const rows = await getRequestDatabase()
      .update(auth_methods)
      .set({ revoked_at: new Date() })
      .where(and(eq(auth_methods.user_id, userId), isNull(auth_methods.revoked_at)))
      .returning({ id: auth_methods.id });
    return rows.length;
  }
}
