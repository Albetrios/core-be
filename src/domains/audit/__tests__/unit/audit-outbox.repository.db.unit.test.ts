import { asc, eq, desc } from 'drizzle-orm';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createDrainAuditOutboxRepository,
  insertAuditOutboxRow,
} from '@/domains/audit/audit-outbox.repository.js';
import { audit_outbox } from '@/domains/audit/audit-outbox.schema.js';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

/**
 * `audit-outbox.repository.ts` was the largest untested surface in the audit domain: four
 * exports, no dedicated test, exercised only through the drain processor's mocks. The mocks
 * prove the processor calls the repository correctly; nothing proved the repository's SQL is
 * correct — and its central query is a hand-written `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP
 * LOCKED)` that Drizzle cannot express, so a mistake there is invisible above this layer.
 *
 * DB-bound unit (`*.db.unit.test.ts`): real Postgres, serial execution.
 */
const ACTOR_PUBLIC_ID = 'usr_auditoutboxrepo000001';

/**
 * `claimPendingBatch` is a raw `execute()` — postgres-js returns it unmapped, so the `bigserial`
 * `id` and `smallint` `attempt_count` arrive as STRINGS even though `AuditOutboxRow` types them
 * as `number`. Harmless in production (every consumer feeds them straight back into `eq()` /
 * `inArray()`, which bind them as SQL literals either way), but it means an `=== number`
 * assertion on a claimed row silently fails. Normalize here and pin the discrepancy below rather
 * than letting the next reader rediscover it.
 */
function outboxRowId(row: { id: number }): number {
  return Number(row.id);
}

/**
 * Stages a tenantless PENDING row through the real write path (RLS context included)
 * and resolves its id via a superuser read-back — `insertAuditOutboxRow` no longer
 * RETURNINGs the id (SELECT on audit.outbox is drain-exclusive under RLS).
 */
async function stagePendingRow(action: string): Promise<number> {
  await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.SYSTEM_AUDIT_INSERT, () =>
    insertAuditOutboxRow({
      actorUserPublicId: ACTOR_PUBLIC_ID,
      action,
      resourceType: 'user',
      metadata: { source: 'audit-outbox.repository.db.unit' },
    }),
  );
  const [row] = await database
    .select({ id: audit_outbox.id })
    .from(audit_outbox)
    .where(eq(audit_outbox.action, action))
    .orderBy(desc(audit_outbox.id))
    .limit(1);
  if (!row) throw new Error(`staged row for ${action} not found`);
  return Number(row.id);
}

