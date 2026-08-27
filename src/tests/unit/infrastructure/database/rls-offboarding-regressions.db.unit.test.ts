import { sql as drizzleSql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { database } from '@/infrastructure/database/connection.js';

/**
 * Regressions for the superuser-masked RLS bugs fixed by migration
 * 20260827040000 (and the user.service global_admin soft-delete switch). Each
 * case runs as the RLS-subject `core_be_app` role via `SET LOCAL ROLE`, which
 * is what production connects as — the local superuser pool would mask all of
 * these (they were found exactly that way).
 */
async function executeAsAppRole<T>(statements: (tx: typeof database) => Promise<T>): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
    const result = await statements(transaction as unknown as typeof database);
    // Roll back so fixtures never leak between cases.
    throw new RollbackSignal(result);
  }) as never;
}

class RollbackSignal<T> extends Error {
  constructor(public readonly result: T) {
    super('rollback-on-purpose');
  }
}

async function runRolledBack<T>(statements: (tx: typeof database) => Promise<T>): Promise<T> {
  try {
    return await executeAsAppRole(statements);
  } catch (error) {
    if (error instanceof RollbackSignal) return error.result as T;
    throw error;
  }
}

async function seedUser(tx: typeof database, publicId: string): Promise<void> {
  await tx.execute(
    drizzleSql`INSERT INTO auth.users (public_id, email, email_hash, status)
               VALUES (${publicId}, ${`${publicId}@example.com`}, ${`hash-${publicId}`}, 'ACTIVE')`,
  );
}

