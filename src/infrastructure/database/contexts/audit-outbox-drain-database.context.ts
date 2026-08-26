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
import { applyWorkerStatementTimeout } from '@/infrastructure/database/contexts/worker-statement-timeout.util.js';
import { createScopeGuardedDatabaseHandle } from '@/infrastructure/database/contexts/scope-guarded-database-handle.util.js';

/**
 * Runs `callback` inside a single Postgres transaction with
 * `SET LOCAL app.audit_outbox_drain = 'true'`, the worker statement-timeout, and the
 * `audit_outbox_drain` worker context kind pinned in ALS. This is the ONLY context
 * permitted to SELECT / UPDATE / DELETE rows in `audit.outbox` (RLS policies in
 * the table migration enforce that gate).
 *
 * @remarks
 * - **Algorithm:** Opens a transaction (so `SET LOCAL` works), applies the worker
 *   statement-timeout, sets the drain GUC, then runs `callback` with the pinned
 *   transaction handle. The drain worker layers `app.current_organization_id`
 *   (or `app.system_audit_insert`) on top of this GUC per outbox row so the
 *   eventual `audit.logs` INSERT passes RLS.
 * - **Failure modes:** Any thrown error rolls back the whole drain batch — the
 *   outbox rows stay PENDING and the next drain pass re-attempts them, which is
 *   correct because the audit.logs INSERT side has not committed either.
 * - **Side effects:** Opens / closes one Postgres transaction.
 * - **Notes:** Used only by {@link auditOutboxDrainProcessor}. Do not use from
 *   request handlers — the drain GUC must never be set during user-facing
 *   requests because it grants cross-tenant SELECT on `audit.outbox`.
 */
export async function withAuditOutboxDrainDatabaseContext<T>(
  callback: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
): Promise<T> {
  return runWithWorkerDatabaseContext({ kind: 'audit_outbox_drain' }, () =>
    database.transaction(async (transaction) => {
      const rawDatabaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
      await applyWorkerStatementTimeout(rawDatabaseHandle);
      await setLocalDatabaseConfig(rawDatabaseHandle, 'app.audit_outbox_drain', 'true');
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
