import { database } from '@/infrastructure/database/connection.js';
import {
  getOrganizationRequestDatabaseSession,
  runWithPinnedDatabaseHandle,
  setLocalDatabaseConfig,
  type RequestScopedPostgresDatabase,
} from '@/infrastructure/database/contexts/request-database.context.js';
import {
  runWithWorkerDatabaseContext,
  workerDatabaseContextForUser,
} from '@/infrastructure/database/contexts/worker-database.context.js';
import {
  brandWorkerContextDatabaseHandle,
  type WorkerContextDatabaseHandle,
} from '@/infrastructure/database/utils/database-handle.types.js';
import { createScopeGuardedDatabaseHandle } from '@/infrastructure/database/contexts/scope-guarded-database-handle.util.js';

/**
 * Sets `app.current_user_id` (auth.users public_id) for user-scoped RLS policies.
 *
 * @remarks
 * Reuses ANY pinned ALS database handle when one is present — the active organization
 * RLS transaction, or a plain pinned transaction such as the OAuth find-or-create flow
 * (`runWithPinnedDatabaseHandle`). Reusing the pinned handle (rather than opening a fresh
 * transaction on a second pooled connection) is required under FORCE RLS on `auth.users` /
 * `auth.auth_methods` / `auth.sessions`: those tables FK and RLS-subquery a row (the user)
 * that may be uncommitted in the surrounding transaction, so a second connection could neither
 * see it (FK / RLS subquery) nor preserve atomicity. Only when no handle is pinned (e.g. a
 * plain authenticated HTTP request without `X-Organization-Id`) does it open its own
 * transaction. `SET LOCAL` resets at transaction end, matching the existing org-session path.
 * Fresh transactions hand the callback a scope-guarded handle — using it after the
 * callback settles throws instead of silently querying outside the transaction.
 */
export async function withUserDatabaseContext<T>(
  userPublicId: string,
  callback: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
): Promise<T> {
  return runWithWorkerDatabaseContext(workerDatabaseContextForUser(userPublicId), async () => {
    const pinnedSession = getOrganizationRequestDatabaseSession();
    if (pinnedSession) {
      await setLocalDatabaseConfig(
        pinnedSession.databaseHandle,
        'app.current_user_id',
        userPublicId,
      );
      return callback(brandWorkerContextDatabaseHandle(pinnedSession.databaseHandle));
    }

    return database.transaction(async (transaction) => {
      const rawDatabaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
      await setLocalDatabaseConfig(rawDatabaseHandle, 'app.current_user_id', userPublicId);
      const guard = createScopeGuardedDatabaseHandle(rawDatabaseHandle);
      try {
        return await runWithPinnedDatabaseHandle(guard.databaseHandle, () =>
          callback(brandWorkerContextDatabaseHandle(guard.databaseHandle)),
        );
      } finally {
        guard.dispose();
      }
    });
  });
}

/**
 * Sets `app.current_session_public_id` for cookie-based refresh (no JWT yet).
 */
export async function withSessionPublicIdDatabaseContext<T>(
  sessionPublicId: string,
  callback: (databaseHandle: RequestScopedPostgresDatabase) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    const rawDatabaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
    await setLocalDatabaseConfig(
      rawDatabaseHandle,
      'app.current_session_public_id',
      sessionPublicId,
    );
    const guard = createScopeGuardedDatabaseHandle(rawDatabaseHandle);
    try {
      return await runWithPinnedDatabaseHandle(guard.databaseHandle, () =>
        callback(guard.databaseHandle),
      );
    } finally {
      guard.dispose();
    }
  });
}

/**
 * Sets `app.current_session_token_hash` for bearer-token logout revocation.
 */
export async function withSessionTokenHashDatabaseContext<T>(
  tokenHash: string,
  callback: (databaseHandle: RequestScopedPostgresDatabase) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    const rawDatabaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
    await setLocalDatabaseConfig(rawDatabaseHandle, 'app.current_session_token_hash', tokenHash);
    const guard = createScopeGuardedDatabaseHandle(rawDatabaseHandle);
    try {
      return await runWithPinnedDatabaseHandle(guard.databaseHandle, () =>
        callback(guard.databaseHandle),
      );
    } finally {
      guard.dispose();
    }
  });
}
