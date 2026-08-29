import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { sql as drizzleSql } from 'drizzle-orm';
import { sql } from '@/infrastructure/database/connection.js';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import {
  grantCoreBeAppRoleForTests,
  executeAsCoreBeAppGlobalAdmin,
} from '@/tests/helpers/rls-matrix.helper.js';

/**
 * Checks whether the sec-r4-D1 migration has been applied by verifying the
 * INSERT policy no longer contains the global_admin escape hatch in its
 * WITH CHECK expression.
 */
async function isPrivilegeBypassMigrationApplied(): Promise<boolean> {
  // INSERT policies only carry a WITH CHECK predicate — `qual` (the USING
  // predicate column) is NULL for INSERT-only policies. Query with_check.
  const rows = await sql<{ with_check: string | null }[]>`
    SELECT with_check
    FROM pg_policies
    WHERE schemaname = 'audit'
      AND tablename = 'logs'
      AND policyname = 'audit_logs_tenant_isolation_insert'
      AND cmd = 'INSERT'
  `;
  const withCheck = rows[0]?.with_check;
  if (!withCheck) return false;
  // After the fix the WITH CHECK must NOT mention global_admin or global_retention_cleanup.
  return !(withCheck.includes('global_admin') || withCheck.includes('global_retention_cleanup'));
}

/**
 * Regression for sec-r4-D1 (Medium): the `audit_logs_tenant_isolation_insert`
 * RLS policy carried both `global_retention_cleanup` and `global_admin` escape
 * hatches in its WITH CHECK predicate — copied verbatim from the SELECT policy
 * when sec-U3 split the FOR ALL policy. Neither context has a legitimate reason
 * to INSERT audit rows for an arbitrary organization; they are read/delete
 * contexts only. Keeping the escape hatches in WITH CHECK allowed any process
 * running with either GUC set to write audit rows outside normal tenant
 * isolation.
 *
 * After migration 20260608040000 the INSERT policy accepts only a
 * tenant-scoped insert where `organization_id` matches
 * `current_setting('app.current_organization_public_id', true)`. Both the
 * `global_admin` and `global_retention_cleanup` paths must now be rejected.
 */
describe('Security: audit.logs INSERT RLS rejects privilege-bypass contexts (sec-r4-D1)', () => {
  let migrationApplied = false;

  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
    migrationApplied = await isPrivilegeBypassMigrationApplied();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('global_admin context cannot INSERT into audit.logs without a valid tenant id', async () => {
    expect(
      migrationApplied,
      'apply migration 20260608040000 to remove privilege-bypass arms from audit INSERT RLS',
    ).toBe(true);

    const owner = await createTestUser({ email: 'audit-d1-admin@example.com' });
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    let caught: unknown;
    try {
      await executeAsCoreBeAppGlobalAdmin(async (transaction) => {
        // No app.current_organization_public_id set — only global_admin is active.
        // Before the fix this would succeed (global_admin bypassed WITH CHECK).
        // After the fix RLS rejects it.
        await transaction.execute(
          drizzleSql`INSERT INTO audit.logs (organization_id, action, resource_type, ip_address, user_agent, metadata)
                     VALUES (${organization.id}, 'test.d1.admin', 'test', '127.0.0.1', 'vitest', '{}'::jsonb)`,
        );
      });
    } catch (error) {
      caught = error;
    }

    expect(caught, 'global_admin INSERT must be rejected by RLS').toBeDefined();
    const errorMessage = String(caught) + String((caught as { cause?: unknown }).cause ?? '');
    expect(errorMessage).toMatch(/new row violates row-level security policy|permission denied/i);
  });

  it('global_retention_cleanup context cannot INSERT into audit.logs without a valid tenant id', async () => {
    if (!migrationApplied) return;

    const owner = await createTestUser({ email: 'audit-d1-retention@example.com' });
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    let caught: unknown;
    try {
      await withMaintenanceDatabaseContext(
        MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
        async (databaseHandle) => {
          // No app.current_organization_public_id set — only global_retention_cleanup
          // is active. Before the fix this would succeed. After the fix, RLS
          // rejects it.
          await databaseHandle.execute(
            drizzleSql`INSERT INTO audit.logs (organization_id, action, resource_type, ip_address, user_agent, metadata)
                       VALUES (${organization.id}, 'test.d1.retention', 'test', '127.0.0.1', 'vitest', '{}'::jsonb)`,
          );
        },
        { useApplicationDatabaseRole: true },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught, 'global_retention_cleanup INSERT must be rejected by RLS').toBeDefined();
    const errorMessage = String(caught) + String((caught as { cause?: unknown }).cause ?? '');
    expect(errorMessage).toMatch(/new row violates row-level security policy|permission denied/i);
  });

  it('tenant-scoped INSERT into audit.logs still succeeds (no regression)', async () => {
    if (!migrationApplied) return;

    const owner = await createTestUser({ email: 'audit-d1-tenant@example.com' });
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    // Verify the DB row for the organization actually exists so the sub-select will resolve.
    const organizationRows = await database.execute(
      drizzleSql`SELECT id FROM tenancy.organizations WHERE id = ${organization.id}`,
    );
    const resolvedOrg = ((organizationRows as { rows?: unknown[] }).rows ??
      organizationRows) as Array<{
      id: number;
    }>;
    expect(resolvedOrg).toHaveLength(1);

    let caught: unknown;
    try {
      await database.transaction(async (transaction) => {
        await transaction.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
        await transaction.execute(
          drizzleSql`SELECT set_config('app.current_organization_public_id', ${organization.public_id}, true)`,
        );
        await transaction.execute(
          drizzleSql`INSERT INTO audit.logs (organization_id, action, resource_type, ip_address, user_agent, metadata)
                     VALUES (${organization.id}, 'test.d1.tenant', 'test', '127.0.0.1', 'vitest', '{}'::jsonb)`,
        );
      });
    } catch (error) {
      caught = error;
    }

    expect(caught, 'tenant-scoped INSERT must succeed').toBeUndefined();
  });
});