describe('RLS offboarding regressions (as core_be_app)', () => {
  it('user soft-delete succeeds under global_admin and stays rejected under the plain user scope', async () => {
    const outcome = await runRolledBack(async (tx) => {
      // Seed BEFORE SET ROLE is not possible inside this tx (role already set) —
      // the user arm's WITH CHECK admits the self insert, so seed under the user GUC.
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_user_public_id', 'usr_rlsregression000001', true)`,
      );
      await seedUser(tx, 'usr_rlsregression000001');

      // Plain user scope: tombstoning must FAIL (NEW row loses SELECT visibility).
      let selfScopeRejected = false;
      try {
        await tx.execute(drizzleSql`SAVEPOINT self_attempt`);
        await tx.execute(
          drizzleSql`UPDATE auth.users SET deleted_at = now()
                     WHERE public_id = 'usr_rlsregression000001' AND deleted_at IS NULL`,
        );
        await tx.execute(drizzleSql`RELEASE SAVEPOINT self_attempt`);
      } catch {
        selfScopeRejected = true;
        await tx.execute(drizzleSql`ROLLBACK TO SAVEPOINT self_attempt`);
      }

      // global_admin (the context user.service now uses for the final softDelete step).
      await tx.execute(drizzleSql`SELECT set_config('app.global_admin', 'true', true)`);
      const updated = await tx.execute<{ public_id: string }>(
        drizzleSql`UPDATE auth.users SET deleted_at = now()
                   WHERE public_id = 'usr_rlsregression000001' AND deleted_at IS NULL
                   RETURNING public_id`,
      );
      const rows = Array.isArray(updated)
        ? updated
        : ((updated as { rows?: unknown[] }).rows ?? []);
      return { selfScopeRejected, adminUpdateCount: rows.length };
    });

    expect(outcome.selfScopeRejected).toBe(true);
    expect(outcome.adminUpdateCount).toBe(1);
  });

  it('organization soft-delete is rejected under the plain org scope and succeeds under retention (sec-new-D3 kept)', async () => {
    const outcome = await runRolledBack(async (tx) => {
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_user_public_id', 'usr_rlsregression000002', true)`,
      );
      await seedUser(tx, 'usr_rlsregression000002');
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_public_id', 'org_rlsregression00001', true)`,
      );
      await tx.execute(
        drizzleSql`INSERT INTO tenancy.organizations (public_id, name, owner_user_id)
                   VALUES ('org_rlsregression00001', 'RLS Regression Org',
                           (SELECT id FROM auth.users WHERE public_id = 'usr_rlsregression000002'))`,
      );
      // Plain org scope: the sec-new-D3 SELECT gate hides the tombstoned NEW row → 42501.
      let orgScopeRejected = false;
      try {
        await tx.execute(drizzleSql`SAVEPOINT org_attempt`);
        await tx.execute(
          drizzleSql`UPDATE tenancy.organizations SET deleted_at = now()
                     WHERE public_id = 'org_rlsregression00001' AND deleted_at IS NULL`,
        );
        await tx.execute(drizzleSql`RELEASE SAVEPOINT org_attempt`);
      } catch {
        orgScopeRejected = true;
        await tx.execute(drizzleSql`ROLLBACK TO SAVEPOINT org_attempt`);
      }

      // Retention context (what organization.service now uses for the tombstone step).
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_public_id', '', true)`,
      );
      await tx.execute(drizzleSql`SELECT set_config('app.global_retention_cleanup', 'true', true)`);
      const updated = await tx.execute(
        drizzleSql`UPDATE tenancy.organizations SET deleted_at = now()
                   WHERE public_id = 'org_rlsregression00001' AND deleted_at IS NULL
                   RETURNING public_id`,
      );
      const rows = Array.isArray(updated)
        ? updated
        : ((updated as { rows?: unknown[] }).rows ?? []);
      return { orgScopeRejected, retentionUpdateCount: rows.length };
    });
    expect(outcome.orgScopeRejected).toBe(true);
    expect(outcome.retentionUpdateCount).toBe(1);
  });

  it('retention context can see users rows (tombstone purge + offboarding reconciler scans)', async () => {
    const visible = await runRolledBack(async (tx) => {
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_user_public_id', 'usr_rlsregression000003', true)`,
      );
      await seedUser(tx, 'usr_rlsregression000003');
      await tx.execute(drizzleSql`SELECT set_config('app.current_user_public_id', '', true)`);
      await tx.execute(drizzleSql`SELECT set_config('app.global_retention_cleanup', 'true', true)`);
      const rows = await tx.execute(
        drizzleSql`SELECT public_id FROM auth.users WHERE public_id = 'usr_rlsregression000003'`,
      );
      const resultRows = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
      return resultRows.length;
    });
    expect(visible).toBe(1);
  });

  it('the audit drain resolvers return org and api-key ids under global_admin only', async () => {
    const outcome = await runRolledBack(async (tx) => {
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_user_public_id', 'usr_rlsregression000004', true)`,
      );
      await seedUser(tx, 'usr_rlsregression000004');
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_public_id', 'org_rlsregression00002', true)`,
      );
      await tx.execute(
        drizzleSql`INSERT INTO tenancy.organizations (public_id, name, owner_user_id)
                   VALUES ('org_rlsregression00002', 'RLS Drain Org',
                           (SELECT id FROM auth.users WHERE public_id = 'usr_rlsregression000004'))`,
      );
      // Drop every GUC — the drain resolves under app.global_admin only.
      await tx.execute(drizzleSql`SELECT set_config('app.current_user_public_id', '', true)`);
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_public_id', '', true)`,
      );
      await tx.execute(drizzleSql`SELECT set_config('app.global_admin', 'true', true)`);

      const direct = await tx.execute(
        drizzleSql`SELECT id FROM tenancy.organizations WHERE public_id = 'org_rlsregression00002'`,
      );
      const directRows = Array.isArray(direct)
        ? direct
        : ((direct as { rows?: unknown[] }).rows ?? []);

      const resolved = await tx.execute(
        drizzleSql`SELECT id, public_id FROM audit.resolve_organization_ids_for_public_ids(ARRAY['org_rlsregression00002']::text[])`,
      );
      const resolvedRows = Array.isArray(resolved)
        ? resolved
        : ((resolved as { rows?: unknown[] }).rows ?? []);
      return { directCount: directRows.length, resolvedCount: resolvedRows.length };
    });

    // The plain select stays blocked (global_admin grants nothing on tenancy.*) —
    // the SECURITY DEFINER resolver is what makes the drain work.
    expect(outcome.directCount).toBe(0);
    expect(outcome.resolvedCount).toBe(1);
  });
});
