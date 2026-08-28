import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { sql as drizzleSql } from 'drizzle-orm';
import { sql } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  grantCoreBeAppRoleForTests,
  executeAsCoreBeAppTenant,
} from '@/tests/helpers/rls-matrix.helper.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * Regression for audit R10.
 *
 * `audit.outbox` is the request-time staging table for the audit ledger. Its INSERT policy
 * (`audit_outbox_tenant_isolation_insert`) only passes when the row's `organization_public_id`
 * matches `app.current_organization_public_id` (org-scoped rows) OR `organization_public_id IS NULL` AND
 * `app.system_audit_insert = 'true'` (tenantless rows). There is NO user arm.
 *
 * Post-sec-M4 the per-request org RLS transaction is a no-op, and HTTP controllers emit audit AFTER
 * the service's `withAppDatabaseContext` block has already closed — so `AuditService.record`
 * used to call `insertAuditOutboxRow` on the bare pool with NO GUC set. Under the production
 * `core_be_app` role (FORCE/ENABLE RLS, NOBYPASSRLS) the WITH CHECK rejected EVERY such INSERT, and
 * `recordAuditEvent` swallowed the error — so the production audit trail was silently dropped. The
 * harness never caught it because tests run as the superuser `core` owner role, which bypasses RLS.
 *
 * The fix opens the matching context inside `AuditService.record`: org rows under
 * `withAppDatabaseContext`, tenantless rows under `withMaintenanceDatabaseContext`. These
 * tests prove the policy behavior under `SET LOCAL ROLE core_be_app`.
 */

/** Minimal valid outbox row (satisfies chk_audit_outbox_actor_present + status/severity checks). */
function outboxInsertSql(organizationPublicId: string | null) {
  const actor = generatePublicId('user');
  return drizzleSql`
    INSERT INTO audit.outbox
      (status, actor_user_public_id, organization_public_id, action, resource_type, severity, metadata)
    VALUES
      ('PENDING', ${actor}, ${organizationPublicId}, 'test.r10.outbox', 'test', 'INFO', '{}'::jsonb)
  `;
}

/** Flattens an error and its `.cause` chain so the postgres SQLSTATE is matchable. */
function flattenErrorChain(error: unknown): string {
  let text = '';
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current; depth += 1) {
    text += String(current);
    current = (current as { cause?: unknown }).cause;
  }
  return text;
}

describe('Security: audit.outbox INSERT RLS (audit R10)', () => {
  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('R10 BUG: plain core_be_app (no GUC) CANNOT INSERT an org-scoped outbox row', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    let caught: unknown;
    try {
      await sql.begin(async (transaction) => {
        await transaction`SET LOCAL ROLE core_be_app`;
        await transaction`
          INSERT INTO audit.outbox
            (status, actor_user_public_id, organization_public_id, action, resource_type, severity, metadata)
          VALUES ('PENDING', ${generatePublicId('user')}, ${organization.public_id}, 'test.r10.outbox', 'test', 'INFO', '{}'::jsonb)
        `;
      });
    } catch (error) {
      caught = error;
    }

    expect(
      caught,
      'org-scoped outbox INSERT without the tenant GUC must be rejected',
    ).toBeDefined();
    expect(flattenErrorChain(caught)).toMatch(/row-level security|permission denied/i);
  });

  it('R10 BUG: plain core_be_app (no GUC) CANNOT INSERT a tenantless outbox row', async () => {
    let caught: unknown;
    try {
      await sql.begin(async (transaction) => {
        await transaction`SET LOCAL ROLE core_be_app`;
        await transaction`
          INSERT INTO audit.outbox
            (status, actor_user_public_id, organization_public_id, action, resource_type, severity, metadata)
          VALUES ('PENDING', ${generatePublicId('user')}, ${null}, 'test.r10.outbox', 'test', 'INFO', '{}'::jsonb)
        `;
      });
    } catch (error) {
      caught = error;
    }

    expect(
      caught,
      'tenantless outbox INSERT without app.system_audit_insert must be rejected',
    ).toBeDefined();
    expect(flattenErrorChain(caught)).toMatch(/row-level security|permission denied/i);
  });

  it('R10 FIX: core_be_app under organization context CAN INSERT the org-scoped outbox row', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    await executeAsCoreBeAppTenant(organization.public_id, (transaction) =>
      transaction.execute(outboxInsertSql(organization.public_id)),
    );

    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit.outbox
      WHERE action = 'test.r10.outbox' AND organization_public_id = ${organization.public_id}
    `;
    expect(rows[0]?.count).toBe('1');
  });

  it('R10 FIX: core_be_app under system-audit-insert context CAN INSERT the tenantless outbox row', async () => {
    let caught: unknown;
    try {
      await withMaintenanceDatabaseContext(
        MAINTENANCE_SCOPE.SYSTEM_AUDIT_INSERT,
        (databaseHandle) => databaseHandle.execute(outboxInsertSql(null)),
        { useApplicationDatabaseRole: true },
      );
    } catch (error) {
      caught = error;
    }

    expect(
      caught,
      'tenantless INSERT under withMaintenanceDatabaseContext must succeed',
    ).toBeUndefined();
    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit.outbox
      WHERE action = 'test.r10.outbox' AND organization_public_id IS NULL
    `;
    expect(rows[0]?.count).toBe('1');
  });
});
