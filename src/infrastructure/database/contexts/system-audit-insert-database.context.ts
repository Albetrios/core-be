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
 * Runs a callback inside a transaction with `SET LOCAL app.system_audit_insert = 'true'`
 * so emitters that record tenantless system events (DLQ auto-retry and
 * manual replay today; future scheduled-job / retention-emit paths reviewed
 * under this comment) can INSERT into `audit.logs` without a tenant GUC.
 *
 * @remarks
 * - **Algorithm:** opens a single transaction so `SET LOCAL` is scoped tightly,
 *   sets the system-audit-insert GUC, and delegates to the callback under a
 *   pinned worker handle.
 * - **Failure modes:** transaction rolls back if the callback throws; the GUC
 *   is released by the transaction boundary.
 * - **Side effects:** opens and closes one Postgres transaction. The GUC is
 *   not session-scoped (would escape the pool on checkout).
 * - **Notes:** the `audit.logs` INSERT policy gates this GUC by ALSO requiring
 *   `organization_id IS NULL` (sec-r5-async-queue-1 / sec-r4-D1). The
 *   combination prevents the system-audit context from impersonating a
 *   tenant — it can only emit tenantless rows.
 */
export async function withSystemAuditInsertContext<T>(
  callback: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
): Promise<T> {
  return runWithWorkerDatabaseContext({ kind: 'system_table' }, () =>
    database.transaction(async (transaction) => {
      const rawDatabaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
      await setLocalDatabaseConfig(rawDatabaseHandle, 'app.system_audit_insert', 'true');
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
