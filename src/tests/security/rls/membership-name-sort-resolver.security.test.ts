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
 * Regression guard for the member name-SORT SECURITY DEFINER resolver
 * (`tenancy.list_organization_membership_ids_by_name`, migration 20260702010000).
 *
 * Sorting the members list by name orders on the member's `auth.users` display name — a FORCE ROW
 * LEVEL SECURITY table behind a self-owner policy keyed on `app.current_user_public_id`. The members list
 * runs under ORG-only context (`app.current_organization_public_id` set, `app.current_user_public_id` NOT set), so
 * under the non-superuser `core_be_app` role a plain join from `tenancy.memberships` to `auth.users`
 * resolves to ZERO rows — sort-by-name would silently return an empty page in production while
 * passing under the RLS-exempt CI superuser. The resolver bypasses RLS by explicit organization
 * scoping and does the ordering + keyset + limit inside SQL.
 *
 * These tests run as `core_be_app` precisely because the local/CI default superuser is RLS-exempt
 * and would hide the bug. If the resolver is dropped or the repository reverts to a raw join, the
 * "definer returns ordered ids" assertion fails.
 */
function orderedRowsFromResult(result: unknown): Array<{ id: number; sort_value: string }> {
  const rows = (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
    id: number | string;
    sort_value: string;
  }[];
  return rows.map((row) => ({ id: Number(row.id), sort_value: row.sort_value }));
}

function scalarFromResult<T>(result: unknown, key: string): T {
  const rows = (
    Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  ) as Record<string, unknown>[];
  return rows[0]?.[key] as T;
}

