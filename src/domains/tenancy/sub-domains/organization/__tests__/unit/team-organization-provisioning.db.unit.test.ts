import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeEach } from 'vitest';
import { BILLING_PERMISSIONS } from '@/domains/billing/billing.permissions.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { seedPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import {
  DEFAULT_TEAM_ROLES,
  ownerPermissionCodesForOrganizationType,
  provisionOrganizationWithOwner,
} from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { role_permissions } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.schema.js';
import { database } from '@/infrastructure/database/connection.js';

describe('team organization provisioning (database)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
    await seedPermissions([
      ...Object.values(TENANCY_PERMISSIONS),
      ...Object.values(BILLING_PERMISSIONS),
    ]);
  });

  it('grants billing permissions to TEAM organization owners', async () => {
    const user = await createTestUser();

    const result = await provisionOrganizationWithOwner({
      name: 'Acme',
      slug: 'acme-team-provision',
      type: 'TEAM',
      ownerUserId: user.id,
    });

    const codes = ownerPermissionCodesForOrganizationType('TEAM');
    expect(codes).toContain(BILLING_PERMISSIONS.SUBSCRIPTION_READ);
    expect(codes).toContain(BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE);

    const rows = await database
      .select({ permission_code: role_permissions.permission_code })
      .from(role_permissions)
      .where(eq(role_permissions.role_id, result.roleId));

    const granted = rows.map((row) => row.permission_code);
    expect(granted).toContain(BILLING_PERMISSIONS.SUBSCRIPTION_READ);
    expect(granted).toContain(BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE);
  });

  it('does not grant billing permissions to PERSONAL organization owners', async () => {
    const codes = ownerPermissionCodesForOrganizationType('PERSONAL');
    expect(codes).not.toContain(BILLING_PERMISSIONS.SUBSCRIPTION_READ);
    expect(codes).not.toContain(BILLING_PERMISSIONS.SUBSCRIPTION_MANAGE);
  });

  it('provisions the default Admin/Member/Viewer system roles for a TEAM org', async () => {
    const user = await createTestUser();

    const result = await provisionOrganizationWithOwner({
      name: 'Acme Defaults',
      slug: 'acme-team-default-roles',
      type: 'TEAM',
      ownerUserId: user.id,
    });

    const roleRows = await database
      .select({
        id: roles.id,
        name: roles.name,
        is_system: roles.is_system,
        public_id: roles.public_id,
      })
      .from(roles)
      .where(eq(roles.organization_id, result.organization.id));

    // Owner + every default role, all immutable and correctly prefixed.
    expect(roleRows.map((row) => row.name).sort()).toEqual(['Admin', 'Member', 'Owner', 'Viewer']);
    for (const row of roleRows) {
      expect(row.is_system).toBe(true);
      expect(row.public_id.startsWith('rol_')).toBe(true);
    }

    // Member and Viewer must carry organization:read so an assigned member can load the dashboard.
    for (const roleName of ['Member', 'Viewer']) {
      const row = roleRows.find((candidate) => candidate.name === roleName)!;
      const grants = await database
        .select({ code: role_permissions.permission_code })
        .from(role_permissions)
        .where(eq(role_permissions.role_id, row.id));
      expect(grants.map((grant) => grant.code)).toContain(TENANCY_PERMISSIONS.ORGANIZATION_READ);
    }

    // Each default role's granted codes match its catalog entry exactly.
    for (const defaultRole of DEFAULT_TEAM_ROLES) {
      const row = roleRows.find((candidate) => candidate.name === defaultRole.name)!;
      const grants = await database
        .select({ code: role_permissions.permission_code })
        .from(role_permissions)
        .where(eq(role_permissions.role_id, row.id));
      expect(grants.map((grant) => grant.code).sort()).toEqual(
        [...defaultRole.permissionCodes].sort(),
      );
    }
  });

  it('provisions only the Owner role for a PERSONAL organization (no default team roles)', async () => {
    const user = await createTestUser();

    const result = await provisionOrganizationWithOwner({
      name: 'Personal Space',
      slug: null,
      type: 'PERSONAL',
      ownerUserId: user.id,
    });

    const roleRows = await database
      .select({ name: roles.name })
      .from(roles)
      .where(eq(roles.organization_id, result.organization.id));

    expect(roleRows.map((row) => row.name)).toEqual(['Owner']);
  });
});
