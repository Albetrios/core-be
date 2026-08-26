import { database } from '@/infrastructure/database/connection.js';
import {
  runWithPinnedDatabaseHandle,
  setLocalDatabaseConfig,
  type RequestScopedPostgresDatabase,
} from '@/infrastructure/database/contexts/request-database.context.js';
import { runWithWorkerDatabaseContext } from '@/infrastructure/database/contexts/worker-database.context.js';
import {
  brandWorkerContextDatabaseHandle,
  type WorkerContextDatabaseHandle,
} from '@/infrastructure/database/utils/database-handle.types.js';
import { createScopeGuardedDatabaseHandle } from '@/infrastructure/database/contexts/scope-guarded-database-handle.util.js';

/**
 * Runs a callback inside a transaction with `SET LOCAL app.global_admin = true` so cross-user admin
 * and system flows can read/write FORCE RLS tables under the non-superuser `core_be_app` role —
 * including `auth.users`, `auth.auth_methods`, and cross-tenant `audit.logs` reads (admin audit
 * listing, user suspend/soft-delete, cross-user actor lookups).
 *
 * @remarks
 * - **Algorithm:** opens a fresh transaction, sets the `app.global_admin` GUC with `SET LOCAL`
 *   (auto-reset at transaction end), and pins the handle in ALS so `getRequestDatabase()` resolves
 *   to it for the duration of the callback. The handle is scope-guarded — using it after the
 *   callback settles throws.
 * - **Failure modes:** propagates any error from the callback; the surrounding transaction rolls
 *   back, discarding the GUC.
 * - **Side effects:** opens a database transaction and toggles the admin RLS escape hatch for its
 *   lifetime.
 * - **SECURITY:** `app.global_admin = 'true'` bypasses per-user / per-tenant isolation on protected
 *   tables (including `auth.users`, `auth.auth_methods`, and cross-tenant `audit.logs`). This
 *   wrapper MUST only be entered from code paths that have already
 *   authorized the caller as a global admin (HTTP routes guarded by `requireRole(SUPER_ADMIN,
 *   ADMIN)`) or from trusted system/offboarding code. Never call it on an unauthenticated or
 *   self-service request path. Tests connected as a privileged owner role apply `SET LOCAL ROLE`
 *   themselves via `src/tests/helpers/application-database-role.helper.ts`.
 */
export async function withGlobalAdminDatabaseContext<T>(
  callback: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
): Promise<T> {
  return runWithWorkerDatabaseContext({ kind: 'global_admin' }, () =>
    database.transaction(async (transaction) => {
      const rawDatabaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
      await setLocalDatabaseConfig(rawDatabaseHandle, 'app.global_admin', 'true');
      const guard = createScopeGuardedDatabaseHandle(rawDatabaseHandle);
      try {
        return await runWithPinnedDatabaseHandle(guard.databaseHandle, () =>
          callback(brandWorkerContextDatabaseHandle(guard.databaseHandle)),
        );
      } finally {
        guard.dispose();
      }
    }),
  );
}
