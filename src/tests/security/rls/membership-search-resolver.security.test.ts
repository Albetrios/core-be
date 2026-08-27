import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  createMembership,
  createRoleWithPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  grantCoreBeAppRoleForTests,
  executeAsCoreBeAppTenant,
} from '@/tests/helpers/rls-matrix.helper.js';

/**
 * Regression guard for the member-search SECURITY DEFINER resolver
 * (`tenancy.search_organization_membership_ids`, migration 20260702000000).
 *
 * Server-side member search matches on the member's user email / name, which live in `auth.users` —
 * a FORCE ROW LEVEL SECURITY table behind a self-owner policy keyed on `app.current_user_public_id`. The
 * members list runs under ORG-only context (`app.current_organization_public_id` set, `app.current_user_public_id`
 * NOT set), so under the non-superuser `core_be_app` role a plain join from `tenancy.memberships`
 * to `auth.users` resolves the auth.users policy to NULL and returns ZERO rows — search would
 * silently match nothing in production while passing under the RLS-exempt CI superuser. The resolver
 * bypasses RLS by explicit organization scoping.
 *
 * These tests run as `core_be_app` precisely because the local/CI default superuser is RLS-exempt
 * and would hide the bug. If the resolver is dropped or the repository reverts to a raw join, the
 * "definer returns the match" assertion fails.
 */
function scalarFromResult<T>(result: unknown, key: string): T {
  const rows = (
    Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  ) as Record<string, unknown>[];
  return rows[0]?.[key] as T;
}

function idsFromResult(result: unknown): number[] {
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
    id: number | string;
  }[];
  return rows.map((row) => Number(row.id));
}

describe('Security: member-search resolver under FORCE RLS', () => {
  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('resolver returns the matching membership id under org-only context, where a raw join is RLS-blocked to 0 rows', async () => {
    const owner = await createTestUser({ email: 'rls-owner@example.com' });
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [],
      createdByUserId: owner.id,
    });
    const member = await createTestUser({
      email: 'rls-search@example.com',
      firstName: 'Rhoda',
      lastName: 'Searchman',
    });
    const membership = await createMembership({
      userId: member.id,
      organizationId: organization.id,
      roleId: role.id,
    });

    await executeAsCoreBeAppTenant(organization.public_id, async (transaction) => {
      // Memberships ARE visible under the org GUC (proves the org policy is satisfied)…
      const membershipCount = await transaction.execute(
        drizzleSql`SELECT count(*)::int AS count FROM tenancy.memberships WHERE organization_id = ${organization.id}`,
      );
      expect(scalarFromResult<number>(membershipCount, 'count')).toBeGreaterThan(0);

      // …but the raw join to auth.users (the search would need) is RLS-blocked to 0 rows: the exact
      // production condition that would make search silently match nothing.
      const rawJoinCount = await transaction.execute(
        drizzleSql`SELECT count(*)::int AS count
                   FROM tenancy.memberships AS m
                   JOIN auth.users AS u ON u.id = m.user_id
                   WHERE m.organization_id = ${organization.id}
                     AND u.email ILIKE '%rls-search%'`,
      );
      expect(scalarFromResult<number>(rawJoinCount, 'count')).toBe(0);

      // The SECURITY DEFINER resolver bypasses RLS by ownership and returns the match.
      const resolved = await transaction.execute(
        drizzleSql`SELECT id FROM tenancy.search_organization_membership_ids(${organization.id}::bigint, ${'%rls-search%'}::text)`,
      );
      expect(idsFromResult(resolved)).toEqual([membership.id]);
    });
  });

  it('resolver is organization-scoped: it never returns another org’s matching membership', async () => {
    const shared = await createTestUser({ email: 'rls-shared@example.com' });

    const ownerA = await createTestUser({ email: 'rls-a@example.com' });
    const orgA = await createTestOrganization({ ownerUserId: ownerA.id });
    const roleA = await createRoleWithPermissions({
      organizationId: orgA.id,
      permissionCodes: [],
      createdByUserId: ownerA.id,
    });
    const membershipA = await createMembership({
      userId: shared.id,
      organizationId: orgA.id,
      roleId: roleA.id,
    });

    const ownerB = await createTestUser({ email: 'rls-b@example.com' });
    const orgB = await createTestOrganization({ ownerUserId: ownerB.id });
    const roleB = await createRoleWithPermissions({
      organizationId: orgB.id,
      permissionCodes: [],
      createdByUserId: ownerB.id,
    });
    await createMembership({ userId: shared.id, organizationId: orgB.id, roleId: roleB.id });

    await executeAsCoreBeAppTenant(orgA.public_id, async (transaction) => {
      const resolved = await transaction.execute(
        drizzleSql`SELECT id FROM tenancy.search_organization_membership_ids(${orgA.id}::bigint, ${'%rls-shared%'}::text)`,
      );
      // Only org A's membership for the shared user — org B's row for the same email is excluded.
      expect(idsFromResult(resolved)).toEqual([membershipA.id]);
    });
  });
});
