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
 * Runs a callback inside a Postgres transaction with the worker statement-timeout
 * applied, using the `system_table` context kind. Use for retention workers that
 * perform pure-DB bulk operations on non-tenant tables (e.g.
 * `billing.stripe_webhook_events`) where no tenant GUC is required.
 *
 * @remarks
 * - **Algorithm:** Opens a transaction so `SET LOCAL statement_timeout` is
 *   effective (a session-level `SET` would escape the pooled connection on
 *   checkout). Mirrors {@link withGlobalRetentionCleanupDatabaseContext} but
 *   targets non-FORCE-RLS tables and skips the `app.global_retention_cleanup` GUC.
 * - **Failure modes:** Transaction rolls back if the callback throws; the
 *   `statement_timeout` is scoped to this transaction and does not outlive it.
 * - **Side effects:** Opens and closes one Postgres transaction per job; emits
 *   `SET LOCAL statement_timeout` before delegating to the callback.
 * - **Notes:** Do NOT use this wrapper for callers that make external HTTP or
 *   Redis I/O (Resend, BullMQ enqueue, Stripe) — those belong under
 *   {@link withSystemTableWorkerContext}, which does not hold a connection
 *   across external I/O. This variant is only safe for pure-DB callbacks
 *   (sec-new-Q4).
 */
export async function withSystemTableRetentionContext<T>(
  callback: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
): Promise<T> {
  return runWithWorkerDatabaseContext({ kind: 'system_table' }, () =>
    database.transaction(async (transaction) => {
      const rawDatabaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
      await applyWorkerStatementTimeout(rawDatabaseHandle);
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

/**
 * Runs a callback inside a transaction with `SET LOCAL app.global_retention_cleanup = true`
 * so tombstone and cross-tenant retention workers can access FORCE RLS tables under `core_be_app`.
 *
 * @remarks
 * - **SECURITY:** this GUC is an RLS bypass — every tenant policy ORs it in. Only
 *   retention/tombstone workers may enter this wrapper; never call it from a
 *   request path. Tests that connect as a privileged owner role and need the
 *   application role apply `SET LOCAL ROLE` themselves as the first statement of
 *   the callback (see `src/tests/helpers/application-database-role.helper.ts`).
 * - **Failure modes:** transaction rolls back if the callback throws; the GUC dies
 *   with the transaction. The callback's handle is scope-guarded — use after the
 *   callback settles throws.
 */
export async function withGlobalRetentionCleanupDatabaseContext<T>(
  callback: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
): Promise<T> {
  return runWithWorkerDatabaseContext({ kind: 'global_retention_cleanup' }, () =>
    database.transaction(async (transaction) => {
      const rawDatabaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
      // sec-D2: lift the connection-level HTTP statement_timeout (5 s) for
      // background work — retention deletes that cascade through audit/
      // session tables would otherwise be killed mid-statement.
      await applyWorkerStatementTimeout(rawDatabaseHandle);
      await setLocalDatabaseConfig(rawDatabaseHandle, 'app.global_retention_cleanup', 'true');
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

/**
 * Allows cross-user session retention deletes from the cleanup worker
 * (`SET LOCAL app.session_retention_cleanup = 'true'`).
 *
 * @remarks
 * - **SECURITY:** cross-user bypass on `auth.sessions` — worker-only, retention
 *   sibling of {@link withGlobalRetentionCleanupDatabaseContext}; never call it
 *   from a request path.
 * - **Notes:** sec-D2 — worker-only wrapper, so the HTTP 5 s statement_timeout is
 *   lifted so the cascade-delete does not abort on production-sized session tables.
 */
export async function withSessionRetentionCleanupDatabaseContext<T>(
  callback: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
): Promise<T> {
  return runWithWorkerDatabaseContext({ kind: 'session_retention_cleanup' }, () =>
    database.transaction(async (transaction) => {
      const rawDatabaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
      await applyWorkerStatementTimeout(rawDatabaseHandle);
      await setLocalDatabaseConfig(rawDatabaseHandle, 'app.session_retention_cleanup', 'true');
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
