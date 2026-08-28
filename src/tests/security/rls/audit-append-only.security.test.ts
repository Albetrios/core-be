import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { sql as drizzleSql, eq } from 'drizzle-orm';
import { sql } from '@/infrastructure/database/connection.js';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { logs } from '@/domains/audit/audit.schema.js';
import {
  grantCoreBeAppRoleForTests,
  executeAsCoreBeAppTenant,
} from '@/tests/helpers/rls-matrix.helper.js';

/**
 * Regression for sec-U3 (High): `audit.logs` was RLS-isolated with a single
 * `FOR ALL` policy whose USING predicate doubled as the write predicate. Any
 * caller with the correct `app.current_organization_public_id` GUC could UPDATE or
 * DELETE audit rows for their own organization through the standard
 * `core_be_app` role. Append-only was convention, not invariant.
 *
 * The fix splits the policy and tightens grants:
 *   1. `audit_logs_tenant_isolation_select`  FOR SELECT (USING unchanged)
 *   2. `audit_logs_tenant_isolation_insert`  FOR INSERT (WITH CHECK unchanged)
 *   3. `audit_logs_tenant_isolation_delete`  FOR DELETE — retention-only
 *   4. No UPDATE policy → RLS denies updates structurally
 *   5. `REVOKE UPDATE ON audit.logs FROM core_be_app` → grant-layer denial
 *      fires before RLS, surfacing as `permission denied` rather than a silent
 *      zero-row affected count.
 *
 * Together these make audit tampering visible at the DB layer: an UPDATE
 * throws, a non-retention DELETE silently affects zero rows (still in place),
 * and only the retention worker (`withMaintenanceDatabaseContext`)
 * can purge old rows.
 */
async function isPolicySplitMigrationApplied(): Promise<boolean> {
  const rows = await sql<{ has_split: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'audit'
        AND tablename = 'logs'
        AND policyname = 'audit_logs_tenant_isolation_insert'
    ) AS has_split
  `;
  return rows[0]?.has_split === true;
}

describe('Security: audit.logs is append-only at the DB layer (sec-U3)', () => {
  let migrationApplied = false;

  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
    migrationApplied = await isPolicySplitMigrationApplied();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  async function seedAuditRowForOrganization(organizationId: number): Promise<number> {
    const inserted = await database
      .insert(logs)
      .values({
        actor_user_id: null,
        actor_api_key_id: null,
        target_user_id: null,
        organization_id: organizationId,
        action: 'test.event',
        resource_type: 'test',
        resource_id: null,
        ip_address: '127.0.0.1',
        user_agent: 'vitest',
        metadata: {},
      })
      .returning({ id: logs.id });
    return inserted[0]!.id;
  }

  it('REVOKE UPDATE denies a tenant-scoped UPDATE on audit.logs (grant-layer)', async () => {
    expect(
      migrationApplied,
      'apply migration adding split RLS policies + REVOKE UPDATE on audit.logs',
    ).toBe(true);
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const rowId = await seedAuditRowForOrganization(organization.id);

    let caught: unknown;
    try {
      await executeAsCoreBeAppTenant(organization.public_id, async (transaction) => {
        await transaction.execute(
          drizzleSql`UPDATE audit.logs SET metadata = '{"tampered":true}'::jsonb WHERE id = ${rowId}`,
        );
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const errorChain = [
      String(caught),
      String((caught as { cause?: unknown }).cause ?? ''),
      String((caught as { message?: string }).message ?? ''),
    ].join(' ');
    // postgres-js surfaces the SQLSTATE 42501 with `permission denied for table logs`.
    expect(errorChain).toMatch(/permission denied/i);

    // Row metadata is unchanged.
    const after = await database
      .select({ metadata: logs.metadata })
      .from(logs)
      .where(eq(logs.id, rowId));
    expect(after[0]?.metadata).toEqual({});
  });

  it('a tenant-scoped DELETE on audit.logs silently affects 0 rows under tenant context', async () => {
    if (!migrationApplied) return;
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const rowId = await seedAuditRowForOrganization(organization.id);

    // Grant DELETE is kept (retention needs it), so this does NOT throw — RLS
    // filters DELETE candidates to zero. The row must remain in place.
    await executeAsCoreBeAppTenant(organization.public_id, async (transaction) => {
      await transaction.execute(drizzleSql`DELETE FROM audit.logs WHERE id = ${rowId}`);
    });

    const after = await database.select({ id: logs.id }).from(logs).where(eq(logs.id, rowId));
    expect(after).toHaveLength(1);
  });

  it('the retention worker context CAN DELETE old audit rows', async () => {
    if (!migrationApplied) return;
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const rowId = await seedAuditRowForOrganization(organization.id);

    await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      async (databaseHandle) => {
        await databaseHandle.execute(drizzleSql`DELETE FROM audit.logs WHERE id = ${rowId}`);
      },
      { useApplicationDatabaseRole: true },
    );

    const after = await database.select({ id: logs.id }).from(logs).where(eq(logs.id, rowId));
    expect(after).toHaveLength(0);
  });

  it('a tenant-scoped INSERT into audit.logs still works (no regression)', async () => {
    if (!migrationApplied) return;
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    const result = await executeAsCoreBeAppTenant(organization.public_id, async (transaction) =>
      transaction.execute(
        drizzleSql`INSERT INTO audit.logs (organization_id, action, resource_type, ip_address, user_agent, metadata)
                   VALUES (${organization.id}, 'test.regression', 'test', '127.0.0.1', 'vitest', '{}'::jsonb)
                   RETURNING id`,
      ),
    );
    const inserted = ((result as { rows?: unknown[] }).rows ?? result) as Array<{ id: number }>;
    expect(inserted).toHaveLength(1);
  });
});
