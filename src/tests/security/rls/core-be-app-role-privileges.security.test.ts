import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { database } from '@/infrastructure/database/connection.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import {
  grantCoreBeAppRoleForTests,
  executeAsCoreBeAppUser,
} from '@/tests/helpers/rls-matrix.helper.js';

/**
 * Regression guard for the non-superuser RLS lane itself.
 *
 * Every other RLS security test means something ONLY if `core_be_app` is genuinely a non-superuser,
 * non-BYPASSRLS role: otherwise `SET LOCAL ROLE core_be_app` is a no-op, the whole lane passes, and
 * production — which runs as this role — is exposed. The org-mandated-MFA bypass was this class of
 * failure (a FORCE-RLS table resolving to zero rows under the app role, read as "no MFA required").
 *
 * The baseline created the role with a bare `CREATE ROLE core_be_app NOLOGIN;`, relying on Postgres
 * defaults; migration `20260603150000_core_be_app_role_least_privilege.sql` pins the posture
 * explicitly. These tests fail if a future change ever grants the app role SUPERUSER or BYPASSRLS —
 * structurally (its `pg_roles` attributes) AND behaviorally (it can still be RLS-blocked to zero
 * rows). Either alone would be enough to silently neuter the entire RLS suite.
 */
function scalarFromResult<T>(result: unknown, key: string): T {
  const rows = (
    Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  ) as Record<string, unknown>[];
  return rows[0]?.[key] as T;
}

describe('Security: core_be_app application role is least-privilege (RLS-bound)', () => {
  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('has NOSUPERUSER + NOBYPASSRLS (and no create/replication privileges) in pg_roles', async () => {
    const result = await database.execute(
      drizzleSql`SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
                 FROM pg_roles WHERE rolname = 'core_be_app'`,
    );
    const role = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    )[0] as Record<string, boolean> | undefined;

    expect(role, 'core_be_app role must exist').toBeDefined();
    // The two attributes that make or break the entire RLS lane: a true value on either means
    // FORCE ROW LEVEL SECURITY stops applying to the application role.
    expect(role?.rolsuper).toBe(false);
    expect(role?.rolbypassrls).toBe(false);
    // Defense-in-depth least privilege, pinned by the same migration.
    expect(role?.rolcreatedb).toBe(false);
    expect(role?.rolcreaterole).toBe(false);
    expect(role?.rolreplication).toBe(false);
  });

  it('is actually RLS-bound: a FORCE-RLS row visible to the superuser is invisible to core_be_app with no context', async () => {
    const user = await createTestUser();

    // Control — the row exists. The test harness connects as the RLS-exempt superuser, so it sees
    // the row regardless of policy; this is exactly why superuser-only test lanes hide RLS bugs.
    const superuserCount = scalarFromResult<number>(
      await database.execute(
        drizzleSql`SELECT count(*)::int AS count FROM auth.users WHERE id = ${user.id}`,
      ),
      'count',
    );
    expect(superuserCount).toBe(1);

    // Proof — under `core_be_app` with no `app.current_user_public_id`, FORCE RLS on the self-scoped
    // `auth.users` hides the row. If the role ever gained BYPASSRLS/SUPERUSER this returns 1 and
    // fails, which is the whole point: it pins the role's RLS-subjection behaviorally, not just by
    // catalog attribute.
    const appRoleCount = await executeAsCoreBeAppUser(null, async (transaction) => {
      const result = await transaction.execute(
        drizzleSql`SELECT count(*)::int AS count FROM auth.users WHERE id = ${user.id}`,
      );
      return scalarFromResult<number>(result, 'count');
    });
    expect(appRoleCount).toBe(0);
  });
});
