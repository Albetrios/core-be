import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { eq } from 'drizzle-orm';
import { audit_outbox } from '@/domains/audit/audit-outbox.schema.js';
import { logs } from '@/domains/audit/audit.schema.js';
import {
  countPendingAuditOutboxRows,
  runAuditOutboxDrainJob,
} from '@/domains/audit/workers/audit-outbox-drain.processor.js';
import { users } from '@/domains/user/user.schema.js';
import { database } from '@/infrastructure/database/connection.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { setLocalDatabaseConfig } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

/** Stable actor public id reused across runs (truncated by cleanupDatabase each test). */
const ACTOR_PUBLIC_ID = 'usr_auditoutboxdrain00001';

async function pendingOutboxCount(): Promise<number> {
  return withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN, (databaseHandle) =>
    countPendingAuditOutboxRows(databaseHandle),
  );
}

describe('Integration: audit transactional outbox drain', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('drains a PENDING tenantless row into audit.logs and empties the outbox', async () => {
    await getOperatorDatabase().insert(users).values({
      public_id: ACTOR_PUBLIC_ID,
      email: 'audit-drain@example.com',
      email_hash: 'audit-drain-hash',
    });
    await getOperatorDatabase()
      .insert(audit_outbox)
      .values({
        status: 'PENDING',
        actor_user_public_id: ACTOR_PUBLIC_ID,
        organization_public_id: null,
        action: 'user.login',
        resource_type: 'user',
        severity: 'INFO',
        metadata: { source: 'audit-outbox-drain.integration' },
      });

    expect(await pendingOutboxCount()).toBe(1);

    const result = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN,
      (databaseHandle) => runAuditOutboxDrainJob(databaseHandle),
    );

    // The drain actually emptied the queue — the assertion the unused
    // countPendingAuditOutboxRows seam was written for.
    expect(result).toEqual({ drained: 1, transientFailed: 0, permanentlyFailed: 0 });
    expect(await pendingOutboxCount()).toBe(0);

    // The canonical ledger row landed with the outbox payload copied verbatim.
    const auditRows = await getOperatorDatabase()
      .select()
      .from(logs)
      .where(eq(logs.action, 'user.login'));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.resource_type).toBe('user');
    expect(auditRows[0]?.metadata).toEqual({ source: 'audit-outbox-drain.integration' });

    // The outbox row is marked PROCESSED (not deleted) so retention can prune it.
    const outboxRows = await getOperatorDatabase().select().from(audit_outbox);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.status).toBe('PROCESSED');
    expect(outboxRows[0]?.processed_at).not.toBeNull();
  });

  it('marks an unresolvable-actor row FAILED and writes no audit.logs row', async () => {
    await getOperatorDatabase().insert(audit_outbox).values({
      status: 'PENDING',
      actor_user_public_id: 'usr_doesnotexist00000001',
      organization_public_id: null,
      action: 'user.deleted',
      resource_type: 'user',
    });

    const result = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN,
      (databaseHandle) => runAuditOutboxDrainJob(databaseHandle),
    );

    expect(result).toEqual({ drained: 0, transientFailed: 0, permanentlyFailed: 1 });
    expect(await pendingOutboxCount()).toBe(0);
    expect(await getOperatorDatabase().select().from(logs)).toHaveLength(0);

    const outboxRows = await getOperatorDatabase().select().from(audit_outbox);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.status).toBe('FAILED');
    expect(outboxRows[0]?.last_error).toMatch(/actor public_id did not resolve/);
  });

  it('two concurrent drainers process each row exactly once (FOR UPDATE SKIP LOCKED)', async () => {
    // The scheduler can run on >1 replica. `claimPendingBatch` uses FOR UPDATE SKIP LOCKED so
    // two drainers racing the same backlog partition the rows instead of both copying a row into
    // audit.logs (a duplicate ledger entry). The single-drainer test above cannot prove this.
    await getOperatorDatabase().insert(users).values({
      public_id: ACTOR_PUBLIC_ID,
      email: 'audit-drain-concurrent@example.com',
      email_hash: 'audit-drain-concurrent-hash',
    });

    const ROW_COUNT = 24;
    await getOperatorDatabase()
      .insert(audit_outbox)
      .values(
        Array.from({ length: ROW_COUNT }, (_, index) => ({
          status: 'PENDING' as const,
          actor_user_public_id: ACTOR_PUBLIC_ID,
          organization_public_id: null,
          action: 'user.login',
          resource_type: 'user',
          severity: 'INFO',
          metadata: { source: 'audit-outbox-drain.concurrent', index },
        })),
      );
    expect(await pendingOutboxCount()).toBe(ROW_COUNT);

    // Two independent drain contexts (two worker replicas) racing the same backlog.
    const [resultA, resultB] = await Promise.all([
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN, (databaseHandle) =>
        runAuditOutboxDrainJob(databaseHandle),
      ),
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN, (databaseHandle) =>
        runAuditOutboxDrainJob(databaseHandle),
      ),
    ]);

    // No row drained twice: the two runs together drain exactly ROW_COUNT, with no overlap.
    expect(resultA.drained + resultB.drained).toBe(ROW_COUNT);
    expect(resultA.permanentlyFailed + resultB.permanentlyFailed).toBe(0);
    expect(await pendingOutboxCount()).toBe(0);

    // The canonical ledger has exactly ROW_COUNT rows — a broken SKIP LOCKED would double-insert.
    const auditRows = await getOperatorDatabase()
      .select()
      .from(logs)
      .where(eq(logs.action, 'user.login'));
    expect(auditRows).toHaveLength(ROW_COUNT);

    // Every outbox row is PROCESSED exactly once.
    const outboxRows = await getOperatorDatabase().select().from(audit_outbox);
    expect(outboxRows).toHaveLength(ROW_COUNT);
    expect(outboxRows.every((row) => row.status === 'PROCESSED')).toBe(true);
  });

  it('sec-r7/M2: a nested-transaction savepoint isolates a failed audit.logs insert from the batch', async () => {
    // Drives the EXACT mechanism `drainOutboxRow` now uses against the real postgres-js / drizzle
    // drain transaction: the per-row INSERT runs in a NESTED transaction (a SAVEPOINT). A genuinely
    // failing insert (invalid severity violates chk_audit_severity) rolls the nested transaction
    // back and re-throws; the OUTER batch transaction must stay usable so a subsequent VALID insert
    // still commits. This proves the failed row does NOT wedge the batch on the real driver — raw
    // `SAVEPOINT` via execute() does not survive postgres-js's transaction-error state, so the
    // nested transaction is the supported mechanism.
    await getOperatorDatabase().insert(users).values({
      public_id: ACTOR_PUBLIC_ID,
      email: 'audit-drain-savepoint@example.com',
      email_hash: 'audit-drain-savepoint-hash',
    });
    const [actor] = await getOperatorDatabase()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.public_id, ACTOR_PUBLIC_ID));

    const failedThenRecovered = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.AUDIT_OUTBOX_DRAIN,
      async (databaseHandle) => {
        let failed = false;
        try {
          await databaseHandle.transaction(async (savepoint) => {
            await setLocalDatabaseConfig(savepoint, 'app.system_audit_insert', 'true');
            await savepoint.insert(logs).values({
              actor_user_id: actor!.id,
              organization_id: null,
              action: 'poison.savepoint',
              resource_type: 'user',
              severity: 'NOT_A_VALID_SEVERITY', // violates chk_audit_severity
              metadata: {},
            });
          });
        } catch {
          // drizzle rolled the nested transaction back to its savepoint and re-threw.
          failed = true;
        }

        // The outer batch transaction must still be usable: this VALID insert commits.
        await setLocalDatabaseConfig(databaseHandle, 'app.system_audit_insert', 'true');
        await databaseHandle.insert(logs).values({
          actor_user_id: actor!.id,
          organization_id: null,
          action: 'recovered.savepoint',
          resource_type: 'user',
          severity: 'INFO',
          metadata: {},
        });
        return failed;
      },
    );

    expect(failedThenRecovered).toBe(true);
    // The valid row committed despite the earlier failed statement → savepoint isolation works.
    const recovered = await getOperatorDatabase()
      .select()
      .from(logs)
      .where(eq(logs.action, 'recovered.savepoint'));
    expect(recovered).toHaveLength(1);
    // The poison row was rolled back with the nested transaction — never persisted.
    const poison = await getOperatorDatabase()
      .select()
      .from(logs)
      .where(eq(logs.action, 'poison.savepoint'));
    expect(poison).toHaveLength(0);
  });
});
