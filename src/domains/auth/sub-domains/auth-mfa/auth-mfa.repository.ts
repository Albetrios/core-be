import { and, desc, eq, isNull } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { DEFAULT_REPOSITORY_LIST_LIMIT } from '@/shared/constants/query-limits.constants.js';
import { capListWithWarning } from '@/shared/utils/infrastructure/list-cap.util.js';
import { auth_methods } from '@/domains/auth/sub-domains/auth-method/auth-method.schema.js';

/**
 * MFA repository — queries the auth_methods table filtered for MFA method types.
 * Will be migrated to a dedicated mfa_methods table in Phase 2.
 */
export class MfaRepository {
  async findTotpByUserId(userId: number) {
    // sec-re-04: ORDER BY ensures `limit(1)` returns the most-recently created active
    // TOTP row when historical duplicates exist (which the new partial UNIQUE index
    // prevents going forward). Without an explicit order, Postgres returned an
    // arbitrary row and login could land on a stale secret the user no longer holds.
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

  async listMfaByUserId(userId: number) {
    // audit #36: bound this user-self-scoped read (limit+1 + capListWithWarning).
    const rows = await getRequestDatabase()
      .select({
        id: auth_methods.id,
        method_type: auth_methods.method_type,
        last_used_at: auth_methods.last_used_at,
        created_at: auth_methods.created_at,
      })
      .from(auth_methods)
      .where(and(eq(auth_methods.user_id, userId), isNull(auth_methods.revoked_at)))
      .limit(DEFAULT_REPOSITORY_LIST_LIMIT + 1);
    return capListWithWarning({
      rows,
      limit: DEFAULT_REPOSITORY_LIST_LIMIT,
      resource: 'auth.mfa_methods',
      context: { userId },
    });
  }

  async findByIdForUser(methodId: number, userId: number) {
    const rows = await getRequestDatabase()
      .select()
      .from(auth_methods)
      .where(
        and(
          eq(auth_methods.id, methodId),
          eq(auth_methods.user_id, userId),
          isNull(auth_methods.revoked_at),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async updateLastUsedAt(methodId: number, userId: number) {
    const rows = await getRequestDatabase()
      .update(auth_methods)
      .set({ last_used_at: new Date() })
      .where(and(eq(auth_methods.id, methodId), eq(auth_methods.user_id, userId)))
      .returning();
    return rows[0] ?? null;
  }

  async revoke(methodId: number, userId: number) {
    const rows = await getRequestDatabase()
      .update(auth_methods)
      .set({ revoked_at: new Date() })
      .where(
        and(
          eq(auth_methods.id, methodId),
          eq(auth_methods.user_id, userId),
          isNull(auth_methods.revoked_at),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }
}
