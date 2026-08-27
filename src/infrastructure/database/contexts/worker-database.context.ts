import { AsyncLocalStorage } from 'node:async_hooks';
import {
  isForceRlsTable,
  type ForceRlsTableRef,
} from '@/infrastructure/database/utils/force-rls-tables.constants.js';
import { WorkerDatabaseContextError } from '@/infrastructure/database/contexts/worker-database.context.error.js';

/**
 * Discriminator for the kind of pinned database context a BullMQ worker job is
 * running under. Drives which FORCE-RLS tables the job may touch via
 * {@link assertWorkerForceRlsTableAccess}.
 */
export type WorkerDatabaseContextKind =
  | 'organization'
  | 'global_retention_cleanup'
  | 'global_admin'
  | 'user'
  | 'session_retention_cleanup'
  | 'system_table'
  /**
   * Audit-outbox drain worker. Pins `app.audit_outbox_drain = 'true'` so the worker
   * is the only context that can SELECT / UPDATE / DELETE rows in `audit.outbox`.
   * Per-row, the worker temporarily layers `app.current_organization_id` (or
   * `app.system_audit_insert`) for the eventual `audit.logs` INSERT.
   */
  | 'audit_outbox_drain';

/**
 * ALS payload describing the pinned database context for a worker job: the
 * {@link WorkerDatabaseContextKind} plus the optional organization/user identifier
 * the job is scoped to.
 */
export interface WorkerDatabaseContext {
  readonly kind: WorkerDatabaseContextKind;
  readonly organizationPublicId?: string;
  readonly userPublicId?: string;
}

/**
 * AsyncLocalStorage that carries the active {@link WorkerDatabaseContext} for the
 * current worker job. Exported so worker context wrappers and assertions share a
 * single storage instance.
 */
export const workerDatabaseContextStorage = new AsyncLocalStorage<WorkerDatabaseContext>();

const FORCE_RLS_ALLOWED_KINDS: ReadonlySet<WorkerDatabaseContextKind> = new Set([
  'organization',
  'global_retention_cleanup',
  'global_admin',
  'user',
  'session_retention_cleanup',
  // The audit-outbox drain legitimately reads/writes FORCE RLS tables: audit.outbox (via the
  // app.audit_outbox_drain policies) and audit.logs / auth.users / organizations / api_keys, which
  // it resolves under per-row org or app.global_admin context. RLS still scopes every row — listing
  // the kind here only lets the (currently advisory) pinned-context assertion recognise the drain as
  // a valid FORCE-RLS accessor rather than rejecting it. Required now that audit.outbox is FORCE RLS.
  'audit_outbox_drain',
]);

/**
 * True when the current process is the BullMQ worker entrypoint (`pnpm dev:worker`,
 * which sets `CORE_BE_RUNTIME=worker`). Used to gate worker-only RLS assertions
 * while keeping the same code paths reusable from the API process and tests.
 */
export function isWorkerRuntime(): boolean {
  return process.env.CORE_BE_RUNTIME === 'worker';
}

/**
 * Reads the pinned {@link WorkerDatabaseContext} for the current job, or `undefined`
 * if no context wrapper is active (e.g. in HTTP request paths or unpinned tests).
 */
export function getWorkerDatabaseContext(): WorkerDatabaseContext | undefined {
  return workerDatabaseContextStorage.getStore();
}

/**
 * Runs `callback` with the given {@link WorkerDatabaseContext} pinned in ALS. Worker
 * context wrappers (`withPrincipalDatabaseContext`, `withMaintenanceDatabaseContext`, etc.)
 * build on top of this primitive — application code should call the wrappers
 * directly rather than this raw helper.
 */
export function runWithWorkerDatabaseContext<T>(
  context: WorkerDatabaseContext,
  callback: () => Promise<T>,
): Promise<T> {
  return workerDatabaseContextStorage.run(context, callback);
}

/**
 * Asserts a worker job has pinned database context before touching Postgres.
 * No-op outside worker runtime.
 */
export function assertWorkerDatabaseContext(
  allowedKinds?: readonly WorkerDatabaseContextKind[],
): void {
  if (!isWorkerRuntime()) {
    return;
  }

  const context = getWorkerDatabaseContext();
  if (context === undefined) {
    throw new WorkerDatabaseContextError(
      'Worker process must not use unpinned database access. Wrap the job in a context helper (withPrincipalDatabaseContext, runTenantScopedWorkerJob, withMaintenanceDatabaseContext, or withSessionDatabaseContext) and pass databaseHandle into createWorker*Repository() factories.',
    );
  }

  if (allowedKinds !== undefined && !allowedKinds.includes(context.kind)) {
    throw new WorkerDatabaseContextError(
      `Worker database context kind "${context.kind}" is not allowed for this operation. Required: ${allowedKinds.join(', ')}.`,
    );
  }
}

/**
 * Asserts worker access to a FORCE RLS table uses an appropriate context kind.
 * No-op outside worker runtime.
 */
export function assertWorkerForceRlsTableAccess(tableRef: ForceRlsTableRef): void {
  if (!isWorkerRuntime()) {
    return;
  }

  if (!isForceRlsTable(tableRef.schemaName, tableRef.tableName)) {
    return;
  }

  const context = getWorkerDatabaseContext();
  if (context === undefined) {
    throw new WorkerDatabaseContextError(
      `Worker queried FORCE RLS table ${tableRef.schemaName}.${tableRef.tableName} without a pinned database context.`,
    );
  }

  if (!FORCE_RLS_ALLOWED_KINDS.has(context.kind)) {
    throw new WorkerDatabaseContextError(
      `Worker context kind "${context.kind}" cannot access FORCE RLS table ${tableRef.schemaName}.${tableRef.tableName}. Use organization, global_retention_cleanup, global_admin, user, or session_retention_cleanup context.`,
    );
  }
}

/**
 * Builds an `organization`-kind {@link WorkerDatabaseContext} tagged with the tenant
 * public id — passed to {@link runWithWorkerDatabaseContext} by tenant-scoped
 * worker wrappers so RLS-bound jobs carry the org identity through ALS.
 */
export function workerDatabaseContextForOrganization(
  organizationPublicId: string,
): WorkerDatabaseContext {
  return { kind: 'organization', organizationPublicId };
}

/**
 * Builds a `user`-kind {@link WorkerDatabaseContext} for user-scoped retention/export
 * jobs (e.g. GDPR data export, user-tombstone retention). Pairs with
 * `withUserDatabaseContext` to pin ALS for the duration of the job.
 */
export function workerDatabaseContextForUser(userPublicId: string): WorkerDatabaseContext {
  return { kind: 'user', userPublicId };
}
