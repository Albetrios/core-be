import { inArray, sql as drizzleSql } from 'drizzle-orm';
import { withMaintenanceDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';
import { createDrainAuditOutboxRepository } from '@/domains/audit/audit-outbox.repository.js';
import type { AuditOutboxRow } from '@/domains/audit/audit-outbox.schema.js';
import { logs } from '@/domains/audit/audit.schema.js';
import { users } from '@/domains/user/user.schema.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { setLocalDatabaseConfig } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { env } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  AUDIT_OUTBOX_DRAIN_STALE_PENDING_WARN_SECONDS,
  DEFAULT_AUDIT_OUTBOX_DRAIN_BATCH_SIZE,
  DEFAULT_AUDIT_OUTBOX_DRAIN_MAX_ATTEMPTS,
} from '@/domains/audit/workers/audit-outbox-drain.constants.js';

/**
 * Summary returned by {@link runAuditOutboxDrainJob} for observability.
 *
 * @remarks
 * - **Algorithm:** counts are accumulated as the drain iterates the claimed batch;
 *   no derived totals — `drained + transientFailed + permanentlyFailed` equals the
 *   number of rows the pass claimed.
 * - **Failure modes:** the structure itself cannot fail; it is the success-path
 *   return value. Drain errors that prevent producing this object surface as
 *   thrown errors from {@link runAuditOutboxDrainJob}.
 * - **Side effects:** none.
 * - **Notes:** consumed by structured logs (`audit.outbox.drain.pass.completed`)
 *   and the worker unit tests.
 */
export interface AuditOutboxDrainResult {
  /** Rows successfully inserted into `audit.logs` this pass. */
  drained: number;
  /** Rows whose drain failed transiently and will be retried next pass. */
  transientFailed: number;
  /** Rows permanently marked FAILED this pass (attempt cap or unresolvable). */
  permanentlyFailed: number;
}

interface ResolutionMaps {
  readonly userIdsByPublicId: ReadonlyMap<string, number>;
  readonly organizationIdsByPublicId: ReadonlyMap<string, number>;
  readonly apiKeyIdsByPublicId: ReadonlyMap<string, number>;
}

/** Collects the distinct user / organization / API-key public ids referenced by a drain batch. */
function collectAuditOutboxPublicIds(batch: readonly AuditOutboxRow[]): {
  userPublicIds: Set<string>;
  organizationPublicIds: Set<string>;
  apiKeyPublicIds: Set<string>;
} {
  const userPublicIds = new Set<string>();
  const organizationPublicIds = new Set<string>();
  const apiKeyPublicIds = new Set<string>();
  for (const row of batch) {
    if (row.actor_user_public_id) userPublicIds.add(row.actor_user_public_id);
    if (row.target_user_public_id) userPublicIds.add(row.target_user_public_id);
    if (row.organization_public_id) organizationPublicIds.add(row.organization_public_id);
    if (row.actor_api_key_public_id) apiKeyPublicIds.add(row.actor_api_key_public_id);
  }
  return { userPublicIds, organizationPublicIds, apiKeyPublicIds };
}

/** Runs one SECURITY DEFINER resolver query and normalizes the driver's row shape. */
async function executeResolverFunction(
  databaseHandle: RequestScopedPostgresDatabase,
  statement: ReturnType<typeof drizzleSql>,
): Promise<{ id: number | string; public_id: string }[]> {
  const result = await databaseHandle.execute<{ id: number | string; public_id: string }>(
    statement,
  );
  return Array.isArray(result)
    ? (result as { id: number | string; public_id: string }[])
    : ((result as { rows?: { id: number | string; public_id: string }[] }).rows ?? []);
}

/**
 * Pre-resolves every distinct actor / target / organization / API-key public id in the batch
 * to its internal id in 3 round trips (one per table). Done UNDER `app.global_admin = true`
 * so a single drain pass can resolve identifiers across many tenants without per-row
 * RLS context switching. Returns lookup maps consumed by the per-row insert path.
 *
 * @remarks
 * - **Algorithm:** collects unique public ids from the batch, sets `app.global_admin`
 *   in the drain transaction, then issues 3 batched `WHERE public_id IN (...)` queries.
 * - **Failure modes:** propagates query errors; the worker rolls back the whole drain
 *   batch on resolution failure so no partial rows enter `audit.logs`.
 * - **Side effects:** `SET LOCAL app.global_admin = 'true'` for the duration of the
 *   drain transaction; one SELECT per resolved table.
 */
