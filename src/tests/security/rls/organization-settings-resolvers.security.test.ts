import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { database } from '@/infrastructure/database/connection.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  createMembership,
  createRoleWithPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  grantCoreBeAppRoleForTests,
  executeAsCoreBeAppUser,
} from '@/tests/helpers/rls-matrix.helper.js';
import { organization_settings } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.schema.js';
import { OrganizationSettingsRepository } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.repository.js';

/**
 * Regression guard for the production-only organization-mandated-MFA bypass.
 *
 * `tenancy.memberships` / `tenancy.organization_settings` are FORCE ROW LEVEL SECURITY. The
 * login-time MFA-enforcement check and default-locale lookup run before any tenant GUC exists,
 * so under the non-superuser `core_be_app` role (which production uses) a plain SELECT resolves
 * the tenant policy to NULL and returns ZERO rows — which silently disabled organization-mandated MFA.
 * The fix routes both reads through SECURITY DEFINER resolvers that bypass RLS by ownership.
 *
 * These tests run as `core_be_app` precisely because the local/CI default superuser is RLS-exempt
 * and would hide the bug. If the resolver functions are dropped, or the repository reverts to a
 * raw RLS-subject query, these fail.
 */
function scalarFromResult<T>(result: unknown, key: string): T {
  const rows = (
    Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  ) as Record<string, unknown>[];
  return rows[0]?.[key] as T;
}

async function seedUserInOrg(options: {
  mfaRequired: boolean;
  locale?: 'en' | 'es';
  membershipStatus?: 'ACTIVE' | 'INVITED' | 'SUSPENDED';
}) {
  const user = await createTestUser();
  const organization = await createTestOrganization({ ownerUserId: user.id });
  const role = await createRoleWithPermissions({
    organizationId: organization.id,
    permissionCodes: [],
    createdByUserId: user.id,
  });
  await createMembership({
    userId: user.id,
    organizationId: organization.id,
    roleId: role.id,
    status: options.membershipStatus ?? 'ACTIVE',
  });
  await database.insert(organization_settings).values({
    organization_id: organization.id,
    security_policy: { mfa_required: options.mfaRequired },
    default_locale: options.locale ?? 'en',
  });
  return { user, organization };
}

describe('Security: organization-settings login-time resolvers under FORCE RLS', () => {
  const repository = new OrganizationSettingsRepository();

  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('MFA resolver returns true under core_be_app with NO tenant context, where a raw query is RLS-blocked to 0 rows', async () => {
    const { user } = await seedUserInOrg({ mfaRequired: true });

    // Control — reproduce the exact production condition that caused the bug: a plain SELECT
    // under the non-superuser role with no GUC sees zero membership rows (FORCE RLS).
    const rawMembershipCount = await executeAsCoreBeAppUser(null, async (transaction) => {
      const result = await transaction.execute(
        drizzleSql`SELECT count(*)::int AS count FROM tenancy.memberships WHERE user_id = ${user.id}`,
      );
      return scalarFromResult<number>(result, 'count');
    });
    expect(rawMembershipCount).toBe(0);

    // Fix — the SECURITY DEFINER resolver bypasses RLS by ownership and returns the truth.
    const requiresMfa = await executeAsCoreBeAppUser(null, async (transaction) => {
      const result = await transaction.execute(
        drizzleSql`SELECT tenancy.user_has_organization_requiring_mfa(${user.id}) AS requires_mfa`,
      );
      return scalarFromResult<boolean>(result, 'requires_mfa');
    });
    expect(requiresMfa).toBe(true);
  });

  it('repository.userHasOrganizationRequiringMfa is true only for an ACTIVE membership in an mfa_required org', async () => {
    const requiring = await seedUserInOrg({ mfaRequired: true });
    await expect(repository.userHasOrganizationRequiringMfa(requiring.user.id)).resolves.toBe(true);

    const notRequiring = await seedUserInOrg({ mfaRequired: false });
    await expect(repository.userHasOrganizationRequiringMfa(notRequiring.user.id)).resolves.toBe(
      false,
    );

    // Pending (INVITED) members are not yet subject to organization policy.
    const invited = await seedUserInOrg({ mfaRequired: true, membershipStatus: 'INVITED' });
    await expect(repository.userHasOrganizationRequiringMfa(invited.user.id)).resolves.toBe(false);

    // A string "true" is NOT a boolean true — must not trip the strict check.
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [],
      createdByUserId: user.id,
    });
    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: role.id,
      status: 'ACTIVE',
    });
    await database.insert(organization_settings).values({
      organization_id: organization.id,
      security_policy: { mfa_required: 'true' },
      default_locale: 'en',
    });
    await expect(repository.userHasOrganizationRequiringMfa(user.id)).resolves.toBe(false);
  });

  it('default-locale resolver returns the organization locale under FORCE RLS (and null for unknown organizations)', async () => {
    const { organization } = await seedUserInOrg({ mfaRequired: false, locale: 'es' });

    await expect(
      repository.findDefaultLocaleByOrganizationPublicId(organization.public_id),
    ).resolves.toBe('es');
    await expect(
      repository.findDefaultLocaleByOrganizationPublicId('organization_that_does_not_exist'),
    ).resolves.toBeNull();

    // And it must resolve under the non-superuser role too (the production path).
    const localeUnderAppRole = await executeAsCoreBeAppUser(null, async (transaction) => {
      const result = await transaction.execute(
        drizzleSql`SELECT tenancy.resolve_organization_default_locale(${organization.public_id}) AS default_locale`,
      );
      return scalarFromResult<string>(result, 'default_locale');
    });
    expect(localeUnderAppRole).toBe('es');
  });
});
