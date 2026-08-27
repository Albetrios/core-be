import { sql as drizzleSql } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import {
  runWithPinnedDatabaseHandle,
  setLocalDatabaseConfig,
  type RequestScopedPostgresDatabase,
} from '@/infrastructure/database/contexts/request-database.context.js';
import {
  isWorkerRuntime,
  runWithWorkerDatabaseContext,
  type WorkerDatabaseContextKind,
} from '@/infrastructure/database/contexts/worker-database.context.js';
import {
  brandWorkerContextDatabaseHandle,
  type WorkerContextDatabaseHandle,
} from '@/infrastructure/database/utils/database-handle.types.js';
import { applyWorkerStatementTimeout } from '@/infrastructure/database/contexts/worker-statement-timeout.util.js';

/** One row of the maintenance-context registry — the GUC it arms and how its transaction is tuned. */
interface MaintenanceContextDefinition {
  /** The `app.*` GUC this kind sets to `'true'` — `null` for system-table kinds (non-RLS tables, no GUC). */
  readonly guc: string | null;
  /** Open a Postgres transaction (default behavior). `false` = pin the shared pool handle without a transaction — for callbacks that perform external I/O and must not hold a checkout across network calls. */
  readonly opensTransaction: boolean;
  /** ALS context kind pinned for worker-runtime assertions. */
  readonly workerContextKind: WorkerDatabaseContextKind;
  /** Lift the HTTP statement/lock timeouts to the worker budget (bulk background work). */
  readonly appliesWorkerStatementTimeout: boolean;
  /** Human-readable statement of what the RLS policies grant under this GUC. */
  readonly grants: string;
}

/**
 * THE registry of maintenance (bypass) database contexts — the single source of
 * truth for every `app.*` bypass GUC: which GUC each kind arms, how its
 * transaction is tuned, and (via {@link MAINTENANCE_SCOPE}) the only values that
 * can enter {@link withMaintenanceDatabaseContext}.
 *
 * @remarks
 * - **Notes:** every kind here is an RLS escape hatch — scopes are static frozen
 *   singletons (there is nothing per-request about maintenance authority), and
 *   which files may use each kind is pinned by
 *   `maintenance-context-confinement.policy.unit.test.ts`. Adding a kind means
 *   adding a row here, a policy arm in a migration, and a confinement entry —
 *   nothing else.
 */
export const MAINTENANCE_CONTEXTS = {
  global_retention_cleanup: {
    guc: 'app.global_retention_cleanup',
    opensTransaction: true,
    workerContextKind: 'global_retention_cleanup',
    appliesWorkerStatementTimeout: true,
    grants: 'cross-tenant read/delete via the USING bypass arms on tenant policies',
  },
  session_retention_cleanup: {
    guc: 'app.session_retention_cleanup',
    opensTransaction: true,
    workerContextKind: 'session_retention_cleanup',
    appliesWorkerStatementTimeout: true,
    grants: 'cross-user delete on auth.sessions',
  },
  global_admin: {
    guc: 'app.global_admin',
    opensTransaction: true,
    workerContextKind: 'global_admin',
    appliesWorkerStatementTimeout: false,
    grants: 'cross-user/cross-tenant reads on auth.users, auth.auth_methods, audit.logs',
  },
  system_audit_insert: {
    guc: 'app.system_audit_insert',
    opensTransaction: true,
    workerContextKind: 'system_table',
    appliesWorkerStatementTimeout: false,
    grants: 'tenantless INSERT into audit.logs (organization_id IS NULL only)',
  },
  audit_outbox_drain: {
    guc: 'app.audit_outbox_drain',
    opensTransaction: true,
    workerContextKind: 'audit_outbox_drain',
    appliesWorkerStatementTimeout: true,
    grants: 'exclusive SELECT/UPDATE/DELETE on audit.outbox',
  },
  system_table_retention: {
    guc: null,
    opensTransaction: true,
    workerContextKind: 'system_table',
    appliesWorkerStatementTimeout: true,
    grants: 'pure-DB bulk retention on non-RLS tables (e.g. billing.stripe_webhook_events)',
  },
  system_table_worker: {
    guc: null,
    opensTransaction: false,
    workerContextKind: 'system_table',
    appliesWorkerStatementTimeout: false,
    grants:
      'non-RLS table access from workers doing external I/O (mail outbox, ledgers) — no transaction held across network calls',
  },
} as const satisfies Record<string, MaintenanceContextDefinition>;

/** Derived — the closed set of maintenance-context kinds; never declared separately. */
export type MaintenanceContextKind = keyof typeof MAINTENANCE_CONTEXTS;

