import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import {
  grantCoreBeAppRoleForTests,
  executeAsCoreBeAppTenant,
} from '@/tests/helpers/rls-matrix.helper.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * Regression for the personal-org provisioning RLS failure (SQLSTATE 42501,
 * `email_login.user.personal_org_provision_failed`). Provisioning ran the owner-bootstrap under
 * `withMaintenanceDatabaseContext`, but the tenancy policies never honor `app.global_admin` (only
 * `auth`/`audit` do) — so the `tenancy.organizations` INSERT's WITH CHECK was rejected under the
 * non-superuser `core_be_app` role in deployed environments, while passing locally where the DB
 * connects as a BYPASSRLS superuser. The fix runs the bootstrap under the NEW org's own context
 * (`app.current_organization_id` = the pre-generated `public_id`), which satisfies the
 * tenant-isolation WITH CHECK for the org row and every org-scoped child row.
 *
 * These assertions run as `core_be_app` so FORCE RLS is actually enforced — the default test
 * runner role inherits BYPASSRLS and would mask the bug (which is exactly why the pre-existing
 * `personal-organization-provisioning.db.unit.test.ts`, run as that role, never caught it).
 */
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result)
    ? (result as Array<Record<string, unknown>>)
    : ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []);
}

/**
 * Walk the drizzle → postgres error `cause` chain — drizzle's top-level message is only
 * "Failed query: …", so the underlying "new row violates row-level security policy" (SQLSTATE
 * 42501) lives on a nested `cause`.
 */
function flattenErrorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current != null; depth += 1) {
    const message = (current as { message?: unknown }).message;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') parts.push(code);
    parts.push(typeof message === 'string' ? message : String(current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

describe('Security: personal-organization provisioning under RLS (core_be_app)', () => {
  let ownerUserId: number;

  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    ownerUserId = (await createTestUser()).id;
  });

  it('bootstraps org + Owner role + ACTIVE membership under the NEW org context (the fix)', async () => {
    const organizationPublicId = generatePublicId('organization');

    const membershipRows = await executeAsCoreBeAppTenant(
      organizationPublicId,
      async (transaction) => {
        const organization = rowsOf(
          await transaction.execute(drizzleSql`
          INSERT INTO tenancy.organizations
            (public_id, name, type, owner_user_id, created_by_user_id, updated_by_user_id)
          VALUES (${organizationPublicId}, 'Personal', 'PERSONAL', ${ownerUserId}, ${ownerUserId}, ${ownerUserId})
          RETURNING id
        `),
        );
        const organizationId = Number(organization[0]!.id);

        const role = rowsOf(
          await transaction.execute(drizzleSql`
          INSERT INTO tenancy.roles
            (public_id, organization_id, name, is_system, created_by_user_id)
          VALUES (${generatePublicId('memberRole')}, ${organizationId}, 'Owner', true, ${ownerUserId})
          RETURNING id
        `),
        );
        const roleId = Number(role[0]!.id);

        return rowsOf(
          await transaction.execute(drizzleSql`
          INSERT INTO tenancy.memberships
            (public_id, user_id, organization_id, role_id, status, joined_at)
          VALUES (${generatePublicId('membership')}, ${ownerUserId}, ${organizationId}, ${roleId}, 'ACTIVE', now())
          RETURNING id
        `),
        );
      },
    );

    expect(membershipRows).toHaveLength(1);
  });

  it('rejects the org INSERT with an RLS violation when NO org context is set (the former global-admin path)', async () => {
    // The old provisioning set app.global_admin (which the org policy ignores) and no
    // app.current_organization_id — reproduced here as an empty tenant context. The WITH CHECK
    // `public_id = app.current_organization_id` cannot match, so the write is rejected.
    const organizationPublicId = generatePublicId('organization');

    let caught: unknown;
    try {
      await executeAsCoreBeAppTenant(null, (transaction) =>
        transaction.execute(drizzleSql`
          INSERT INTO tenancy.organizations
            (public_id, name, type, owner_user_id, created_by_user_id, updated_by_user_id)
          VALUES (${organizationPublicId}, 'Personal', 'PERSONAL', ${ownerUserId}, ${ownerUserId}, ${ownerUserId})
        `),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(flattenErrorChain(caught)).toMatch(/row-level security|42501/i);
  });
});
