/**
 * Database-context RUNTIME — the single plumbing module behind the three scope
 * patterns (principal / session / maintenance): the worker-context ALS, the
 * request-pinned-handle ALS, the `WorkerDatabaseContextError`, the worker
 * statement/lock-timeout lift, and the repository handle-resolution guards.
 *
 * @remarks
 * - **Notes:** application code never imports this module directly — it enters a
 *   database context ONLY through the scope-pattern wrappers, and repositories
 *   receive their handle via `resolveRepositoryDatabaseHandle` /
 *   `createWorker*Repository` factories. The one documented exemption is
 *   `audit-outbox-drain.processor.ts` (type + `setLocalDatabaseConfig` import),
 *   pinned by `worker-database-guard.unit.test.ts`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  isForceRlsTable,
  type ForceRlsTableRef,
} from '@/infrastructure/database/utils/force-rls-tables.constants.js';
import { sql as drizzleSql } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import type { PostgresDatabaseHandle } from '@/infrastructure/database/utils/database-handle.types.js';
import { getEnv } from '@/shared/config/env.config.js';

/**
 * Thrown when a worker process accesses Postgres without a pinned worker database context
 * (organization, retention, user, session cleanup, or system-table bypass).
 */
export class WorkerDatabaseContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerDatabaseContextError';
  }
}

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
   * Per-row, the worker temporarily layers `app.current_organization_public_id` (or
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
 * context wrappers (`withAppDatabaseContext`, `withMaintenanceDatabaseContext`, etc.)
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
      'Worker process must not use unpinned database access. Wrap the job in a context helper (withAppDatabaseContext, runTenantScopedWorkerJob, withMaintenanceDatabaseContext, or withAppDatabaseContext) and pass databaseHandle into createWorker*Repository() factories.',
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
 * `withAppDatabaseContext (user scope)` to pin ALS for the duration of the job.
 */
export function workerDatabaseContextForUser(userPublicId: string): WorkerDatabaseContext {
  return { kind: 'user', userPublicId };
}

/**
 * Drizzle handle pinned to a single postgres.js checkout for the lifetime of an
 * HTTP request transaction or worker-scoped context — alias of
 * {@link PostgresDatabaseHandle} carried through ALS by the helpers in this file.
 */
export type RequestScopedPostgresDatabase = PostgresDatabaseHandle;

/**
 * Fastify HTTP requests that send `X-Organization-Id` run inside a single Drizzle
 * transaction with `SET LOCAL app.current_organization_public_id` so every query shares one
 * checkout from the postgres.js pool and RLS policies see a stable GUC.
 *
 * Workers must use context wrappers that pin ALS via `runWithPinnedOrganizationDatabaseSession`
 * and pass the explicit `databaseHandle` into processors/repositories — never rely on the
 * global pool fallback from `getRequestDatabase()` outside a pinned session.
 */
export interface OrganizationRequestDatabaseSession {
  readonly databaseHandle: RequestScopedPostgresDatabase;
  readonly organizationPublicId: string;
}

/**
 * AsyncLocalStorage carrying the active {@link OrganizationRequestDatabaseSession} for
 * the current request/worker job — exported so middleware and context wrappers can
 * `.run()` and `.getStore()` against the same storage instance.
 */
export const organizationRequestDatabaseStorage =
  new AsyncLocalStorage<OrganizationRequestDatabaseSession>();

/**
 * Returns the pinned transaction handle from ALS when present, falling back to the
 * pool-level {@link database} for HTTP requests outside a tenant transaction. Throws
 * in worker runtime if no context has been pinned to prevent silent RLS bypass.
 */
export function getRequestDatabase(): RequestScopedPostgresDatabase {
  const session = organizationRequestDatabaseStorage.getStore();
  if (session !== undefined) {
    return session.databaseHandle;
  }

  if (isWorkerRuntime()) {
    throw new WorkerDatabaseContextError(
      'Worker process must not use unpinned database access. Wrap the job in a context helper and pass databaseHandle into createWorker*Repository() factories.',
    );
  }

  return database;
}

/**
 * Returns the full pinned session (database handle + tenant public id) without
 * triggering the worker-runtime guard — use when callers need the organization
 * identifier alongside the handle, e.g. for event emission or logging.
 */
export function getOrganizationRequestDatabaseSession():
  | OrganizationRequestDatabaseSession
  | undefined {
  return organizationRequestDatabaseStorage.getStore();
}

/**
 * Pins `databaseHandle` in ALS so `getRequestDatabase()` returns the same checkout for
 * tenant-scoped worker and HTTP organization RLS transactions.
 */
export function runWithPinnedOrganizationDatabaseSession<T>(
  organizationPublicId: string,
  databaseHandle: RequestScopedPostgresDatabase,
  callback: () => Promise<T>,
): Promise<T> {
  return organizationRequestDatabaseStorage.run({ databaseHandle, organizationPublicId }, callback);
}

/**
 * Pins `databaseHandle` in ALS for retention/session workers without a tenant public id.
 */
export function runWithPinnedDatabaseHandle<T>(
  databaseHandle: RequestScopedPostgresDatabase,
  callback: () => Promise<T>,
): Promise<T> {
  const existingSession = getOrganizationRequestDatabaseSession();
  return organizationRequestDatabaseStorage.run(
    {
      databaseHandle,
      organizationPublicId: existingSession?.organizationPublicId ?? '',
    },
    callback,
  );
}

/**
 * Sets a transaction-scoped Postgres GUC (`SET LOCAL` via `set_config(..., true)`)
 * on the supplied handle. Used to pin RLS-driving variables such as
 * `app.current_organization_public_id` and `app.global_retention_cleanup` for the
 * duration of the surrounding transaction.
 */
export async function setLocalDatabaseConfig(
  databaseHandle: RequestScopedPostgresDatabase,
  key: string,
  value: string,
): Promise<void> {
  await databaseHandle.execute(drizzleSql`SELECT set_config(${key}, ${value}, true)`);
}

/**
 * sec-D2: lift the connection-level HTTP-tuned `statement_timeout` (5 s) and `lock_timeout` (3 s)
 * for the duration of a worker transaction.
 *
 * `buildPostgresOptions` applies `statement_timeout` at connection time
 * tuned for HTTP traffic. Background work (retention deletes, GDPR scans,
 * DLQ sweeps) operates on much larger row counts and was being killed
 * mid-statement once the underlying table grew. Apply `SET LOCAL` at the
 * start of every worker context wrapper so the bump only affects that
 * transaction; the connection-level cap immediately re-applies for the
 * next checkout.
 *
 * Read from {@link getEnv} so the cap is operator-tunable without code
 * changes; default 5 minutes — large enough for cascading FK deletes
 * across audit/session tables, small enough to bound a runaway query
 * holding a pool checkout.
 */
export async function applyWorkerStatementTimeout(
  databaseHandle: RequestScopedPostgresDatabase,
): Promise<void> {
  const environment = getEnv();
  await databaseHandle.execute(
    drizzleSql.raw(
      `SET LOCAL statement_timeout = ${Number(environment.DATABASE_WORKER_STATEMENT_TIMEOUT_MS)}`,
    ),
  );
  // Same rationale for lock waits. The connection-level `lock_timeout` is tuned for HTTP (3s, a
  // caller is waiting); a background job with a 5-minute statement budget that abandons a lock
  // after 3s just converts contention into retries and DLQ churn. Lift it for this transaction
  // only — the connection-level cap re-applies on the next checkout.
  await databaseHandle.execute(
    drizzleSql.raw(
      `SET LOCAL lock_timeout = ${Number(environment.DATABASE_WORKER_LOCK_TIMEOUT_MS)}`,
    ),
  );
}

const GUC_BY_CONTEXT_KIND: Record<
  Exclude<WorkerDatabaseContextKind, 'system_table'>,
  { key: string; label: string }
> = {
  organization: { key: 'app.current_organization_public_id', label: 'organization' },
  global_retention_cleanup: {
    key: 'app.global_retention_cleanup',
    label: 'global retention cleanup',
  },
  global_admin: { key: 'app.global_admin', label: 'global admin' },
  user: { key: 'app.current_user_public_id', label: 'user' },
  session_retention_cleanup: {
    key: 'app.session_retention_cleanup',
    label: 'session retention cleanup',
  },
  audit_outbox_drain: { key: 'app.audit_outbox_drain', label: 'audit outbox drain' },
};

/**
 * Resolves the Drizzle handle for repositories. In worker runtime, requires an explicit
 * handle or a pinned ALS session from a context wrapper.
 */
export function resolveRepositoryDatabaseHandle(
  databaseHandle: RequestScopedPostgresDatabase | undefined,
): RequestScopedPostgresDatabase {
  if (databaseHandle !== undefined) {
    return databaseHandle;
  }

  if (isWorkerRuntime()) {
    assertWorkerDatabaseContext();
  }

  return getRequestDatabase();
}

/**
 * Verifies the Postgres session GUC for the active worker context kind is set (non-empty).
 * Call from createWorker*Repository factories before tenant-scoped queries.
 */
export async function assertWorkerRlsGucSet(
  databaseHandle: RequestScopedPostgresDatabase,
  expectedKind: Exclude<WorkerDatabaseContextKind, 'system_table'>,
): Promise<void> {
  if (!isWorkerRuntime()) {
    return;
  }

  const context = getWorkerDatabaseContext();
  if (context === undefined || context.kind !== expectedKind) {
    throw new WorkerDatabaseContextError(
      `Expected worker database context kind "${expectedKind}" before querying FORCE RLS tables.`,
    );
  }

  // eslint-disable-next-line security/detect-object-injection -- expectedKind is a typed WorkerDatabaseContextKind.
  const guc = GUC_BY_CONTEXT_KIND[expectedKind];
  const rows = await databaseHandle.execute<{ current_setting: string | null }>(
    drizzleSql`SELECT current_setting(${guc.key}, true) AS current_setting`,
  );
  const resultRows = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: { current_setting: string | null }[] }).rows ?? []);
  const value = resultRows[0]?.current_setting;
  if (value === null || value === undefined || value === '') {
    throw new WorkerDatabaseContextError(
      `Postgres session variable ${guc.key} is not set for ${guc.label} worker context.`,
    );
  }

  if (
    expectedKind === 'organization' &&
    context.organizationPublicId !== undefined &&
    value !== context.organizationPublicId
  ) {
    throw new WorkerDatabaseContextError(
      `Postgres ${guc.key} (${value}) does not match worker context organization (${context.organizationPublicId}).`,
    );
  }

  if (
    expectedKind === 'user' &&
    context.userPublicId !== undefined &&
    value !== context.userPublicId
  ) {
    throw new WorkerDatabaseContextError(
      `Postgres ${guc.key} (${value}) does not match worker context user (${context.userPublicId}).`,
    );
  }
}