declare const MAINTENANCE_SCOPE_BRAND: unique symbol;

/**
 * Unforgeable static scope for one maintenance (bypass) context — generic over
 * the kind so code can demand one specific authority at the type level.
 *
 * @remarks
 * The only instances are the frozen singletons in {@link MAINTENANCE_SCOPE};
 * the brand is compile-time only and `Object.freeze` prevents runtime mutation
 * of `kind` (which would otherwise be an authority-escalation vector).
 */
export interface MaintenanceDatabaseScope<
  K extends MaintenanceContextKind = MaintenanceContextKind,
> {
  readonly kind: K;
  readonly [MAINTENANCE_SCOPE_BRAND]: true;
}

/**
 * The static maintenance scopes — one frozen singleton per kind, derived from
 * {@link MAINTENANCE_CONTEXTS}. These are the ONLY values accepted by
 * {@link withMaintenanceDatabaseContext}; which files may reference each kind is
 * pinned by the confinement policy test.
 */
export const MAINTENANCE_SCOPE: {
  readonly [K in MaintenanceContextKind]: MaintenanceDatabaseScope<K>;
} = Object.freeze(
  Object.fromEntries(
    (Object.keys(MAINTENANCE_CONTEXTS) as MaintenanceContextKind[]).map((kind) => [
      kind,
      Object.freeze({ kind }),
    ]),
  ),
) as never;

/** Options for {@link withMaintenanceDatabaseContext}. */
export type MaintenanceDatabaseContextOptions = {
  /** When true, `SET LOCAL ROLE core_be_app` so tests connected as the privileged owner role exercise production RLS. */
  useApplicationDatabaseRole?: boolean;
};

/**
 * The single wrapper for every maintenance (bypass) database context: opens one
 * transaction, arms exactly the scope's GUC (`set_config(<guc>, 'true', true)`),
 * pins the handle in ALS, and releases everything at COMMIT/ROLLBACK.
 *
 * @remarks
 * - **Algorithm:** dispatches on `scope.kind` through {@link MAINTENANCE_CONTEXTS}
 *   — worker-timeout tuning and the ALS context kind come from the same table
 *   row, so behavior per kind is declarative and undriftable.
 * - **Failure modes:** any callback error rolls the transaction back; the GUC
 *   dies with the transaction.
 * - **Side effects:** one Postgres transaction per call; bulk kinds lift the
 *   HTTP statement/lock timeouts to the worker budget.
 * - **SECURITY:** every kind bypasses tenant/user isolation on the tables its
 *   policies name. Enter it only from the paths the confinement policy test
 *   allows for that kind — worker processors, admin-authorized routes, and
 *   trusted system flows. Never on a self-service request path.
 */
export async function withMaintenanceDatabaseContext<T>(
  scope: MaintenanceDatabaseScope,
  callback: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
  options?: MaintenanceDatabaseContextOptions,
): Promise<T> {
  const definition = MAINTENANCE_CONTEXTS[scope.kind];
  if (!definition.opensTransaction) {
    // Non-transactional kinds pin the shared pool handle so getRequestDatabase()
    // resolves in worker runtime WITHOUT holding a checkout across the callback's
    // external I/O (mail sends, BullMQ re-enqueues). Outside worker runtime the
    // handle is passed straight through with no ALS pinning — an HTTP caller
    // (stripe-webhook service, commit-dispatch executor) must not have its
    // request-pinned transaction handle shadowed by the bare pool.
    if (!isWorkerRuntime()) {
      return callback(
        brandWorkerContextDatabaseHandle(database as unknown as RequestScopedPostgresDatabase),
      );
    }
    return runWithWorkerDatabaseContext({ kind: definition.workerContextKind }, () =>
      runWithPinnedDatabaseHandle(database as unknown as RequestScopedPostgresDatabase, () =>
        callback(
          brandWorkerContextDatabaseHandle(database as unknown as RequestScopedPostgresDatabase),
        ),
      ),
    );
  }
  return runWithWorkerDatabaseContext({ kind: definition.workerContextKind }, () =>
    database.transaction(async (transaction) => {
      const databaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
      if (options?.useApplicationDatabaseRole === true) {
        await databaseHandle.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
      }
      if (definition.appliesWorkerStatementTimeout) {
        await applyWorkerStatementTimeout(databaseHandle);
      }
      if (definition.guc !== null) {
        await setLocalDatabaseConfig(databaseHandle, definition.guc, 'true');
      }
      return runWithPinnedDatabaseHandle(databaseHandle, () =>
        callback(brandWorkerContextDatabaseHandle(databaseHandle)),
      );
    }),
  );
}
