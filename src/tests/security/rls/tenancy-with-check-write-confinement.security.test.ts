import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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
 * Tenant-isolation RLS has two halves: USING (which rows a context can see) and WITH CHECK
 * (which rows a context may write). The RLS matrix proves USING for every tenancy table and
 * `audit-insert-rls-privilege-bypass` proves WITH CHECK for `audit.logs` — but no tenancy-owned
 * table has a WITH CHECK *write-confinement* test. The `worker-context-rls-backstop` UPDATE only
 * flips a non-key column (proving visibility), never the `organization_id` itself.
 *
 * These tenancy policies declare USING with a null WITH CHECK, so Postgres reuses the USING
 * predicate as the WITH CHECK for writes. This closes the gap: under organization B's tenant context (the
 * least-privilege `core_be_app` role with `app.current_organization_public_id` set, no user GUC),
 * reassigning a visible organization-B row to organization A must be rejected by the policy — the DB backstop that
 * catches an application bug writing the wrong `organization_id`. A same-organization reassignment is the
 * positive control, proving the rejection is the organization predicate and not a blanket permission denial.
 */
const TENANCY_ORG_SCOPED_TABLES = [
  { schemaName: 'tenancy', tableName: 'memberships' },
  { schemaName: 'tenancy', tableName: 'roles' },
  { schemaName: 'tenancy', tableName: 'organization_notification_policies' },
  { schemaName: 'tenancy', tableName: 'api_keys' },
] as const;

async function resolveOrganizationInternalId(organizationPublicId: string): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM tenancy.organizations WHERE public_id = ${organizationPublicId}
  `;
  return Number(rows[0]!.id);
}

/**
 * Walks the drizzle -> postgres error `cause` chain so the underlying
 * "new row violates row-level security policy" message is visible (drizzle's top-level message
 * is only "Failed query: ...").
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

/** Runs a raw UPDATE ... RETURNING under the tenant context, returning the affected-row count. */
async function updateReturningCountAsTenant(
  organizationPublicId: string,
  rawSql: string,
): Promise<number> {
  return executeAsCoreBeAppTenant(organizationPublicId, async (transaction) => {
    const result = await transaction.execute(drizzleSql.raw(rawSql));
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
    return rows.length;
  });
}

describe('Security: tenancy RLS WITH CHECK confines cross-organization writes', () => {
  let fixture: RlsTenantFixture;
  let organizationAInternalId: number;
  let organizationBInternalId: number;

  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
  });

  // Seed after cleanup, per-test (the suite cleanup wipes data between tests, so a
  // beforeAll-only seed would not be visible — mirrors rls-matrix.security.test.ts).
  beforeEach(async () => {
    await cleanupDatabase();
    fixture = await seedRlsMatrixFixtures();
    organizationAInternalId = await resolveOrganizationInternalId(fixture.organizationAPublicId);
    organizationBInternalId = await resolveOrganizationInternalId(fixture.organizationBPublicId);
  });

  it.each(TENANCY_ORG_SCOPED_TABLES)(
    'rejects reassigning a $tableName row from organization B to organization A (WITH CHECK)',
    async ({ schemaName, tableName }) => {
      const rowIds = fixture.rowIdsByTable.get(tableKey(schemaName, tableName));
      expect(rowIds, `fixture seeds a ${tableName} row for both orgs`).toBeDefined();

      let caught: unknown;
      try {
        await updateReturningCountAsTenant(
          fixture.organizationBPublicId,
          `UPDATE "${schemaName}"."${tableName}" SET organization_id = ${organizationAInternalId} WHERE id = ${rowIds!.organizationB} RETURNING id`,
        );
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

  it('allows a same-organization reassignment under the matching tenant context (positive control)', async () => {
    const rowIds = fixture.rowIdsByTable.get(tableKey('tenancy', 'memberships'))!;

    // Re-asserting the row to its own organization passes the predicate and updates exactly one row —
    // proving the rejections above are the organization WITH CHECK, not a blanket permission denial.
    const affected = await updateReturningCountAsTenant(
      fixture.organizationBPublicId,
      `UPDATE "tenancy"."memberships" SET organization_id = ${organizationBInternalId} WHERE id = ${rowIds.organizationB} RETURNING id`,
    );
    expect(affected).toBe(1);
  });
});
