/**
 * Tenancy domain seed — organizations, roles, memberships, role_permissions, invitations.
 * Domain-owned; used by scripts/seed orchestration. Data is passed in (no faker here).
 */
import { sql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { role_permissions } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.schema.js';
import { member_invitations } from '@/domains/tenancy/sub-domains/membership/member-invitation/member-invitation.schema.js';

/** Input for {@link seedOrganization}; `owner_user_id` is the internal id of the future organization owner. */
export interface SeedOrganizationPayload {
  name: string;
  slug: string;
  owner_user_id: number;
}

/**
 * Inserts an `ACTIVE` organization with a freshly generated public id and
 * returns the created row (or `null` if the insert returned no row). Used by
 * `src/scripts/seed/{minimal,full}.ts` to bootstrap demo tenants.
 * Idempotent: re-running updates `name` on slug conflict.
 */
export async function seedOrganization(payload: SeedOrganizationPayload) {
  const [row] = await getRequestDatabase()
    .insert(organizations)
    .values({
      public_id: generatePublicId('organization'),
      name: payload.name,
      slug: payload.slug,
      owner_user_id: payload.owner_user_id,
      status: 'ACTIVE',
      created_by_user_id: payload.owner_user_id,
    })
    .onConflictDoUpdate({
      // `idx_organizations_slug` is a PARTIAL unique index (WHERE deleted_at IS NULL),
      // so the arbiter predicate must be supplied or Postgres raises 42P10
      // ("no unique or exclusion constraint matching the ON CONFLICT specification").
      target: organizations.slug,
      targetWhere: sql`${organizations.deleted_at} is null`,
      set: { name: payload.name },
    })
    .returning();
  return row ?? null;
}

/** Input for {@link seedRole}; `is_system` defaults to `false` (custom organization role). */
export interface SeedRolePayload {
  organization_id: number;
  name: string;
  is_system?: boolean;
  created_by_user_id: number;
}

/**
 * Inserts a tenancy role under the given organization with a generated public
 * id and returns the created row. `is_system` distinguishes immutable seeded
 * roles (Admin, Member) from user-created roles.
 * Idempotent: re-running updates `is_system` on (organization_id, name) conflict.
 */
export async function seedRole(payload: SeedRolePayload) {
  const [row] = await getRequestDatabase()
    .insert(roles)
    .values({
      public_id: generatePublicId('memberRole'),
      organization_id: payload.organization_id,
      name: payload.name,
      is_system: payload.is_system ?? false,
      created_by_user_id: payload.created_by_user_id,
    })
    .onConflictDoUpdate({
      target: [roles.organization_id, roles.name],
      targetWhere: sql`${roles.deleted_at} IS NULL`,
      set: { is_system: payload.is_system ?? false },
    })
    .returning();
  return row ?? null;
}

/** Input for {@link seedMembership}; `status` defaults to `'ACTIVE'`, `invited_by_user_id` is optional. */
export interface SeedMembershipPayload {
  user_id: number;
  organization_id: number;
  role_id: number;
  status?: string;
  created_by_user_id: number;
  joined_at?: Date | null;
  invited_by_user_id?: number;
}

/**
 * Inserts a membership row joining a seeded user to an organization with a
 * given role. When status is `INVITED` `joined_at` is left null; otherwise it
 * defaults to `now()` so demo flows can immediately resolve permissions.
 * `invited_by_user_id` is recorded when provided (e.g. seeded invitations).
 * Idempotent: re-running updates `role_id` and `status` on (user_id, organization_id) conflict.
 */
export async function seedMembership(payload: SeedMembershipPayload) {
  const status = payload.status ?? 'ACTIVE';
  const [row] = await getRequestDatabase()
    .insert(memberships)
    .values({
      public_id: generatePublicId('membership'),
      user_id: payload.user_id,
      organization_id: payload.organization_id,
      role_id: payload.role_id,
      status,
      joined_at: payload.joined_at ?? (status === 'INVITED' ? null : new Date()),
      created_by_user_id: payload.created_by_user_id,
      invited_by_user_id: payload.invited_by_user_id ?? null,
    })
    .onConflictDoUpdate({
      target: [memberships.user_id, memberships.organization_id],
      targetWhere: sql`${memberships.deleted_at} IS NULL`,
      set: { role_id: payload.role_id, status },
    })
    .returning();
  return row ?? null;
}

/**
 * Bulk-inserts (`role_id`, `permission_code`) join rows attaching the given
 * permission codes to a role. Uses `ON CONFLICT DO NOTHING` so it is safe to
 * re-run against an already-seeded database.
 */
export async function seedRolePermissions(
  roleId: number,
  permissionCodes: string[],
  createdByUserId: number,
) {
  return getRequestDatabase()
    .insert(role_permissions)
    .values(
      permissionCodes.map((permission_code) => ({
        role_id: roleId,
        permission_code,
        created_by_user_id: createdByUserId,
      })),
    )
    .onConflictDoNothing()
    .returning();
}

/**
 * Input for {@link seedMemberInvitation}; `token_hash` is the SHA-256 of the raw invitation token.
 * `created_at` is optional and only set by seeders that need a back-dated (e.g. expired) invitation.
 */
export interface SeedMemberInvitationPayload {
  membership_id: number;
  email: string;
  token_hash: string;
  invited_by_user_id: number;
  expires_at: Date;
  created_by_user_id: number;
  created_at?: Date;
}

/**
 * Inserts a pending member-invitation row tied to an existing membership in
 * `INVITED` status. Used by demo flows to materialise an outstanding
 * acceptance link without going through the full invitation service. When
 * `created_at` is supplied it is back-dated explicitly (so an expired invitation
 * still satisfies the `expires_at > created_at` check); otherwise it defaults to now().
 */
export async function seedMemberInvitation(payload: SeedMemberInvitationPayload) {
  const [row] = await getRequestDatabase()
    .insert(member_invitations)
    .values({
      public_id: generatePublicId('memberInvitation'),
      membership_id: payload.membership_id,
      email: payload.email,
      token_hash: payload.token_hash,
      invited_by_user_id: payload.invited_by_user_id,
      expires_at: payload.expires_at,
      created_by_user_id: payload.created_by_user_id,
      ...(payload.created_at ? { created_at: payload.created_at } : {}),
    })
    .returning();
  return row ?? null;
}
