import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql as drizzleSql, eq } from 'drizzle-orm';
import { sql } from '@/infrastructure/database/connection.js';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { grantCoreBeAppRoleForTests } from '@/tests/helpers/rls-matrix.helper.js';

/**
 * Checks whether the `organizations_tenant_isolation` policy has been patched
 * with the `deleted_at IS NULL` arm from migration
 * `20260608010000_rls_organizations_exclude_soft_deleted.sql`. Tests skip
 * (with a warning) when the migration hasn't been applied yet.
 */
async function hasSoftDeletedFilterInPolicy(): Promise<boolean> {
  const rows = await sql<{ has_filter: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'tenancy'
        AND tablename = 'organizations'
        AND policyname = 'organizations_tenant_isolation'
        AND qual::text LIKE '%deleted_at%'
    ) AS has_filter
  `;
  return rows[0]?.has_filter === true;
}

/**
 * Regression suite for sec-new-D3: soft-deleted organizations must not be
 * readable via the `organizations_tenant_isolation` RLS policy on normal
 * tenant requests.
 *
 * Before this migration, the `USING` clause was:
 *   public_id = app.current_organization_public_id
 *   OR app.global_retention_cleanup = 'true'
 *
 * A request scoped (via its token claim) to a deleted organization's `public_id` could
 * still read the organizations row directly. The fix adds `AND deleted_at IS NULL`
 * to the tenant-scoped arm so soft-deleted organizations are invisible to HTTP requests.
 * The `global_retention_cleanup` bypass arm is unchanged — retention workers must
 * be able to see deleted rows for tombstone / hard-delete jobs.
 */
describe('Security: organizations RLS — soft-deleted organizations excluded (sec-new-D3)', () => {
  let migrationApplied = false;

  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
    migrationApplied = await hasSoftDeletedFilterInPolicy();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('sec-new-D3: hides soft-deleted organization from a tenant-scoped query', async () => {
    // Fail closed: this tenant-isolation guarantee must never be silently skipped. If the
    // migration is missing the suite fails loudly (with the fix instruction) rather than passing
    // with zero coverage — exactly the gap a "skip when absent" guard would leave on a fresh DB.
    expect(
      migrationApplied,
      'Required RLS migration 20260608010000_rls_organizations_exclude_soft_deleted.sql is not applied — apply it (pnpm db:migrate) so soft-deleted-organization isolation is actually verified.',
    ).toBe(true);

    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    // Soft-delete the organization directly in the DB (bypasses RLS via superuser).
    await database
      .update(organizations)
      .set({ deleted_at: new Date() })
      .where(eq(organizations.id, organization.id));

    // Open a tenant-scoped transaction (core_be_app role + app.current_organization_public_id).
    await database.transaction(async (transaction) => {
      await transaction.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
      await transaction.execute(
        drizzleSql`SELECT set_config('app.current_organization_public_id', ${organization.public_id}, true)`,
      );

      // The soft-deleted organization must NOT appear when queried by its own public_id.
      const rows = await transaction
        .select({ public_id: organizations.public_id })
        .from(organizations)
        .where(eq(organizations.public_id, organization.public_id));

      expect(rows).toHaveLength(0);
    });
  });

  it('sec-new-D3: active organization remains visible to a tenant-scoped query', async () => {
    expect(
      migrationApplied,
      'Required RLS migration 20260608010000_rls_organizations_exclude_soft_deleted.sql is not applied.',
    ).toBe(true);

    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    await database.transaction(async (transaction) => {
      await transaction.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
      await transaction.execute(
        drizzleSql`SELECT set_config('app.current_organization_public_id', ${organization.public_id}, true)`,
      );

      const rows = await transaction
        .select({ public_id: organizations.public_id })
        .from(organizations)
        .where(eq(organizations.public_id, organization.public_id));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.public_id).toBe(organization.public_id);
    });
  });

  it('sec-new-D3: global_retention_cleanup bypass still shows soft-deleted organizations to retention workers', async () => {
    expect(
      migrationApplied,
      'Required RLS migration 20260608010000_rls_organizations_exclude_soft_deleted.sql is not applied.',
    ).toBe(true);

    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    await database
      .update(organizations)
      .set({ deleted_at: new Date() })
      .where(eq(organizations.id, organization.id));

    await database.transaction(async (transaction) => {
      await transaction.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
      // Retention workers set global_retention_cleanup instead of an organization-scoped id.
      await transaction.execute(
        drizzleSql`SELECT set_config('app.global_retention_cleanup', 'true', true)`,
      );

      const rows = await transaction
        .select({ public_id: organizations.public_id })
        .from(organizations)
        .where(eq(organizations.public_id, organization.public_id));

      expect(rows).toHaveLength(1);
    });
  });
});