async function buildResolutionMaps(
  databaseHandle: RequestScopedPostgresDatabase,
  batch: readonly AuditOutboxRow[],
): Promise<ResolutionMaps> {
  await setLocalDatabaseConfig(databaseHandle, 'app.global_admin', 'true');

  const { userPublicIds, organizationPublicIds, apiKeyPublicIds } =
    collectAuditOutboxPublicIds(batch);

  const userIdsByPublicId = new Map<string, number>();
  if (userPublicIds.size > 0) {
    const rows = await databaseHandle
      .select({ id: users.id, public_id: users.public_id })
      .from(users)
      .where(inArray(users.public_id, [...userPublicIds]));
    for (const row of rows) userIdsByPublicId.set(row.public_id, row.id);
  }

  // Org and API-key ids resolve through SECURITY DEFINER functions (migration
  // 20260827040000): app.global_admin grants NOTHING on tenancy.*, so plain
  // selects here returned ZERO rows under the RLS-subject roles and every
  // organization-scoped / api-key-actor outbox row was permanently discarded after max
  // attempts. The functions are narrow id lookups, mirroring the existing
  // billing.resolve_organization_public_id_for_stripe_subscription pattern.
  const organizationIdsByPublicId = new Map<string, number>();
  if (organizationPublicIds.size > 0) {
    const rows = await executeResolverFunction(
      databaseHandle,
      // Bound as one comma-joined param + string_to_array: the driver's JS-array
      // binding is not a reliable text[] literal, and public ids are [a-z0-9_] so
      // the join is unambiguous.
      drizzleSql`SELECT id, public_id FROM audit.resolve_organization_ids_for_public_ids(string_to_array(${[...organizationPublicIds].join(',')}, ','))`,
    );
    for (const row of rows) organizationIdsByPublicId.set(row.public_id, Number(row.id));
  }

  const apiKeyIdsByPublicId = new Map<string, number>();
  if (apiKeyPublicIds.size > 0) {
    const rows = await executeResolverFunction(
      databaseHandle,
      drizzleSql`SELECT id, public_id FROM audit.resolve_api_key_ids_for_public_ids(string_to_array(${[...apiKeyPublicIds].join(',')}, ','))`,
    );
    for (const row of rows) apiKeyIdsByPublicId.set(row.public_id, Number(row.id));
  }

  return { userIdsByPublicId, organizationIdsByPublicId, apiKeyIdsByPublicId };
}

interface ResolvedAuditLogInsertRow {
  actor_user_id: number | null;
  actor_api_key_id: number | null;
  target_user_id: number | null;
  organization_id: number | null;
  action: string;
  resource_type: string;
  resource_id: number | null;
  ip_address: string | null;
  user_agent: string | null;
  severity: string;
  metadata: Record<string, unknown>;
}

function resolveRowInserts(
  row: AuditOutboxRow,
  maps: ResolutionMaps,
): { row: ResolvedAuditLogInsertRow } | { error: string } {
  const actor_user_id = row.actor_user_public_id
    ? (maps.userIdsByPublicId.get(row.actor_user_public_id) ?? null)
    : null;
  const actor_api_key_id = row.actor_api_key_public_id
    ? (maps.apiKeyIdsByPublicId.get(row.actor_api_key_public_id) ?? null)
    : null;
  const target_user_id = row.target_user_public_id
    ? (maps.userIdsByPublicId.get(row.target_user_public_id) ?? null)
    : null;
  const organization_id = row.organization_public_id
    ? (maps.organizationIdsByPublicId.get(row.organization_public_id) ?? null)
    : null;

  if (actor_user_id === null && actor_api_key_id === null) {
    return {
      error: 'actor public_id did not resolve (user/api-key may have been hard-deleted)',
    };
  }
  if (row.organization_public_id !== null && organization_id === null) {
    return {
      error: `organization_public_id ${row.organization_public_id} did not resolve`,
    };
  }

  return {
    row: {
      actor_user_id,
      actor_api_key_id,
      target_user_id,
      organization_id,
      action: row.action,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      severity: row.severity,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
    },
  };
}

/** Outcome of draining a single outbox row, tallied by {@link runAuditOutboxDrainJob}. */
type DrainOutboxRowOutcome =
  | { kind: 'success'; id: number }
  | { kind: 'transient' }
  | { kind: 'permanent' };

/**
 * Drains one claimed `audit.outbox` row into `audit.logs`: resolves the row, sets the per-row
 * tenant GUC (organization-scoped or system-audit), inserts, and on failure records a transient or terminal
 * failure. Extracted from {@link runAuditOutboxDrainJob} so the batch loop stays within complexity
 * budget; the marking side effects happen here and the caller only tallies the returned outcome.
 */
