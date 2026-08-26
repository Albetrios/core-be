import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/maintenance-database.context.js';
import { sql as drizzleSql } from 'drizzle-orm';
import { sql } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  grantCoreBeAppRoleForTests,
  executeAsCoreBeAppTenant,
  seedRlsMatrixFixtures,
  tableKey,
  type RlsTenantFixture,
} from '@/tests/helpers/rls-matrix.helper.js';

/**
 * audit #41: the `subscriptions_tenant_isolation` policy now declares an explicit
 * WITH CHECK pinned to the active-org GUC, while its USING arm keeps the
 * `app.global_retention_cleanup` bypass. Two halves to prove:
 *
 *   1. Tenant context (org B): reassigning a visible org-B subscription to org A
 *      is rejected — the standard write-confinement backstop.
 *   2. Retention context (`global_retention_cleanup='true'`, no org GUC): a write
 *      that sets a foreign `organization_id` is rejected by WITH CHECK. Before
 *      this migration the implicit WITH CHECK reused USING (which carries the
 *      retention bypass), so a retention-context process could have written a
 *      subscription row under an arbitrary tenant. The USING bypass still permits
 *      a retention DELETE (positive control), proving only the write side was
 *      tightened.
 */
async function resolveOrganizationInternalId(organizationPublicId: string): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM tenancy.organizations WHERE public_id = ${organizationPublicId}
  `;
  return Number(rows[0]!.id);
}

/**
 * Walks the drizzle -> postgres error `cause` chain so the underlying
 * "new row violates row-level security policy" message is visible.
 */
function flattenErrorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current != null; depth += 1) {
    const message = (current as { message?: unknown }).message;
    parts.push(typeof message === 'string' ? message : String(current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

describe('Security: subscriptions RLS WITH CHECK confines cross-org writes', () => {
  let fixture: RlsTenantFixture;
  let organizationAInternalId: number;
  let organizationBInternalId: number;

  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    fixture = await seedRlsMatrixFixtures();
    organizationAInternalId = await resolveOrganizationInternalId(fixture.organizationAPublicId);
    organizationBInternalId = await resolveOrganizationInternalId(fixture.organizationBPublicId);
  });

  it('rejects reassigning an org-B subscription to org A under the org-B tenant context', async () => {
    const rowIds = fixture.rowIdsByTable.get(tableKey('billing', 'subscriptions'));
    expect(rowIds, 'fixture seeds a subscriptions row for both orgs').toBeDefined();

    let caught: unknown;
    try {
      await executeAsCoreBeAppTenant(fixture.organizationBPublicId, async (transaction) => {
        await transaction.execute(
          drizzleSql.raw(
            `UPDATE "billing"."subscriptions" SET organization_id = ${organizationAInternalId} WHERE id = ${rowIds!.organizationB} RETURNING id`,
          ),
        );
      });
    } catch (error) {
      caught = error;
    }

    expect(
      caught,
      'expected RLS to reject reassigning a subscription to a foreign org',
    ).toBeDefined();
    expect(flattenErrorChain(caught)).toMatch(/row-level security/i);
  });

  it('rejects a retention-context write that sets a foreign organization_id (explicit WITH CHECK)', async () => {
    const rowIds = fixture.rowIdsByTable.get(tableKey('billing', 'subscriptions'))!;

    let caught: unknown;
    try {
      await withMaintenanceDatabaseContext(
        MAINTENANCE_SCOPE.global_retention_cleanup,
        async (databaseHandle) =>
          databaseHandle.execute(
            drizzleSql.raw(
              `UPDATE "billing"."subscriptions" SET organization_id = ${organizationAInternalId} WHERE id = ${rowIds.organizationB} RETURNING id`,
            ),
          ),
        { useApplicationDatabaseRole: true },
      );
    } catch (error) {
      caught = error;
    }

    expect(
      caught,
      'expected explicit WITH CHECK to reject a retention-context cross-org write',
    ).toBeDefined();
    expect(flattenErrorChain(caught)).toMatch(/row-level security/i);
  });

  it('still allows a retention-context DELETE via the USING bypass (positive control)', async () => {
    const rowIds = fixture.rowIdsByTable.get(tableKey('billing', 'subscriptions'))!;

    const deletedCount = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.global_retention_cleanup,
      async (databaseHandle) => {
        const result = await databaseHandle.execute(
          drizzleSql.raw(
            `DELETE FROM "billing"."subscriptions" WHERE id = ${rowIds.organizationB} RETURNING id`,
          ),
        );
        const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
        return rows.length;
      },
      { useApplicationDatabaseRole: true },
    );

    expect(deletedCount).toBe(1);
  });

  it('allows a same-org reassignment under the matching tenant context (positive control)', async () => {
    const rowIds = fixture.rowIdsByTable.get(tableKey('billing', 'subscriptions'))!;

    const affected = await executeAsCoreBeAppTenant(
      fixture.organizationBPublicId,
      async (transaction) => {
        const result = await transaction.execute(
          drizzleSql.raw(
            `UPDATE "billing"."subscriptions" SET organization_id = ${organizationBInternalId} WHERE id = ${rowIds.organizationB} RETURNING id`,
          ),
        );
        const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
        return rows.length;
      },
    );

    expect(affected).toBe(1);
  });
});
