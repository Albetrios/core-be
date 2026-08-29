import { describe, it, expect, beforeEach } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { sql } from '@/infrastructure/database/connection.js';
import { PermissionRepository } from '@/domains/tenancy/sub-domains/permission/permission.repository.js';

describe('PermissionRepository cross-organization isolation (database)', () => {
  const repository = new PermissionRepository();

  beforeEach(async () => {
    await cleanupDatabase();
    await seedPermissions(['organization:read', 'organization:manage']);
  });

  it('returns empty permission set for user with no active membership in org', async () => {
    const owner = await createTestUser({ email: 'owner-no-membership@example.com' });
    const stranger = await createTestUser({ email: 'stranger-no-membership@example.com' });
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ['organization:read'],
    });

    const codes = await repository.findPermissionCodesForUserInOrganization(
      stranger.public_id,
      organization.public_id,
    );

    expect(codes).toEqual([]);
  });

  it('returns empty permission set for user whose membership in organization is soft-deleted', async () => {
    const owner = await createTestUser({ email: 'owner-soft-deleted@example.com' });
    const member = await createTestUser({ email: 'member-soft-deleted@example.com' });
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ['organization:read', 'organization:manage'],
    });
    const membership = await createMembership({
      userId: member.id,
      organizationId: organization.id,
      roleId: role.id,
      status: 'ACTIVE',
    });

    const beforeDelete = await repository.findPermissionCodesForUserInOrganization(
      member.public_id,
      organization.public_id,
    );
    expect(beforeDelete.sort()).toEqual(['organization:manage', 'organization:read']);

    await sql`
      UPDATE tenancy.memberships
      SET deleted_at = now(), updated_at = now()
      WHERE id = ${membership.id}
    `;

    const afterDelete = await repository.findPermissionCodesForUserInOrganization(
      member.public_id,
      organization.public_id,
    );
    expect(afterDelete).toEqual([]);
  });

  it('returns empty permission set for user whose membership status is non-ACTIVE (INVITED / SUSPENDED)', async () => {
    const owner = await createTestUser({ email: 'owner-non-active@example.com' });
    const invited = await createTestUser({ email: 'invited-non-active@example.com' });
    const suspended = await createTestUser({ email: 'suspended-non-active@example.com' });
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ['organization:read'],
    });

    await sql`
      INSERT INTO tenancy.memberships
        (public_id, user_id, organization_id, role_id, status, created_at, updated_at)
      VALUES
        (${'mem_invited_test_id'}, ${invited.id}, ${organization.id}, ${role.id}, 'INVITED', now(), now())
    `;
    await sql`
      INSERT INTO tenancy.memberships
        (public_id, user_id, organization_id, role_id, status, joined_at, created_at, updated_at)
      VALUES
        (${'mem_suspended_t_id'}, ${suspended.id}, ${organization.id}, ${role.id}, 'SUSPENDED', now(), now(), now())
    `;

    const invitedCodes = await repository.findPermissionCodesForUserInOrganization(
      invited.public_id,
      organization.public_id,
    );
    const suspendedCodes = await repository.findPermissionCodesForUserInOrganization(
      suspended.public_id,
      organization.public_id,
    );

    expect(invitedCodes).toEqual([]);
    expect(suspendedCodes).toEqual([]);
  });

  it('does not leak permissions across organizations (user in organization A returns empty for organization B)', async () => {
    const owner = await createTestUser({ email: 'cross-organization-owner@example.com' });
    const member = await createTestUser({ email: 'cross-organization-member@example.com' });
    const organizationA = await createTestOrganization({
      ownerUserId: owner.id,
      slug: 'cross-organization-a',
    });
    const organizationB = await createTestOrganization({
      ownerUserId: owner.id,
      slug: 'cross-organization-b',
    });
    const roleA = await createRoleWithPermissions({
      organizationId: organizationA.id,
      permissionCodes: ['organization:read', 'organization:manage'],
      name: 'Role A',
    });
    await createRoleWithPermissions({
      organizationId: organizationB.id,
      permissionCodes: ['organization:read'],
      name: 'Role B',
    });

    await createMembership({
      userId: member.id,
      organizationId: organizationA.id,
      roleId: roleA.id,
      status: 'ACTIVE',
    });

    const codesInA = await repository.findPermissionCodesForUserInOrganization(
      member.public_id,
      organizationA.public_id,
    );
    expect(codesInA.sort()).toEqual(['organization:manage', 'organization:read']);

    const codesInB = await repository.findPermissionCodesForUserInOrganization(
      member.public_id,
      organizationB.public_id,
    );
    expect(codesInB).toEqual([]);
  });

  it('returns empty permission set when the organization is soft-deleted', async () => {
    const owner = await createTestUser({ email: 'owner-deleted-organization@example.com' });
    const member = await createTestUser({ email: 'member-deleted-organization@example.com' });
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ['organization:read'],
    });
    await createMembership({
      userId: member.id,
      organizationId: organization.id,
      roleId: role.id,
      status: 'ACTIVE',
    });

    await sql`
      UPDATE tenancy.organizations SET deleted_at = now(), updated_at = now() WHERE id = ${organization.id}
    `;

    const codes = await repository.findPermissionCodesForUserInOrganization(
      member.public_id,
      organization.public_id,
    );
    expect(codes).toEqual([]);
  });

  it('returns empty permission set when the user is soft-deleted', async () => {
    const owner = await createTestUser({ email: 'owner-deleted-user@example.com' });
    const member = await createTestUser({ email: 'member-deleted-user@example.com' });
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ['organization:read'],
    });
    await createMembership({
      userId: member.id,
      organizationId: organization.id,
      roleId: role.id,
      status: 'ACTIVE',
    });

    await sql`
      UPDATE auth.users SET deleted_at = now(), updated_at = now() WHERE id = ${member.id}
    `;

    const codes = await repository.findPermissionCodesForUserInOrganization(
      member.public_id,
      organization.public_id,
    );
    expect(codes).toEqual([]);
  });

  it('returns empty permission set when role tied to membership is soft-deleted', async () => {
    const owner = await createTestUser({ email: 'owner-deleted-role@example.com' });
    const member = await createTestUser({ email: 'member-deleted-role@example.com' });
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ['organization:read'],
    });
    await createMembership({
      userId: member.id,
      organizationId: organization.id,
      roleId: role.id,
      status: 'ACTIVE',
    });

    await sql`
      UPDATE tenancy.roles SET deleted_at = now(), updated_at = now() WHERE id = ${role.id}
    `;

    const codes = await repository.findPermissionCodesForUserInOrganization(
      member.public_id,
      organization.public_id,
    );
    expect(codes).toEqual([]);
  });
});