async function drainOutboxRow(options: {
  databaseHandle: RequestScopedPostgresDatabase;
  drainRepository: ReturnType<typeof createDrainAuditOutboxRepository>;
  row: AuditOutboxRow;
  maps: ResolutionMaps;
  maxAttempts: number;
}): Promise<DrainOutboxRowOutcome> {
  const { databaseHandle, drainRepository, row, maps, maxAttempts } = options;
  const resolution = resolveRowInserts(row, maps);
  if ('error' in resolution) {
    await drainRepository.markPermanentlyFailed(row.id, resolution.error);
    logger.warn(
      { outboxId: row.id, error: resolution.error },
      'audit.outbox.drain.row.unresolvable',
    );
    return { kind: 'permanent' };
  }

  try {
    // sec-r7/M2: isolate this row's GUC change + INSERT in a nested transaction (a Postgres
    // SAVEPOINT, issued by drizzle). A DB-level failure on THIS row otherwise aborts the WHOLE
    // batch transaction, so the failure-mark UPDATE below would itself throw "current transaction
    // is aborted" and roll the entire batch back — including the claim's `attempt_count` bump —
    // leaving the poison row at the head of `claimPendingBatch` (ORDER BY created_at ASC) forever,
    // never reaching the attempt cap. drizzle rolls the nested transaction back to its savepoint
    // and re-throws, leaving the OUTER batch transaction valid so the failure is recorded and the
    // row's retries stay bounded. (Raw `SAVEPOINT` via execute() does NOT integrate with the
    // postgres-js transaction-error state, so the nested transaction is the supported mechanism.)
    await databaseHandle.transaction(async (savepoint) => {
      const savepointHandle = savepoint as unknown as RequestScopedPostgresDatabase;
      // Set BOTH GUCs on every row, never just the one this row needs.
      //
      // `RELEASE SAVEPOINT` KEEPS whatever the savepoint set — only `ROLLBACK TO SAVEPOINT`
      // restores it. So a value set for one row survives into the rest of the outer batch
      // transaction and is inherited by every later row. When these branches each set only their
      // own GUC, a tenanted row left `app.current_organization_public_id` set for a following tenantless
      // row, and a tenantless row left `app.system_audit_insert='true'` set for every following
      // tenanted row — silently widening the `audit_logs_tenant_isolation_insert` policy for the
      // remainder of the batch. That is not exploitable today only because the policy selects its
      // arm on the row's `organization_id` COLUMN rather than on the GUC; one edit to either the
      // policy or this branch turns it into a cross-tenant insert. Writing both values every
      // iteration makes each row's RLS identity total, so nothing is inherited.
      await setLocalDatabaseConfig(
        savepointHandle,
        'app.current_organization_public_id',
        row.organization_public_id ?? '',
      );
      // Tenantless audit (system events) need the system arm; `resolveRowInserts` guarantees such
      // rows carry `organization_id IS NULL`, which the policy's system arm also requires.
      await setLocalDatabaseConfig(
        savepointHandle,
        'app.system_audit_insert',
        row.organization_public_id === null ? 'true' : 'false',
      );
      await savepointHandle.insert(logs).values(resolution.row);
    });
    return { kind: 'success', id: row.id };
  } catch (error) {
    // The nested transaction already rolled this row's partial work back to its savepoint, so the
    // batch transaction is still usable: record the failure, which commits with the rest of the
    // batch instead of aborting it.
    const message = error instanceof Error ? error.message : String(error);
    if (row.attempt_count + 1 >= maxAttempts) {
      await drainRepository.markPermanentlyFailed(row.id, message);
      logger.error(
        { outboxId: row.id, attemptCount: row.attempt_count + 1, error: message },
        'audit.outbox.drain.row.failed_terminally',
      );
      return { kind: 'permanent' };
    }
    await drainRepository.recordTransientFailure(row.id, message);
    logger.warn(
      { outboxId: row.id, attemptCount: row.attempt_count + 1, error: message },
      'audit.outbox.drain.row.transient_failure',
    );
    return { kind: 'transient' };
  }
}

/**
 * Drains a batch of PENDING `audit.outbox` rows into `audit.logs`.
 *
 * @remarks
 * Runs inside the drain transaction opened by {@link withMaintenanceDatabaseContext}.
 * The job:
 *  1. Claims up to `batchSize` rows via FOR UPDATE SKIP LOCKED (concurrent drain instances
 *     never double-process — bumps `attempt_count` atomically on claim).
 *  2. Bulk-resolves every distinct public id with `app.global_admin = true`.
 *  3. Per row, switches `app.current_organization_public_id` (or `app.system_audit_insert` for
 *     tenantless rows) so the `audit.logs` INSERT passes the tenant-isolation policy.
 *  4. Marks success rows PROCESSED, retryable failures' `last_error` updated (status
 *     stays PENDING), unresolvable / over-cap rows FAILED.
 *
 * Failure modes: any thrown error rolls back the WHOLE drain batch (rows stay PENDING,
 * audit.logs writes do not commit) so the next pass re-attempts cleanly.
 *
 * Side effects: writes into `audit.logs`, updates `audit.outbox`, sets transaction-local
 * GUCs. Structured logs at every transition.
 */
