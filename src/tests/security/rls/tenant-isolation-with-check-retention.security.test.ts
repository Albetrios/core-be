import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
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
 * audit H1: every org-scoped `_tenant_isolation` policy now declares an explicit
 * `WITH CHECK` pinned to the active-org GUC (migration
 * `20260621020000_tenant_isolation_with_check_propagation`), while the `USING`
 * arm keeps the `app.global_retention_cleanup` bypass. Before this, the implicit
 * WITH CHECK reused the bypass-carrying USING, so a retention-context process
 * could INSERT/UPDATE a row under an arbitrary tenant. This proves, across a
 * representative set of the propagated tables, that:
 *   1. a retention-context write setting a foreign organization_id is rejected;
 *   2. a tenant-context cross-org reassignment is rejected (write confinement);
 *   3. retention DELETE still works via the USING bypass (positive control).
 */
const ORG_SCOPED_TABLES = [
  { schemaName: 'notify', tableName: 'webhooks' },
  { schemaName: 'tenancy', tableName: 'memberships' },
  { schemaName: 'tenancy', tableName: 'roles' },
  { schemaName: 'tenancy', tableName: 'api_keys' },
  { schemaName: 'tenancy', tableName: 'organization_notification_policies' },
] as const;

async function resolveOrganizationInternalId(organizationPublicId: string): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM tenancy.organizations WHERE public_id = ${organizationPublicId}
  `;
  return Number(rows[0]!.id);
}

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

describe('Security: tenant-isolation WITH CHECK propagation confines cross-org writes', () => {
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

  it.each(ORG_SCOPED_TABLES)(
    'rejects a retention-context write that sets a foreign organization_id on $tableName (explicit WITH CHECK)',
    async ({ schemaName, tableName }) => {
      const rowIds = fixture.rowIdsByTable.get(tableKey(schemaName, tableName));
      expect(rowIds, `fixture seeds a ${tableName} row for both orgs`).toBeDefined();

      let caught: unknown;
      try {
        await withMaintenanceDatabaseContext(
          MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
          async (databaseHandle) =>
            databaseHandle.execute(
              drizzleSql.raw(
                `UPDATE "${schemaName}"."${tableName}" SET organization_id = ${organizationAInternalId} WHERE id = ${rowIds!.organizationB} RETURNING id`,
              ),
            ),
          { useApplicationDatabaseRole: true },
        );
      } catch (error) {
        caught = error;
      }

      expect(
        caught,
        `expected explicit WITH CHECK to reject a retention-context cross-org write on ${tableName}`,
      ).toBeDefined();
      expect(flattenErrorChain(caught)).toMatch(/row-level security/i);
    },
  );

  it.each(ORG_SCOPED_TABLES)(
    'rejects reassigning an org-B $tableName row to org A under the org-B tenant context',
    async ({ schemaName, tableName }) => {
      const rowIds = fixture.rowIdsByTable.get(tableKey(schemaName, tableName))!;

      let caught: unknown;
      try {
        await executeAsCoreBeAppTenant(fixture.organizationBPublicId, async (transaction) => {
          await transaction.execute(
            drizzleSql.raw(
              `UPDATE "${schemaName}"."${tableName}" SET organization_id = ${organizationAInternalId} WHERE id = ${rowIds.organizationB} RETURNING id`,
            ),
          );
        });
      } catch (error) {
        caught = error;
      }

      expect(
        caught,
        `expected RLS to reject reassigning ${tableName} to a foreign org`,
      ).toBeDefined();
      expect(flattenErrorChain(caught)).toMatch(/row-level security/i);
    },
  );

  it('still allows a retention-context DELETE via the USING bypass (positive control)', async () => {
    const rowIds = fixture.rowIdsByTable.get(tableKey('tenancy', 'api_keys'))!;

    const deletedCount = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      async (databaseHandle) => {
        const result = await databaseHandle.execute(
          drizzleSql.raw(
            `DELETE FROM "tenancy"."api_keys" WHERE id = ${rowIds.organizationB} RETURNING id`,
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
    const rowIds = fixture.rowIdsByTable.get(tableKey('tenancy', 'memberships'))!;

    const affected = await executeAsCoreBeAppTenant(
      fixture.organizationBPublicId,
      async (transaction) => {
        const result = await transaction.execute(
          drizzleSql.raw(
            `UPDATE "tenancy"."memberships" SET organization_id = ${organizationBInternalId} WHERE id = ${rowIds.organizationB} RETURNING id`,
          ),
        );
        const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
        return rows.length;
      },
    );

    expect(affected).toBe(1);
  });
});
