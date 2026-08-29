import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { sql as drizzleSql } from 'drizzle-orm';
import { sql } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { grantCoreBeAppRoleForTests } from '@/tests/helpers/rls-matrix.helper.js';

/**
 * Regression for sec-r5-async-queue-1.
 *
 * Background: sec-r4-D1 closed the `global_admin` and `global_retention_cleanup`
 * escape arms on `audit_logs_tenant_isolation_insert`. That was correct, but
 * it unmasked a latent bug: the DLQ replay paths (`recordDlqAutoRetryAuditEntry`,
 * `recordDlqReplayAuditEntry`) write tenantless system events to `audit.logs`.
 * Under the tenant-only policy the INSERT throws, the throw is swallowed in
 * the auto-retry processor's outer catch, the Redis counter never advances,
 * and the same 20 ledger rows are re-selected at the head forever — head-of-line
 * starvation for the entire DLQ auto-retry subsystem.
 *
 * The fix re-opens a NARROW system-audit arm gated by
 * `app.system_audit_insert='true'` AND `organization_id IS NULL`. Because the
 * arm requires `organization_id IS NULL`, a process that flips this GUC
 * cannot impersonate a tenant — only tenantless rows can be written.
 *
 * These tests MUST run under `SET LOCAL ROLE core_be_app` (provided by the
 * context helper's `useApplicationDatabaseRole` option) so the harness's
 * superuser `core` role bypass does not silently mask RLS regressions.
 */
async function isSystemAuditInsertArmApplied(): Promise<boolean> {
  const rows = await sql<{ with_check: string | null }[]>`
    SELECT with_check FROM pg_policies
    WHERE schemaname = 'audit'
      AND tablename = 'logs'
      AND policyname = 'audit_logs_tenant_isolation_insert'
      AND cmd = 'INSERT'
  `;
  const withCheck = rows[0]?.with_check ?? '';
  return withCheck.includes('system_audit_insert');
}

describe('Security: audit.logs INSERT system-audit arm (sec-r5-async-queue-1)', () => {
  let migrationApplied = false;

  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
    migrationApplied = await isSystemAuditInsertArmApplied();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('system-audit-insert context CAN INSERT a tenantless audit row (DLQ replay path)', async () => {
    expect(
      migrationApplied,
      'apply migration 20260609010000 to re-open the system-audit-insert arm on audit.logs',
    ).toBe(true);

    let caught: unknown;
    try {
      await withMaintenanceDatabaseContext(
        MAINTENANCE_SCOPE.SYSTEM_AUDIT_INSERT,
        async (databaseHandle) => {
          await databaseHandle.execute(
            drizzleSql`INSERT INTO audit.logs (organization_id, actor_user_id, action, resource_type, metadata, severity)
                       VALUES (NULL, NULL, 'test.r5.system_audit', 'test', '{}'::jsonb, 'INFO')`,
          );
        },
        { useApplicationDatabaseRole: true },
      );
    } catch (error) {
      caught = error;
    }

    expect(
      caught,
      'tenantless INSERT under withMaintenanceDatabaseContext must succeed',
    ).toBeUndefined();

    const inserted = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit.logs WHERE action = 'test.r5.system_audit'
    `;
    expect(inserted[0]?.count).toBe('1');
  });

  it('system-audit-insert context CANNOT impersonate a tenant (organization_id NOT NULL is rejected)', async () => {
    if (!migrationApplied) return;

    const owner = await createTestUser({ email: 'audit-r5-no-impersonate@example.com' });
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    let caught: unknown;
    try {
      await withMaintenanceDatabaseContext(
        MAINTENANCE_SCOPE.SYSTEM_AUDIT_INSERT,
        async (databaseHandle) => {
          // Attempt to pin a real tenant on the row while only the
          // system-audit-insert GUC is active. The new arm requires
          // organization_id IS NULL — RLS must reject this.
          await databaseHandle.execute(
            drizzleSql`INSERT INTO audit.logs (organization_id, actor_user_id, action, resource_type, metadata, severity)
                       VALUES (${organization.id}, NULL, 'test.r5.impersonate', 'test', '{}'::jsonb, 'INFO')`,
          );
        },
        { useApplicationDatabaseRole: true },
      );
    } catch (error) {
      caught = error;
    }

    expect(
      caught,
      'system-audit-insert context with organization_id must be rejected by RLS',
    ).toBeDefined();
    const errorMessage = String(caught) + String((caught as { cause?: unknown }).cause ?? '');
    expect(errorMessage).toMatch(/new row violates row-level security policy|permission denied/i);
  });

  it('plain `core_be_app` role (no GUC) CANNOT INSERT a tenantless row', async () => {
    if (!migrationApplied) return;

    // sec-r5-async-queue-1: this is the exact scenario the pre-fix DLQ
    // replay code hit. Without the GUC, RLS rejects the bare INSERT.
    let caught: unknown;
    try {
      await sql.begin(async (transaction) => {
        await transaction`SET LOCAL ROLE core_be_app`;
        await transaction`
          INSERT INTO audit.logs (organization_id, actor_user_id, action, resource_type, metadata, severity)
          VALUES (NULL, NULL, 'test.r5.bare', 'test', '{}'::jsonb, 'INFO')
        `;
      });
    } catch (error) {
      caught = error;
    }

    expect(
      caught,
      'bare core_be_app INSERT without system-audit-insert GUC must be rejected',
    ).toBeDefined();
    const errorMessage = String(caught) + String((caught as { cause?: unknown }).cause ?? '');
    expect(errorMessage).toMatch(/new row violates row-level security policy|permission denied/i);
  });
});