export async function runAuditOutboxDrainJob(
  databaseHandle: RequestScopedPostgresDatabase,
): Promise<AuditOutboxDrainResult> {
  const batchSize = env.AUDIT_OUTBOX_DRAIN_BATCH_SIZE ?? DEFAULT_AUDIT_OUTBOX_DRAIN_BATCH_SIZE;
  const maxAttempts =
    env.AUDIT_OUTBOX_DRAIN_MAX_ATTEMPTS ?? DEFAULT_AUDIT_OUTBOX_DRAIN_MAX_ATTEMPTS;

  const drainRepository = createDrainAuditOutboxRepository(databaseHandle);
  const batch = await drainRepository.claimPendingBatch(batchSize);
  if (batch.length === 0) {
    return { drained: 0, transientFailed: 0, permanentlyFailed: 0 };
  }

  const maps = await buildResolutionMaps(databaseHandle, batch);

  const successIds: number[] = [];
  let transientFailed = 0;
  let permanentlyFailed = 0;

  // Each row's tenant GUC is a `SET LOCAL` that persists until the next iteration replaces it;
  // `drainOutboxRow` always re-sets the correct GUC (organization-scoped or system-audit) per row.
  for (const row of batch) {
    const outcome = await drainOutboxRow({
      databaseHandle,
      drainRepository,
      row,
      maps,
      maxAttempts,
    });
    if (outcome.kind === 'success') {
      successIds.push(outcome.id);
    } else if (outcome.kind === 'transient') {
      transientFailed += 1;
    } else {
      permanentlyFailed += 1;
    }
  }

  await drainRepository.markProcessed(successIds);

  logger.info(
    {
      claimed: batch.length,
      drained: successIds.length,
      transientFailed,
      permanentlyFailed,
    },
    'audit.outbox.drain.pass.completed',
  );

  // sec-r7/M2 backstop: with poison rows now isolated per-row (savepoint) and bounded by the
  // attempt cap, a persistently-old PENDING row signals either a chronic failure path or a stuck
  // queue. Surface it so an operator pages even though no single pass throws.
  const backlog = await drainRepository.getPendingBacklogStats();
  if (backlog.oldestPendingAgeSeconds >= AUDIT_OUTBOX_DRAIN_STALE_PENDING_WARN_SECONDS) {
    logger.warn(
      {
        pendingCount: backlog.pendingCount,
        oldestPendingAgeSeconds: backlog.oldestPendingAgeSeconds,
        maxAttemptCount: backlog.maxAttemptCount,
        thresholdSeconds: AUDIT_OUTBOX_DRAIN_STALE_PENDING_WARN_SECONDS,
      },
      'audit.outbox.drain.backlog.stalled',
    );
  }

  return {
    drained: successIds.length,
    transientFailed,
    permanentlyFailed,
  };
}

/** Re-export so callers do not couple to the constants module. */
export type { RequestScopedPostgresDatabase };
/**
 * Counts PENDING rows in `audit.outbox` for tests and operator dashboards.
 *
 * @remarks
 * - **Algorithm:** single `SELECT COUNT(*)` against `audit.outbox` filtered to
 *   `status = 'PENDING'`. Bypasses Drizzle's typed query builder via
 *   `databaseHandle.execute` so the caller can pass a worker-pinned transaction
 *   handle without a typed table reference threaded through tests.
 * - **Failure modes:** propagates query errors (e.g. missing drain GUC under
 *   RLS); the caller is expected to be in a drain or admin context.
 * - **Side effects:** read-only.
 * - **Notes:** exported solely for the audit-outbox integration test that asserts
 *   the drain worker actually empties the queue. Production observability uses
 *   the structured `audit.outbox.drain.pass.completed` log fields instead.
 */
export async function countPendingAuditOutboxRows(
  databaseHandle: RequestScopedPostgresDatabase,
): Promise<number> {
  const result = await databaseHandle.execute<{ count: number }>(
    drizzleSql`SELECT COUNT(*)::int AS count FROM audit.outbox WHERE status = 'PENDING'`,
  );
  const rows = Array.isArray(result)
    ? (result as { count: number }[])
    : ((result as { rows?: { count: number }[] }).rows ?? []);
  return rows[0]?.count ?? 0;
}
