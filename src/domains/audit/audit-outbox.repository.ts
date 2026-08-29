import { and, asc, eq, inArray, lt, sql as drizzleSql } from 'drizzle-orm';
import { withMaintenanceDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';
import {
  type RequestScopedPostgresDatabase,
  assertWorkerRlsGucSet,
  getRequestDatabase,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { audit_outbox, type AuditOutboxRow } from './audit-outbox.schema.js';

/**
 * Payload accepted by {@link insertAuditOutboxRow}. Mirrors {@link AuditLogInsert}
 * but stores raw `*_public_id` fields so the caller's hot path stays a single
 * INSERT (no per-row resolution lookups before the row is staged).
 */
export interface AuditOutboxInsertInput {
  actorUserPublicId?: string | undefined;
  actorApiKeyPublicId?: string | undefined;
  targetUserPublicId?: string | undefined;
  organizationPublicId?: string | undefined;
  action: string;
  resourceType: string;
  resourceId?: number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  severity?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Inserts a PENDING row into `audit.outbox` using the currently-pinned request
 * database handle. The handle is pinned by `AuditService.record`, which wraps this
 * call in the RLS context that matches the row (audit R10): an organization context for
 * organization-scoped rows, the system-audit-insert context for tenantless rows.
 *
 * @remarks
 * - **Algorithm:** single `INSERT` (no `RETURNING` — Postgres applies SELECT-policy
 *   visibility to `RETURNING` rows, and `audit.outbox` SELECT is deliberately
 *   drain-exclusive, so a `RETURNING` here is rejected under the RLS-subject
 *   application roles) against the request-scoped handle resolved from ALS. The
 *   affected-row count is the loud-failure guard instead of the returned id.
 *   Never opens its own transaction — the wrapping context (organization /
 *   system-audit-insert) owns the transaction boundary.
 * - **Failure modes:** RLS rejects the INSERT when `app.current_organization_public_id`
 *   does not match the supplied `organizationPublicId` (or, for tenantless
 *   audits, when `app.system_audit_insert` is not `'true'`). The thrown error
 *   bubbles back to the caller's audit-record wrapper, which catches and logs
 *   so the business write itself is never failed by an audit problem.
 * - **Side effects:** one INSERT in the wrapping context's short transaction.
 *   Post-sec-M4 this is decoupled from the originating business write (which has
 *   already committed in its own scoped context), so the audit row is best-effort,
 *   not atomic with the audited write.
 * - **Notes:** never reachable from worker runtime — callers must already hold
 *   a request DB context (`AuditService.record` establishes it).
 */
export async function insertAuditOutboxRow(input: AuditOutboxInsertInput): Promise<void> {
  const database = getRequestDatabase();
  const result = await database.insert(audit_outbox).values({
    status: 'PENDING',
    actor_user_public_id: input.actorUserPublicId ?? null,
    actor_api_key_public_id: input.actorApiKeyPublicId ?? null,
    target_user_public_id: input.targetUserPublicId ?? null,
    organization_public_id: input.organizationPublicId ?? null,
    action: input.action,
    resource_type: input.resourceType,
    resource_id: input.resourceId ?? null,
    ip_address: input.ipAddress ?? null,
    user_agent: input.userAgent ?? null,
    severity: input.severity ?? 'INFO',
    metadata: input.metadata ?? {},
  });
  const affectedRows = (result as unknown as { count?: number }).count ?? 0;
  if (affectedRows !== 1) {
    throw new Error('audit.outbox INSERT staged no row');
  }
}

/**
 * Repository factory exposed to the audit-outbox drain worker. Takes the pinned
 * drain-context database handle (from {@link withMaintenanceDatabaseContext})
 * and returns the read/update queries the worker needs.
 *
 * @remarks
 * - **Algorithm:** asserts the caller is inside `audit_outbox_drain` context (in
 *   worker runtime) and binds every query to the supplied transaction handle.
 * - **Failure modes:** {@link assertWorkerRlsGucSet} throws if the drain GUC is
 *   missing — surfaces wiring bugs as a hard error rather than silent failure.
 * - **Side effects:** none from the factory itself; per-query side effects are
 *   documented on each returned method.
 */
export function createDrainAuditOutboxRepository(databaseHandle: RequestScopedPostgresDatabase) {
  return {
    /**
     * Atomically claims up to `limit` PENDING rows using
     * `FOR UPDATE SKIP LOCKED` so concurrent drain instances never double-process.
     * Increments `attempt_count` so a row that fails repeatedly is bounded.
     */
    async claimPendingBatch(limit: number): Promise<AuditOutboxRow[]> {
      await assertWorkerRlsGucSet(databaseHandle, 'audit_outbox_drain');
      // Drizzle has no first-class FOR UPDATE SKIP LOCKED on `select()`, so use a
      // raw SQL UPDATE..FROM..RETURNING which is both atomic and skip-locked.
      // The locking SELECT lives in a MATERIALIZED CTE deliberately: as a plain
      // FROM-subquery the planner may pick a nested loop that RESCANS it per
      // target row, and each rescan locks `limit` MORE rows (SKIP LOCKED skips
      // the ones it just locked) — the claim escalates past its limit. Observed
      // under RLS-subject roles (plans differ from the RLS-exempt superuser);
      // MATERIALIZED pins one execution of the locking scan.
      const result = await databaseHandle.execute<AuditOutboxRow>(drizzleSql`
        WITH claimable AS MATERIALIZED (
          SELECT id
            FROM audit.outbox
           WHERE status = 'PENDING'
           ORDER BY created_at ASC
           LIMIT ${limit}
             FOR UPDATE SKIP LOCKED
        )
        UPDATE audit.outbox
           SET attempt_count = audit.outbox.attempt_count + 1,
               updated_at = NOW()
          FROM claimable
         WHERE audit.outbox.id = claimable.id
        RETURNING audit.outbox.*
      `);
      const rows = Array.isArray(result)
        ? (result as AuditOutboxRow[])
        : ((result as { rows?: AuditOutboxRow[] }).rows ?? []);
      return rows;
    },

    /** Stamps a successful drain — `status='PROCESSED'`, `processed_at=NOW()`. */
    async markProcessed(ids: number[]): Promise<void> {
      if (ids.length === 0) return;
      await databaseHandle
        .update(audit_outbox)
        .set({
          status: 'PROCESSED',
          processed_at: new Date(),
          updated_at: new Date(),
        })
        .where(inArray(audit_outbox.id, ids));
    },

    /**
     * Records a transient drain failure (status stays `PENDING`, error captured) so the
     * row is retried on the next drain pass — the claim path already bumped
     * `attempt_count`, so retries are bounded by {@link markPermanentlyFailed}.
     */
    async recordTransientFailure(id: number, error: string): Promise<void> {
      await databaseHandle
        .update(audit_outbox)
        .set({
          last_error: error.slice(0, 4_000),
          updated_at: new Date(),
        })
        .where(eq(audit_outbox.id, id));
    },

    /**
     * Marks a row terminally failed — drain stops retrying. Used when the row is
     * unresolvable (e.g. organization deleted between insert and drain) or has
     * exceeded the per-row attempt cap.
     */
    async markPermanentlyFailed(id: number, error: string): Promise<void> {
      await databaseHandle
        .update(audit_outbox)
        .set({
          status: 'FAILED',
          last_error: error.slice(0, 4_000),
          updated_at: new Date(),
        })
        .where(eq(audit_outbox.id, id));
    },

    /**
     * Backstop telemetry (sec-r7/M2) for the drain worker: the count of still-PENDING rows, the
     * highest `attempt_count` among them, and the age in seconds of the oldest one. A wedged or
     * chronically-failing queue shows up as a growing oldest-age / max-attempts even though the
     * per-row attempt cap now bounds retries.
     *
     * @remarks
     * - **Algorithm:** single aggregate `SELECT` over `audit.outbox WHERE status = 'PENDING'`.
     * - **Failure modes:** propagates query errors; expected to run inside the drain context.
     * - **Side effects:** read-only.
     * - **Notes:** `oldestPendingAgeSeconds` / `maxAttemptCount` are `0` when nothing is pending.
     */
    async getPendingBacklogStats(): Promise<{
      pendingCount: number;
      oldestPendingAgeSeconds: number;
      maxAttemptCount: number;
    }> {
      const result = await databaseHandle.execute<{
        pending_count: number;
        oldest_age_seconds: number;
        max_attempt_count: number;
      }>(drizzleSql`
        SELECT
          COUNT(*)::int AS pending_count,
          COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)::int AS oldest_age_seconds,
          COALESCE(MAX(attempt_count), 0)::int AS max_attempt_count
        FROM audit.outbox
        WHERE status = 'PENDING'
      `);
      const rows = Array.isArray(result)
        ? (result as {
            pending_count: number;
            oldest_age_seconds: number;
            max_attempt_count: number;
          }[])
        : ((
            result as {
              rows?: {
                pending_count: number;
                oldest_age_seconds: number;
                max_attempt_count: number;
              }[];
            }
          ).rows ?? []);
      const stats = rows[0];
      return {
        pendingCount: stats?.pending_count ?? 0,
        oldestPendingAgeSeconds: stats?.oldest_age_seconds ?? 0,
        maxAttemptCount: stats?.max_attempt_count ?? 0,
      };
    },

    /**
     * Returns ids of PROCESSED rows older than `olderThan` so the retention worker
     * can prune them. PROCESSED rows are safe to delete — the canonical record is
     * in `audit.logs`.
     */
    async findProcessedRowsOlderThan(olderThan: Date, limit: number): Promise<number[]> {
      const rows = await databaseHandle
        .select({ id: audit_outbox.id })
        .from(audit_outbox)
        .where(and(eq(audit_outbox.status, 'PROCESSED'), lt(audit_outbox.processed_at, olderThan)))
        .orderBy(asc(audit_outbox.processed_at))
        .limit(limit);
      return rows.map((row: { id: number }) => row.id);
    },

    /** Bulk delete drained outbox rows by id. */
    async deleteByIds(ids: number[]): Promise<number> {
      if (ids.length === 0) return 0;
      const deleted = await databaseHandle
        .delete(audit_outbox)
        .where(inArray(audit_outbox.id, ids))
        .returning({ id: audit_outbox.id });
      return deleted.length;
    },
  };
}

/** Type alias to ease wiring in tests / DI. */
export type DrainAuditOutboxRepository = ReturnType<typeof createDrainAuditOutboxRepository>;