describe('Security: member name-sort resolver under FORCE RLS', () => {
  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('resolver returns name-ordered membership ids under organization-only context, where a raw join is RLS-blocked to 0 rows', async () => {
    const owner = await createTestUser({
      email: 'sort-owner@example.com',
      firstName: 'Mallory',
      lastName: 'Owner',
    });
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [],
      createdByUserId: owner.id,
    });
    const ownerMembership = await createMembership({
      userId: owner.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    const alice = await createTestUser({
      email: 'sort-alice@example.com',
      firstName: 'Alice',
      lastName: 'Anderson',
    });
    const aliceMembership = await createMembership({
      userId: alice.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    const zoe = await createTestUser({
      email: 'sort-zoe@example.com',
      firstName: 'Zoe',
      lastName: 'Zimmer',
    });
    const zoeMembership = await createMembership({
      userId: zoe.id,
      organizationId: organization.id,
      roleId: role.id,
    });

    await executeAsCoreBeAppTenant(organization.public_id, async (transaction) => {
      // The raw join to auth.users (that an ORDER BY on the member name would need) is RLS-blocked to
      // 0 rows — the exact production condition that would make sort-by-name return an empty page.
      const rawJoinCount = await transaction.execute(
        drizzleSql`SELECT count(*)::int AS count
                   FROM tenancy.memberships AS m
                   JOIN auth.users AS u ON u.id = m.user_id
                   WHERE m.organization_id = ${organization.id}`,
      );
      expect(scalarFromResult<number>(rawJoinCount, 'count')).toBe(0);

      // Ascending by display name: Alice Anderson < Mallory Owner < Zoe Zimmer.
      const asc = await transaction.execute(
        drizzleSql`SELECT id, sort_value FROM tenancy.list_organization_membership_ids_by_name(${organization.id}::bigint, ${null}::text, ${false}::boolean, ${null}::text, ${null}::bigint, ${50}::int)`,
      );
      expect(orderedRowsFromResult(asc).map((row) => row.id)).toEqual([
        aliceMembership.id,
        ownerMembership.id,
        zoeMembership.id,
      ]);

      // Descending reverses the order.
      const desc = await transaction.execute(
        drizzleSql`SELECT id, sort_value FROM tenancy.list_organization_membership_ids_by_name(${organization.id}::bigint, ${null}::text, ${true}::boolean, ${null}::text, ${null}::bigint, ${50}::int)`,
      );
      expect(orderedRowsFromResult(desc).map((row) => row.id)).toEqual([
        zoeMembership.id,
        ownerMembership.id,
        aliceMembership.id,
      ]);
    });
  });

  it('resolver honors the keyset cursor: the second page starts after the boundary (sort_value, id)', async () => {
    const owner = await createTestUser({
      email: 'k-owner@example.com',
      firstName: 'Mid',
      lastName: 'Owner',
    });
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [],
      createdByUserId: owner.id,
    });
    await createMembership({ userId: owner.id, organizationId: organization.id, roleId: role.id });
    const alice = await createTestUser({
      email: 'k-alice@example.com',
      firstName: 'Alice',
      lastName: 'A',
    });
    await createMembership({ userId: alice.id, organizationId: organization.id, roleId: role.id });
    const zoe = await createTestUser({
      email: 'k-zoe@example.com',
      firstName: 'Zoe',
      lastName: 'Z',
    });
    const zoeMembership = await createMembership({
      userId: zoe.id,
      organizationId: organization.id,
      roleId: role.id,
    });

    await executeAsCoreBeAppTenant(organization.public_id, async (transaction) => {
      // First page of one → Alice (ascending).
      const firstPage = await transaction.execute(
        drizzleSql`SELECT id, sort_value FROM tenancy.list_organization_membership_ids_by_name(${organization.id}::bigint, ${null}::text, ${false}::boolean, ${null}::text, ${null}::bigint, ${1}::int)`,
      );
      const first = orderedRowsFromResult(firstPage);
      expect(first).toHaveLength(1);
      const boundary = first[0]!;

      // Next page after (boundary.sort_value, boundary.id) → the remaining two, still ordered, and
      // the boundary row is never repeated.
      const secondPage = await transaction.execute(
        drizzleSql`SELECT id, sort_value FROM tenancy.list_organization_membership_ids_by_name(${organization.id}::bigint, ${null}::text, ${false}::boolean, ${boundary.sort_value}::text, ${boundary.id}::bigint, ${50}::int)`,
      );
      const secondIds = orderedRowsFromResult(secondPage).map((row) => row.id);
      expect(secondIds).not.toContain(boundary.id);
      expect(secondIds).toContain(zoeMembership.id);
      expect(secondIds).toHaveLength(2);
    });
  });

  it('resolver is organization-scoped: it never returns another organization’s membership', async () => {
    const shared = await createTestUser({
      email: 'sort-shared@example.com',
      firstName: 'Shared',
      lastName: 'User',
    });

    const ownerA = await createTestUser({ email: 'sort-a@example.com' });
    const organizationA = await createTestOrganization({ ownerUserId: ownerA.id });
    const roleA = await createRoleWithPermissions({
      organizationId: organizationA.id,
      permissionCodes: [],
      createdByUserId: ownerA.id,
    });
    const membershipA = await createMembership({
      userId: shared.id,
      organizationId: organizationA.id,
      roleId: roleA.id,
    });

    const ownerB = await createTestUser({ email: 'sort-b@example.com' });
    const organizationB = await createTestOrganization({ ownerUserId: ownerB.id });
    const roleB = await createRoleWithPermissions({
      organizationId: organizationB.id,
      permissionCodes: [],
      createdByUserId: ownerB.id,
    });
    await createMembership({
      userId: shared.id,
      organizationId: organizationB.id,
      roleId: roleB.id,
    });

    await executeAsCoreBeAppTenant(organizationA.public_id, async (transaction) => {
      const resolved = await transaction.execute(
        drizzleSql`SELECT id, sort_value FROM tenancy.list_organization_membership_ids_by_name(${organizationA.id}::bigint, ${'%shared%'}::text, ${false}::boolean, ${null}::text, ${null}::bigint, ${50}::int)`,
      );
      // Only organization A's membership for the shared user — organization B's row for the same user is excluded.
      expect(orderedRowsFromResult(resolved).map((row) => row.id)).toEqual([membershipA.id]);
    });
  });
});
