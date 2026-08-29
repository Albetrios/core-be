import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { provisionPersonalOrganization } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { grantCoreBeAppRoleForTests } from '@/tests/helpers/rls-matrix.helper.js';

/**
 * Pins the policy fact behind PRs #1105 / #1106: **`app.global_admin` grants nothing on tenancy
 * tables.**
 *
 * The `auth.*` and `audit.logs` policies carry an `app.global_admin` arm; the tenancy ones do not.
 * Three separate bugs shipped from assuming otherwise (failed organization provisioning, active-organization reads
 * returning zero rows, silently skipped permission-cache purges).
 *
 * The companion static guard (`no-global-admin-in-tenancy.global.test.ts`) stops tenancy code from
 * importing the hatch. This test pins the underlying database truth: if someone later ADDS a
 * `global_admin` arm to a tenancy policy, this fails and forces that to be a deliberate, reviewed
 * decision rather than a silent widening of the escape hatch.
 *
 * Runs as `core_be_app` because the local/CI superuser (`POSTGRES_USER: core`) bypasses RLS and
 * would make every assertion here vacuous.
 */
function rowCount(result: unknown): number {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])).length;
}

/** Runs `callback` as `core_be_app` with ONLY `app.global_admin` set — no organization, no user GUC. */
async function executeAsGlobalAdminOnly<T>(
  callback: (transaction: typeof database) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
    await transaction.execute(drizzleSql`SELECT set_config('app.global_admin', 'true', true)`);
    return callback(transaction as unknown as typeof database);
  });
}

describe('Security: app.global_admin does not expose tenancy tables', () => {
  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('cannot read tenancy.organizations or tenancy.memberships under global-admin alone', async () => {
    const owner = await createTestUser();
    // Provisioning writes organization + Owner role + grants + ACTIVE membership in one transaction, so both
    // tables genuinely hold rows — otherwise the zero-row assertions below would pass vacuously.
    await provisionPersonalOrganization(owner.id);

    const seededAsSuperuser = {
      organizations: rowCount(
        await database.execute(drizzleSql`SELECT id FROM tenancy.organizations`),
      ),
      memberships: rowCount(await database.execute(drizzleSql`SELECT id FROM tenancy.memberships`)),
    };
    expect(seededAsSuperuser.organizations).toBeGreaterThan(0);
    expect(seededAsSuperuser.memberships).toBeGreaterThan(0);

    const visible = await executeAsGlobalAdminOnly(async (transaction) => ({
      organizations: rowCount(
        await transaction.execute(drizzleSql`SELECT id FROM tenancy.organizations`),
      ),
      memberships: rowCount(
        await transaction.execute(drizzleSql`SELECT id FROM tenancy.memberships`),
      ),
    }));

    expect(visible).toEqual({ organizations: 0, memberships: 0 });
  });

  it('CAN read auth.users under global-admin (the arm that does exist)', async () => {
    await createTestUser();

    const visible = await executeAsGlobalAdminOnly(async (transaction) =>
      rowCount(await transaction.execute(drizzleSql`SELECT id FROM auth.users`)),
    );

    expect(visible).toBeGreaterThan(0);
  });
});
