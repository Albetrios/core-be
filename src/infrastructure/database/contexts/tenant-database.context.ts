import { sql as drizzleSql } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import {
  getOrganizationRequestDatabaseSession,
  runWithPinnedOrganizationDatabaseSession,
  type RequestScopedPostgresDatabase,
} from '@/infrastructure/database/contexts/request-database.context.js';
import {
  isWorkerRuntime,
  runWithWorkerDatabaseContext,
  workerDatabaseContextForOrganization,
} from '@/infrastructure/database/contexts/worker-database.context.js';
import {
  decrementOrganizationRlsCheckoutCount,
  incrementOrganizationRlsCheckoutCount,
  observeOrganizationRlsCheckoutHold,
} from '@/infrastructure/database/pool/organization-rls-checkout-counter.js';
import {
  brandWorkerContextDatabaseHandle,
  type WorkerContextDatabaseHandle,
} from '@/infrastructure/database/utils/database-handle.types.js';
import { applyWorkerStatementTimeout } from '@/infrastructure/database/contexts/worker-statement-timeout.util.js';

/**
 * Runs a callback inside a transaction with RLS organization context set via SET LOCAL.
 * Use for workers/scripts that must enforce tenant isolation at the database layer.
 *
 * When the caller is already inside an HTTP request scoped by
 * `organization-rls-transaction.middleware` for the same `organizationPublicId`, this
 * reuses the active Drizzle handle instead of opening a nested top-level transaction
 * (which would use another pool checkout and lose the outer `SET LOCAL`).
 *
 * The callback receives the pinned `databaseHandle` — pass it into worker repositories
 * via `createWorker*Repository(databaseHandle)` factories.
 */
export async function withOrganizationContext<T>(
  organizationPublicId: string,
  callback: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
): Promise<T> {
  const activeSession = getOrganizationRequestDatabaseSession();
  if (activeSession !== undefined && activeSession.organizationPublicId === organizationPublicId) {
    return runWithWorkerDatabaseContext(
      workerDatabaseContextForOrganization(organizationPublicId),
      () => callback(brandWorkerContextDatabaseHandle(activeSession.databaseHandle)),
    );
  }

  // A fresh top-level transaction acquires its own pooled checkout — count it so the
  // pool-exhaustion alerter and `database_rls_checkout_hold_seconds` histogram observe
  // scoped units of work (the default `DATABASE_RLS_SCOPED_CONTEXTS=true` path). Reused
  // sessions above share the caller's checkout and are intentionally not counted.
  incrementOrganizationRlsCheckoutCount();
  const checkoutStartedAtNanoseconds = process.hrtime.bigint();
  try {
    return await runWithWorkerDatabaseContext(
      workerDatabaseContextForOrganization(organizationPublicId),
      () =>
        database.transaction(async (transaction) => {
          const databaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
          await databaseHandle.execute(
            drizzleSql`SELECT set_config('app.current_organization_id', ${organizationPublicId}, true)`,
          );
          // sec-re-16: lift the HTTP 5s `statement_timeout` to the worker budget
          // so tenant-scoped worker jobs match the policy applied by sibling
          // context wrappers (`withGlobalRetentionCleanupDatabaseContext`,
          // `withUserDatabaseContext`). Worker runtime only: this wrapper also
          // serves every HTTP-path `withOrganizationDatabaseContext` unit of
          // work, which must keep the connection-level HTTP caps — lifting
          // them here would let one pathological request hold a pool checkout
          // for the full worker budget.
          if (isWorkerRuntime()) {
            await applyWorkerStatementTimeout(databaseHandle);
          }
          return runWithPinnedOrganizationDatabaseSession(
            organizationPublicId,
            databaseHandle,
            () => callback(brandWorkerContextDatabaseHandle(databaseHandle)),
          );
        }),
    );
  } finally {
    decrementOrganizationRlsCheckoutCount();
    observeOrganizationRlsCheckoutHold({
      path: 'scoped_context',
      durationSeconds:
        Number(process.hrtime.bigint() - checkoutStartedAtNanoseconds) / 1_000_000_000,
    });
  }
}
