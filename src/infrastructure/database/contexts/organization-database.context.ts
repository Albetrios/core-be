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
import { createScopeGuardedDatabaseHandle } from '@/infrastructure/database/contexts/scope-guarded-database-handle.util.js';

/**
 * Runs a callback inside a transaction with the organization RLS context set via
 * `SET LOCAL app.current_organization_id` — the single org-scoped unit-of-work
 * wrapper for services, controllers, and tenant-scoped workers.
 *
 * @remarks
 * - **Algorithm**: when the caller is already inside a pinned session for the SAME
 *   `organizationPublicId` (a worker context or a request-pinned organization
 *   transaction) the existing handle is reused — no nested top-level transaction,
 *   no extra pool checkout, no lost `SET LOCAL`. Otherwise a fresh transaction is
 *   opened, the GUC is set, and the handle is pinned in ALS for the callback.
 * - **Failure modes**: any error from the callback rolls the transaction back; the
 *   GUC dies with the transaction. The handle passed to the callback is
 *   scope-guarded — using it after the callback settles throws instead of silently
 *   querying without the tenant GUC.
 * - **Side effects**: fresh transactions take one pooled checkout, counted for the
 *   pool-exhaustion alerter and the `database_rls_checkout_hold_seconds` histogram.
 * - **Notes**: external I/O (Stripe, S3, Resend) must NOT run inside the callback —
 *   enforced by `src/tests/global/rls-context-network-isolation.global.test.ts`.
 *   Pass the handle into `createWorker*Repository(databaseHandle)` factories.
 */
export async function withOrganizationDatabaseContext<T>(
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
          const rawDatabaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
          await rawDatabaseHandle.execute(
            drizzleSql`SELECT set_config('app.current_organization_id', ${organizationPublicId}, true)`,
          );
          // sec-re-16: lift the HTTP 5s `statement_timeout` to the worker budget
          // so tenant-scoped worker jobs match the policy applied by sibling
          // context wrappers (`withGlobalRetentionCleanupDatabaseContext`,
          // `withUserDatabaseContext`). Worker runtime only: this wrapper also
          // serves every HTTP-path unit of work, which must keep the
          // connection-level HTTP caps — lifting them here would let one
          // pathological request hold a pool checkout for the full worker
          // budget (PR #1122).
          if (isWorkerRuntime()) {
            await applyWorkerStatementTimeout(rawDatabaseHandle);
          }
          const guard = createScopeGuardedDatabaseHandle(rawDatabaseHandle);
          try {
            return await runWithPinnedOrganizationDatabaseSession(
              organizationPublicId,
              guard.databaseHandle,
              () => callback(brandWorkerContextDatabaseHandle(guard.databaseHandle)),
            );
          } finally {
            guard.dispose();
          }
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
