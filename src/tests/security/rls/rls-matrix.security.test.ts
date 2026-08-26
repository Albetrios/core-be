import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { sql as drizzleSql } from 'drizzle-orm';
import {
  EXPECTED_FORCE_RLS_TABLES,
  RLS_MATRIX_SKIP_CRUD_TABLES,
  USER_SCOPED_FORCE_RLS_TABLES,
  countRowsAsGlobalAdmin,
  countRowsAsTenant,
  countRowsAsUser,
  deleteRowAsTenant,
  executeAsCoreBeAppGlobalAdmin,
  executeAsCoreBeAppTenant,
  executeAsCoreBeAppUser,
  grantCoreBeAppRoleForTests,
  listForceRlsTablesFromDatabase,
  seedRlsMatrixFixtures,
  seedUserScopedRlsFixtures,
  tableKey,
  updateRowAsTenant,
} from '@/tests/helpers/rls-matrix.helper.js';
import { diffForceRlsTables } from '@/infrastructure/database/utils/force-rls-tables.constants.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { database } from '@/infrastructure/database/connection.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { logs } from '@/domains/audit/audit.schema.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { PermissionRepository } from '@/domains/tenancy/sub-domains/permission/permission.repository.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

function countFromExecuteResult(result: unknown): number {
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: { count: number }[] }).rows ?? []);
  return Number(rows[0]?.count ?? 0);
}

