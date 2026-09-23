import { database } from '@/infrastructure/database/connection.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { permissions } from '@/domains/tenancy/sub-domains/permission/permission.schema.js';
import { SYSTEM_PERMISSIONS } from '@/domains/tenancy/sub-domains/permission/seed/permission.reference.seed.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { role_permissions } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * Seed the default permission set into the permissions table.
 * Uses ON CONFLICT DO NOTHING so it is idempotent.
 */
export async function seedPermissions(codes: string[]): Promise<void> {
  if (codes.length === 0) return;

  const values = codes.map((code) => ({
    code,
    name: code.replace(':', ' ').replace(/-/g, ' '),
    category: code.split(':')[0] ?? 'general',
  }));

  await getOperatorDatabase()
    .insert(permissions)
    .values(values)
    .onConflictDoNothing({ target: permissions.code });
}

/**
 * Seed the complete system permission catalog (every domain) into the
 * permissions table.
 *
 * Use this in any suite that provisions organizations through the real
 * service path: TEAM provisioning grants billing codes on top of the tenancy
 * set (see ownerPermissionCodesForOrganizationType), so seeding only a
 * per-domain subset violates the role_permissions → permissions FK and makes
 * provisioning fail with a 500.
 */
export async function seedAllPermissions(): Promise<void> {
  await seedPermissions(SYSTEM_PERMISSIONS.map((permission) => permission.code));
}

export interface CreateRoleWithPermissionsOptions {
  organizationId: number;
  name?: string;
  permissionCodes: string[];
  createdByUserId?: number;
}

/**
 * Create a role and assign permission codes to it in a single operation.
 */
export async function createRoleWithPermissions(options: CreateRoleWithPermissionsOptions) {
  const publicId = generatePublicId('memberRole');

  const [role] = await getOperatorDatabase()
    .insert(roles)
    .values({
      public_id: publicId,
      organization_id: options.organizationId,
      name: options.name ?? `Test Role ${publicId}`,
      is_system: false,
      created_by_user_id: options.createdByUserId,
    })
    .returning();

  if (options.permissionCodes.length > 0) {
    await getOperatorDatabase()
      .insert(role_permissions)
      .values(
        options.permissionCodes.map((permissionCode) => ({
          role_id: role!.id,
          permission_code: permissionCode,
          created_by_user_id: options.createdByUserId,
        })),
      );
  }

  return role!;
}

export interface CreateMembershipOptions {
  userId: number;
  organizationId: number;
  roleId: number;
  status?: string;
}

/**
 * Create a membership linking a user to an organization with a specific role.
 */
export async function createMembership(options: CreateMembershipOptions) {
  const publicId = generatePublicId('memberRole');

  const [membership] = await getOperatorDatabase()
    .insert(memberships)
    .values({
      public_id: publicId,
      user_id: options.userId,
      organization_id: options.organizationId,
      role_id: options.roleId,
      status: options.status ?? 'ACTIVE',
      joined_at: new Date(),
    })
    .returning();

  return membership!;
}