describe('audit-outbox.repository (database)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  /**
   * The affected-row guard is not cosmetic — `insertAuditOutboxRow` throws when the INSERT
   * stages no row, which turns a silently-dropped audit row into a loud failure. (It no longer
   * RETURNINGs the id: Postgres applies SELECT-policy visibility to RETURNING rows, and outbox
   * SELECT is drain-exclusive — a RETURNING would be rejected under the RLS-subject app roles.)
   * Prove the row is real by reading it back as the superuser test pool.
   */
  it('insertAuditOutboxRow returns the new id and stages a PENDING row with the payload', async () => {
    const insertedId = await stagePendingRow('user.login');

    expect(insertedId).toBeGreaterThan(0);
    const [row] = await database.select().from(audit_outbox).where(eq(audit_outbox.id, insertedId));

    expect(row).toBeDefined();
    expect(row).toMatchObject({
      status: 'PENDING',
      actor_user_public_id: ACTOR_PUBLIC_ID,
      organization_public_id: null,
      action: 'user.login',
      resource_type: 'user',
      severity: 'INFO',
      attempt_count: 0,
      processed_at: null,
    });
    expect(row?.metadata).toEqual({ source: 'audit-outbox.repository.db.unit' });
  });

  /**
   * The claim is the work-queue primitive. Two drain replicas racing the same backlog must
   * partition it, never overlap — an overlap means the same audit event is copied into the
   * append-only ledger twice, which nothing downstream can undo. `SKIP LOCKED` is what makes the
   * two claims disjoint; without it the second claimer blocks and then re-reads the same ids.
   */
  it('claimPendingBatch partitions the backlog between two overlapping drains (FOR UPDATE SKIP LOCKED)', async () => {
    const ROW_COUNT = 12;
    const HALF = ROW_COUNT / 2;
    for (let index = 0; index < ROW_COUNT; index += 1) {
      await stagePendingRow(`user.concurrent.${index}`);
    }

    // The claim does NOT flip `status` — it only bumps `attempt_count` and holds a row lock, so
    // exclusivity lasts exactly as long as the claiming transaction. The real processor claims,
    // inserts, and marks PROCESSED inside ONE transaction, which is why a second replica never
    // sees the batch. Reproduce that by nesting: drain B claims while drain A's transaction is
    // still open. Two sequential `Promise.all` contexts would NOT reproduce it — if A commits
    // first, its rows are still PENDING and B legitimately re-claims them.
    const { claimedA, claimedB } = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN,
      async (handleA) => {
        const batchA = await createDrainAuditOutboxRepository(handleA).claimPendingBatch(HALF);
        const batchB = await withMaintenanceDatabaseContext(
          MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN,
          (handleB) => createDrainAuditOutboxRepository(handleB).claimPendingBatch(HALF),
        );
        return { claimedA: batchA, claimedB: batchB };
      },
    );

    expect(claimedA).toHaveLength(HALF);
    expect(claimedB).toHaveLength(HALF);

    const idsA = claimedA.map((row) => outboxRowId(row));
    const idsB = claimedB.map((row) => outboxRowId(row));
    // Disjoint: no id appears in both claims — the ledger never gets a duplicate entry.
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    // Complete: together they cover every staged row exactly once.
    expect(new Set([...idsA, ...idsB]).size).toBe(ROW_COUNT);
    // The claim bumps attempt_count, which is what bounds retries for a poison row.
    expect([...claimedA, ...claimedB].every((row) => Number(row.attempt_count) === 1)).toBe(true);
  });

  /**
   * The other half of `SKIP LOCKED`: when every candidate row is already locked, the second
   * claimer returns an EMPTY batch immediately rather than waiting. Drop `SKIP LOCKED` and this
   * inner claim blocks on the outer transaction's locks — two drain replicas serialize, and on a
   * long batch the waiter dies on the worker statement timeout instead of doing useful work.
   * The assertion is as much "this test terminates" as it is the empty result.
   */
  it('a fully-locked backlog yields an empty batch to the next claimer instead of blocking', async () => {
    await stagePendingRow('user.locked');

    const claimedByInnerDrain = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN,
      async (outerHandle) => {
        const outerClaim =
          await createDrainAuditOutboxRepository(outerHandle).claimPendingBatch(10);
        expect(outerClaim).toHaveLength(1);

        // Still inside the outer transaction — its row lock is held.
        return withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN, (innerHandle) =>
          createDrainAuditOutboxRepository(innerHandle).claimPendingBatch(10),
        );
      },
    );

    expect(claimedByInnerDrain).toEqual([]);
  });

  /**
   * The batch limit is what keeps a drain pass bounded when a backlog builds up: it caps the
   * transaction length, the lock footprint, and the memory the processor holds. An unbounded
   * claim over a large backlog would hold locks for the whole sweep. Ordering is oldest-first so
   * the backlog drains FIFO and `oldestPendingAgeSeconds` telemetry stays meaningful.
   */
  it('claimPendingBatch respects its limit and claims the oldest rows first', async () => {
    const stagedIds: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      stagedIds.push(await stagePendingRow(`user.ordered.${index}`));
    }

    const claimed = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN,
      (databaseHandle) => createDrainAuditOutboxRepository(databaseHandle).claimPendingBatch(2),
    );

    expect(claimed).toHaveLength(2);
    expect(claimed.map((row) => outboxRowId(row)).sort((left, right) => left - right)).toEqual(
      stagedIds.slice(0, 2),
    );

    // The three unclaimed rows are untouched — still PENDING at attempt_count 0.
    const remaining = await database
      .select()
      .from(audit_outbox)
      .where(eq(audit_outbox.attempt_count, 0))
      .orderBy(asc(audit_outbox.id));
    expect(remaining.map((row) => row.id)).toEqual(stagedIds.slice(2));
  });

  /**
   * The retry-boundedness contract's linchpin: a below-cap transient failure captures the error
   * but MUST leave `status = 'PENDING'` so the next drain pass re-claims the row. The drain
   * integration test proves the terminal transitions (`markProcessed` → PROCESSED,
   * `markPermanentlyFailed` → FAILED) against real SQL, but the transient path was only ever
   * asserted through the processor's mock — if a refactor made this flip `status`, a transient
   * failure would either stop retrying or escape the attempt cap, invisibly above the mock.
   */
  it('recordTransientFailure captures last_error but keeps the row PENDING for a bounded retry', async () => {
    const stagedId = await stagePendingRow('user.transient');

    await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN, (handle) =>
      createDrainAuditOutboxRepository(handle).recordTransientFailure(stagedId, 'rls-rejected'),
    );

    const [row] = await database.select().from(audit_outbox).where(eq(audit_outbox.id, stagedId));
    expect(row?.status).toBe('PENDING');
    expect(row?.last_error).toBe('rls-rejected');
  });

  /**
   * `last_error` is capped at 4000 chars so one pathological error message (a giant stack, a
   * dumped payload) cannot bloat the outbox row width unboundedly. Only the mock ever saw the
   * `.slice(0, 4_000)`; prove it against the real column.
   */
  it('recordTransientFailure truncates an oversized last_error to 4000 chars', async () => {
    const stagedId = await stagePendingRow('user.transient.long');

    await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN, (handle) =>
      createDrainAuditOutboxRepository(handle).recordTransientFailure(stagedId, 'x'.repeat(5_000)),
    );

    const [row] = await database.select().from(audit_outbox).where(eq(audit_outbox.id, stagedId));
    expect(row?.last_error).toHaveLength(4_000);
  });

  /**
   * `getPendingBacklogStats` feeds the drain-depth alarm (backlog size, oldest age, retry pressure).
   * It was only ever mocked in the processor test, so the aggregate SQL — the `WHERE status =
   * 'PENDING'` scope and the three COALESCE/EXTRACT expressions — never ran. Prove it on real rows.
   */
  it('getPendingBacklogStats returns all zeros for an empty backlog', async () => {
    const stats = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN,
      (handle) => createDrainAuditOutboxRepository(handle).getPendingBacklogStats(),
    );
    expect(stats).toEqual({ pendingCount: 0, oldestPendingAgeSeconds: 0, maxAttemptCount: 0 });
  });

  it('getPendingBacklogStats aggregates only PENDING rows — oldest age and max attempt_count', async () => {
    const oldest = await stagePendingRow('user.oldest');
    await stagePendingRow('user.mid');
    const processed = await stagePendingRow('user.processed');

    // Backdate the oldest row so oldest-age is provably > 0.
    await database
      .update(audit_outbox)
      .set({ created_at: new Date(Date.now() - 120_000) })
      .where(eq(audit_outbox.id, oldest));

    // One claim bumps every row's attempt_count to 1 (rows stay PENDING); then remove one row from
    // the PENDING set via PROCESSED so the count/scope is exercised, not just the aggregates.
    await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN, (handle) =>
      createDrainAuditOutboxRepository(handle).claimPendingBatch(10),
    );
    await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN, (handle) =>
      createDrainAuditOutboxRepository(handle).markProcessed([processed]),
    );

    const stats = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN,
      (handle) => createDrainAuditOutboxRepository(handle).getPendingBacklogStats(),
    );
    expect(stats.pendingCount).toBe(2); // the PROCESSED row is excluded by the WHERE scope
    expect(stats.maxAttemptCount).toBe(1); // the claim bumped attempt_count
    expect(stats.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(100);
  });
});