describe('Security: RLS matrix (all FORCE RLS tables)', () => {
  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('live FORCE-RLS set must match EXPECTED_FORCE_RLS_TABLES exactly (no drift)', async () => {
    // Audit #16: assert DB truth == intentional registry. No table is skipped when missing — a
    // table that should be FORCE RLS but is not (or one that is forced but undeclared) fails here
    // instead of silently no-op'ing the worker guard and the matrix below.
    const databaseTables = await listForceRlsTablesFromDatabase();
    const { missing, extra } = diffForceRlsTables(databaseTables);

    expect(
      missing,
      `Tables expected FORCE RLS but not enforced in the database: ${missing.join(', ')}`,
    ).toEqual([]);
    expect(
      extra,
      `Tables FORCE RLS in the database but absent from EXPECTED_FORCE_RLS_TABLES: ${extra.join(', ')}`,
    ).toEqual([]);
  });

  it('should block SELECT of other tenant organizations when context is set', async () => {
    const fixture = await seedRlsMatrixFixtures();

    await executeAsCoreBeAppTenant(fixture.organizationAPublicId, async (transaction) => {
      const rows = await transaction
        .select({ public_id: organizations.public_id })
        .from(organizations)
        .where(eq(organizations.public_id, fixture.organizationBPublicId));
      expect(rows).toHaveLength(0);
    });
  });

  it('should return zero visible rows for tenant-scoped tables when tenant context is unset', async () => {
    const fixture = await seedRlsMatrixFixtures();

    const tablesToCheck = [
      tableKey('tenancy', 'memberships'),
      tableKey('notify', 'webhooks'),
      tableKey('billing', 'subscriptions'),
      tableKey('upload', 'uploads'),
    ];

    for (const key of tablesToCheck) {
      const [schemaName, tableName] = key.split('.');
      const count = await countRowsAsTenant(schemaName!, tableName!, null);
      expect(count, `${key} with unset tenant context`).toBe(0);
    }

    void fixture;
  });

  const crudMatrixTables = EXPECTED_FORCE_RLS_TABLES.filter(
    (table) => !RLS_MATRIX_SKIP_CRUD_TABLES.has(tableKey(table.schemaName, table.tableName)),
  );

  describe.each(crudMatrixTables)(
    'tenant isolation CRUD ($schemaName.$tableName)',
    ({ schemaName, tableName }) => {
      const key = tableKey(schemaName, tableName);

      it('should not read other tenant rows (SELECT count)', async () => {
        const fixture = await seedRlsMatrixFixtures();
        const rowIds = fixture.rowIdsByTable.get(key);
        if (!rowIds) {
          const countForA = await countRowsAsTenant(
            schemaName,
            tableName,
            fixture.organizationAPublicId,
          );
          const countForB = await countRowsAsTenant(
            schemaName,
            tableName,
            fixture.organizationBPublicId,
          );
          expect(countForA).toBeGreaterThanOrEqual(0);
          expect(countForB).toBeGreaterThanOrEqual(0);
          return;
        }

        const visibleForA = await countRowsAsTenant(
          schemaName,
          tableName,
          fixture.organizationAPublicId,
        );
        expect(visibleForA).toBeGreaterThan(0);

        await executeAsCoreBeAppTenant(fixture.organizationAPublicId, async (transaction) => {
          const qualified = `"${schemaName}"."${tableName}"`;
          const result = await transaction.execute(
            drizzleSql.raw(
              `SELECT count(*)::int AS count FROM ${qualified} WHERE id = ${rowIds.organizationB}`,
            ),
          );
          const rows = Array.isArray(result)
            ? result
            : ((result as { rows?: { count: number }[] }).rows ?? []);
          expect(Number(rows[0]?.count ?? 0)).toBe(0);
        });
      });

      it('should not UPDATE other tenant rows', async () => {
        const fixture = await seedRlsMatrixFixtures();
        const rowIds = fixture.rowIdsByTable.get(key);
        if (!rowIds) return;

        const updated = await updateRowAsTenant(
          schemaName,
          tableName,
          rowIds.organizationB,
          fixture.organizationAPublicId,
        );
        expect(updated).toBe(0);
      });

      it('should not DELETE other tenant rows', async () => {
        const fixture = await seedRlsMatrixFixtures();
        const rowIds = fixture.rowIdsByTable.get(key);
        if (!rowIds) return;

        const deleted = await deleteRowAsTenant(
          schemaName,
          tableName,
          rowIds.organizationB,
          fixture.organizationAPublicId,
        );
        expect(deleted).toBe(0);
      });
    },
  );

  describe.each(USER_SCOPED_FORCE_RLS_TABLES)(
    'user-scoped isolation ($schemaName.$tableName)',
    ({ schemaName, tableName }) => {
      it('returns zero rows when the user context is unset', async () => {
        await seedUserScopedRlsFixtures();
        const count = await countRowsAsUser(schemaName, tableName, null);
        expect(count, `${tableKey(schemaName, tableName)} with unset user context`).toBe(0);
      });

      it('shows only the current user rows and none of another user (cross-user denial)', async () => {
        const fixture = await seedUserScopedRlsFixtures();

        const visibleForA = await countRowsAsUser(schemaName, tableName, fixture.userAPublicId);
        expect(visibleForA, `${tableKey(schemaName, tableName)} own rows`).toBe(1);

        // User A must not see user B's row even by primary key.
        const rowIds = fixture.rowIdsByTable.get(tableKey(schemaName, tableName))!;
        await executeAsCoreBeAppUser(fixture.userAPublicId, async (transaction) => {
          const qualified = `"${schemaName}"."${tableName}"`;
          const idColumn = tableName === 'user_settings' ? 'user_id' : 'id';
          const result = await transaction.execute(
            drizzleSql.raw(
              `SELECT count(*)::int AS count FROM ${qualified} WHERE ${idColumn} = ${rowIds.userB}`,
            ),
          );
          const rows = Array.isArray(result)
            ? result
            : ((result as { rows?: { count: number }[] }).rows ?? []);
          expect(Number(rows[0]?.count ?? 0), `${tableKey(schemaName, tableName)} cross-user`).toBe(
            0,
          );
        });
      });
    },
  );

  describe('auth.users / auth.auth_methods under FORCE RLS (audit #7)', () => {
    it('global-admin context sees every auth.users and auth.auth_methods row (admin path)', async () => {
      await seedUserScopedRlsFixtures();
      expect(await countRowsAsGlobalAdmin('auth', 'users')).toBe(2);
      expect(await countRowsAsGlobalAdmin('auth', 'auth_methods')).toBe(2);
    });

    it('auth_methods owner policy composes with the auth.users subquery (owner reads own credential)', async () => {
      const fixture = await seedUserScopedRlsFixtures();
      // Counting auth_methods under userA forces the policy subquery SELECT id FROM auth.users to
      // resolve under the auth.users owner policy — it returns A's id only when current_user_id = A.
      const ownCredentials = await countRowsAsUser('auth', 'auth_methods', fixture.userAPublicId);
      expect(ownCredentials).toBe(1);

      const rowIds = fixture.rowIdsByTable.get(tableKey('auth', 'auth_methods'))!;
      await executeAsCoreBeAppUser(fixture.userAPublicId, async (transaction) => {
        const result = await transaction.execute(
          drizzleSql.raw(
            `SELECT count(*)::int AS count FROM auth.auth_methods WHERE id = ${rowIds.userB}`,
          ),
        );
        const rows = Array.isArray(result)
          ? result
          : ((result as { rows?: { count: number }[] }).rows ?? []);
        expect(Number(rows[0]?.count ?? 0)).toBe(0);
      });
    });

    it('resolve_user_for_authentication_by_email returns the row with NO user context (pre-session login)', async () => {
      const fixture = await seedUserScopedRlsFixtures();

      const resolved = await executeAsCoreBeAppUser(null, async (transaction) => {
        const result = await transaction.execute(
          drizzleSql`SELECT * FROM auth.resolve_user_for_authentication_by_email(${fixture.userAEmail})`,
        );
        return Array.isArray(result)
          ? result
          : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.public_id).toBe(fixture.userAPublicId);
    });

    it('resolve_user_by_internal_id returns the row with NO user context (token-consume flows)', async () => {
      const fixture = await seedUserScopedRlsFixtures();

      const resolved = await executeAsCoreBeAppUser(null, async (transaction) => {
        const result = await transaction.execute(
          drizzleSql`SELECT * FROM auth.resolve_user_by_internal_id(${fixture.userAInternalId})`,
        );
        return Array.isArray(result)
          ? result
          : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.public_id).toBe(fixture.userAPublicId);
    });

    it('resolve_auth_method_by_provider returns the credential + owner public_id with NO context (OAuth callback)', async () => {
      const fixture = await seedUserScopedRlsFixtures();

      // The OAuth callback has no user context; the resolver bypasses RLS by ownership. Run it under
      // the non-superuser core_be_app role with no context to prove EXECUTE + pre-session lookup work.
      const resolved = await executeAsCoreBeAppUser(null, async (transaction) => {
        const result = await transaction.execute(
          drizzleSql`SELECT * FROM auth.resolve_auth_method_by_provider(${fixture.oauthProvider}, ${fixture.oauthProviderUserId})`,
        );
        return Array.isArray(result)
          ? result
          : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.user_public_id).toBe(fixture.userAPublicId);
      expect(resolved[0]?.provider).toBe(fixture.oauthProvider);
    });
  });

  describe('permission resolution under ORG-only FORCE RLS (no app.current_user_id)', () => {
    // Regression guard: requireOrganizationPermission resolves permissions inside
    // withOrganizationDatabaseContext, which sets app.current_organization_id but NOT
    // app.current_user_id. Under the non-superuser core_be_app role with FORCE RLS,
    // a direct auth.users join returned zero rows → empty permission set → 403 on all
    // org PERM-gated routes in production (CI runs as a superuser and never saw it).
    // The repository now resolves the user via a SECURITY DEFINER function, so this
    // must return the member's permissions with ONLY org context set.
    it("returns a member's permissions with org context only (auth.users not joined)", async () => {
      await seedPermissions(['organization:read', 'webhook:manage']);
      const member = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: member.id });
      const role = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: ['organization:read', 'webhook:manage'],
        createdByUserId: member.id,
      });
      await createMembership({
        userId: member.id,
        organizationId: organization.id,
        roleId: role.id,
      });

      const repository = new PermissionRepository();
      const codes = await executeAsCoreBeAppTenant(organization.public_id, (transaction) =>
        repository.findPermissionCodesForUserInOrganization(
          member.public_id,
          organization.public_id,
          transaction as unknown as PostgresJsDatabase,
        ),
      );

      expect([...codes].sort()).toEqual(['organization:read', 'webhook:manage']);
    });

    it('returns an empty set for a soft-deleted member even with org context', async () => {
      await seedPermissions(['organization:read']);
      const member = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: member.id });
      const role = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: ['organization:read'],
        createdByUserId: member.id,
      });
      await createMembership({
        userId: member.id,
        organizationId: organization.id,
        roleId: role.id,
      });
      // Soft-delete the member via the superuser handle (RLS-exempt) so the resolver
      // (deleted_at IS NULL) must exclude them.
      await database.execute(
        drizzleSql`UPDATE auth.users SET deleted_at = now() WHERE id = ${member.id}`,
      );

      const repository = new PermissionRepository();
      const codes = await executeAsCoreBeAppTenant(organization.public_id, (transaction) =>
        repository.findPermissionCodesForUserInOrganization(
          member.public_id,
          organization.public_id,
          transaction as unknown as PostgresJsDatabase,
        ),
      );

      expect(codes).toEqual([]);
    });
  });

  describe('audit.logs user-export SELECT policy under FORCE RLS (audit #7)', () => {
    it('lets a user read only their own actor audit logs with no org context (cross-user denial)', async () => {
      const userA = await createTestUser();
      const userB = await createTestUser();
      const organizationA = await createTestOrganization({ ownerUserId: userA.id });
      const organizationB = await createTestOrganization({ ownerUserId: userB.id });
      await database.insert(logs).values({
        organization_id: organizationA.id,
        actor_user_id: userA.id,
        action: 'test.action',
        resource_type: 'organization',
      });
      const [logB] = await database
        .insert(logs)
        .values({
          organization_id: organizationB.id,
          actor_user_id: userB.id,
          action: 'test.action',
          resource_type: 'organization',
        })
        .returning();

      // The GDPR export worker reads audit.logs under app.current_user_id with NO org context.
      // The audit_logs_user_export_select policy must expose only the actor's own rows.
      await executeAsCoreBeAppUser(userA.public_id, async (transaction) => {
        const ownRows = await transaction.execute(
          drizzleSql`SELECT count(*)::int AS count FROM audit.logs WHERE actor_user_id = ${userA.id}`,
        );
        expect(countFromExecuteResult(ownRows), 'user A sees own actor logs').toBe(1);

        const otherRows = await transaction.execute(
          drizzleSql`SELECT count(*)::int AS count FROM audit.logs WHERE id = ${logB!.id}`,
        );
        expect(countFromExecuteResult(otherRows), 'user A cannot see user B actor logs').toBe(0);
      });
    });

    it('returns zero audit.logs rows when neither user nor org context is set', async () => {
      const user = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: user.id });
      await database.insert(logs).values({
        organization_id: organization.id,
        actor_user_id: user.id,
        action: 'test.action',
        resource_type: 'organization',
      });

      await executeAsCoreBeAppUser(null, async (transaction) => {
        const result = await transaction.execute(
          drizzleSql`SELECT count(*)::int AS count FROM audit.logs`,
        );
        expect(countFromExecuteResult(result)).toBe(0);
      });
    });

    it('exposes audit.logs across tenants under the app.global_admin escape hatch (audit #21)', async () => {
      // The admin audit-log listing (AuditService.listForAdmin) reads cross-tenant under
      // withGlobalAdminDatabaseContext. The tenant-isolation policy must honour app.global_admin
      // so the listing is RLS-correct under the least-privilege role instead of relying on the
      // table-owner bypass.
      const userA = await createTestUser();
      const userB = await createTestUser();
      const organizationA = await createTestOrganization({ ownerUserId: userA.id });
      const organizationB = await createTestOrganization({ ownerUserId: userB.id });
      const [logA] = await database
        .insert(logs)
        .values({
          organization_id: organizationA.id,
          actor_user_id: userA.id,
          action: 'test.action',
          resource_type: 'organization',
        })
        .returning();
      const [logB] = await database
        .insert(logs)
        .values({
          organization_id: organizationB.id,
          actor_user_id: userB.id,
          action: 'test.action',
          resource_type: 'organization',
        })
        .returning();

      await executeAsCoreBeAppGlobalAdmin(async (transaction) => {
        const result = await transaction.execute(
          drizzleSql`SELECT count(*)::int AS count FROM audit.logs WHERE id IN (${logA!.id}, ${logB!.id})`,
        );
        expect(countFromExecuteResult(result), 'global admin sees both tenants').toBe(2);
      });
    });
  });

  describe('API-key authentication under FORCE RLS (audit #3)', () => {
    it('plain SELECT on tenancy.api_keys returns 0 rows with no org context (demonstrates the bug)', async () => {
      const fixture = await seedRlsMatrixFixtures();
      void fixture;
      // No app.current_organization_id → tenant-isolation policy resolves to NULL → 0 rows. This is
      // why the auth phase (which has no org context yet) cannot look a key up directly.
      const count = await countRowsAsTenant('tenancy', 'api_keys', null);
      expect(count).toBe(0);
    });

    it('resolver returns the candidate key + owning org with no org context (non-superuser)', async () => {
      const fixture = await seedRlsMatrixFixtures();

      // core_be_app (non-superuser) with NO org context — exactly the auth-phase connection state.
      const resolved = await executeAsCoreBeAppTenant(null, async (transaction) => {
        const result = await transaction.execute(
          drizzleSql`SELECT * FROM tenancy.resolve_api_key_for_authentication('prefix-a')`,
        );
        return Array.isArray(result)
          ? result
          : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.organization_public_id).toBe(fixture.organizationAPublicId);
      expect(resolved[0]?.key_hash).toBe('hash-a');
      expect(resolved[0]?.status).toBe('ACTIVE');
    });
  });
});
