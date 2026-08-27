import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { BILLING_PERMISSIONS } from '@/domains/billing/billing.permissions.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { role_permissions } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import type { Organization } from '@/domains/tenancy/sub-domains/organization/organization.types.js';
import { resolveVerifiedOrganizationPrincipalScope } from '@/shared/utils/identity/verified-principal-scope.util.js';
import { withPrincipalDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';

/** Name of the auto-provisioned, undeletable owner role created with every organization. */
export const OWNER_ROLE_NAME = 'Owner';

/** Every tenancy permission code — the owner role is granted the full set. */
const ALL_TENANCY_PERMISSION_CODES: readonly string[] = Object.values(TENANCY_PERMISSIONS);

const ALL_BILLING_PERMISSION_CODES: readonly string[] = Object.values(BILLING_PERMISSIONS);

/**
 * Permission codes granted to the auto-provisioned Owner role.
 * TEAM organizations also receive billing read/manage so the creator can use `/billing/*`.
 */
export function ownerPermissionCodesForOrganizationType(
  type: ProvisionOrganizationInput['type'],
): readonly string[] {
  if (type === 'TEAM') {
    return [...ALL_TENANCY_PERMISSION_CODES, ...ALL_BILLING_PERMISSION_CODES];
  }
  return ALL_TENANCY_PERMISSION_CODES;
}

/** A default, immutable non-owner role auto-provisioned into every TEAM organization. */
export interface DefaultTeamRole {
  /** Human-readable role name; unique within the organization. */
  name: string;
  /** Short description surfaced in the roles UI. */
  description: string;
  /** Permission codes granted to the role; every code must exist in `tenancy.permissions`. */
  permissionCodes: readonly string[];
}

/**
 * Non-owner system roles seeded into every TEAM organization at provisioning time, so a freshly
 * created team can assign a role and invite members immediately — without an operator first
 * hand-crafting one.
 *
 * @remarks
 * - Every entry is `is_system: true` (immutable — cannot be edited or deleted via the role API),
 *   matching the Owner role.
 * - **Member** and **Viewer** always include `organization:read` so any assigned member can load
 *   the organization dashboard (the frontend's landing surface gates on `organization:read`).
 * - PERSONAL organizations are single-member and reject custom roles, so they receive only Owner;
 *   these defaults apply to TEAM organizations exclusively.
 * - Every permission code must exist in the seeded `tenancy.permissions` reference table (the grant
 *   insert carries an FK to it).
 */
export const DEFAULT_TEAM_ROLES: readonly DefaultTeamRole[] = [
  {
    name: 'Admin',
    description: 'Manage members and invitations; read organization settings, roles and billing.',
    permissionCodes: [
      TENANCY_PERMISSIONS.ORGANIZATION_READ,
      TENANCY_PERMISSIONS.ORGANIZATION_UPDATE,
      TENANCY_PERMISSIONS.MEMBERSHIP_READ,
      TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE,
      TENANCY_PERMISSIONS.INVITATION_MANAGE,
      TENANCY_PERMISSIONS.ROLE_READ,
      TENANCY_PERMISSIONS.API_KEY_READ,
      BILLING_PERMISSIONS.SUBSCRIPTION_READ,
    ],
  },
  {
    name: 'Member',
    description: 'Read organization data and view members and roles.',
    permissionCodes: [
      TENANCY_PERMISSIONS.ORGANIZATION_READ,
      TENANCY_PERMISSIONS.MEMBERSHIP_READ,
      TENANCY_PERMISSIONS.ROLE_READ,
    ],
  },
  {
    name: 'Viewer',
    description: 'Read-only access to the organization and its members.',
    permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ, TENANCY_PERMISSIONS.MEMBERSHIP_READ],
  },
];

/** Input for {@link provisionOrganizationWithOwner}. */
export interface ProvisionOrganizationInput {
  name: string;
  /** Null for a PERSONAL organization; kebab string for a TEAM. */
  slug: string | null;
  type: 'PERSONAL' | 'TEAM';
  ownerUserId: number;
}

/** Result of {@link provisionOrganizationWithOwner}. */
export interface ProvisionOrganizationResult {
  organization: Organization;
  roleId: number;
  membershipPublicId: string;
}

/**
 * Atomically bootstrap an organization with full owner access: organization row →
 * system `Owner` role → every tenancy permission granted to it (plus billing read/manage
 * for TEAM orgs) → the owner's ACTIVE membership. Without this, a freshly created
 * organization's owner resolves zero permissions (the permission path is a strict
 * role→membership join with no owner shortcut).
 *
 * @remarks
 * - **Algorithm:** pre-generates the org `public_id` and runs every insert inside one
 *   `withPrincipalDatabaseContext(resolveVerifiedOrganizationPrincipalScope(publicId), …)` transaction, so `app.current_organization_public_id`
 *   equals the org being created. The org row then satisfies its tenant-isolation WITH CHECK
 *   (`public_id = app.current_organization_public_id`) and the child rows (roles, role_permissions,
 *   memberships) satisfy theirs (`organization_id` → the just-inserted org) — all under the
 *   non-superuser `core_be_app` role with NO admin escape hatch (the tenancy policies do not honor
 *   `app.global_admin`; only `auth`/`audit` do, which is why the former global-admin path failed
 *   its WITH CHECK with 42501 in deployed environments). One transaction keeps the owner-bootstrap
 *   atomic — a partial failure can never leave an org whose owner has no access. TEAM
 *   organizations additionally insert the default {@link DEFAULT_TEAM_ROLES}
 *   (Admin/Member/Viewer) and their grants so a new team can assign a role and invite members
 *   immediately; PERSONAL organizations get Owner only. This is a server-side bootstrap only;
 *   the inputs are not user-controlled beyond name/slug/type.
 * - **Failure modes:** the whole transaction rolls back on any insert failure (unique slug,
 *   one-personal-per-owner index, missing permission reference rows). Callers map
 *   `unique_violation` to a 409.
 * - **Side effects:** table inserts (organizations, roles, role_permissions, memberships); TEAM
 *   organizations additionally insert the default Admin/Member/Viewer roles and their grants.
 * - **Notes:** the owner and default roles are `is_system: true` so they cannot be deleted via the
 *   role API. Permission reference rows (the `permissions` table) are assumed seeded — they are
 *   reference data present in every environment.
 */
export async function provisionOrganizationWithOwner(
  input: ProvisionOrganizationInput,
): Promise<ProvisionOrganizationResult> {
  return provisionOrganization(input);
}

/** Default display name for an auto-provisioned personal organization. */
export const PERSONAL_ORGANIZATION_NAME = 'Personal';

/**
 * Provision the single PERSONAL organization for a user at signup: a `type=PERSONAL`,
 * slug-less organization owned by the user, with full owner access. The partial unique
 * index guarantees at most one personal organization per owner.
 */
export async function provisionPersonalOrganization(
  ownerUserId: number,
  name: string = PERSONAL_ORGANIZATION_NAME,
): Promise<ProvisionOrganizationResult> {
  return provisionOrganization({
    name,
    slug: null,
    type: 'PERSONAL',
    ownerUserId,
  });
}

async function provisionOrganization(
  input: ProvisionOrganizationInput,
): Promise<ProvisionOrganizationResult> {
  // Pre-generate the org public_id so the entire owner-bootstrap runs INSIDE the new org's own
  // RLS context (`app.current_organization_public_id` = this id): every tenant-isolation WITH CHECK then
  // passes naturally — the org row (`public_id = app.current_organization_public_id`) and its child rows
  // (roles, role_permissions, memberships, all `organization_id`-scoped to the just-inserted org).
  // This replaces `withMaintenanceDatabaseContext`, which was both improper on a self-service
  // login/signup path AND ineffective: the tenancy policies never honor `app.global_admin` (only
  // auth/audit do), so the org INSERT failed its WITH CHECK with SQLSTATE 42501 under the
  // non-superuser `core_be_app` role in deployed environments.
  const organizationPublicId = generatePublicId('organization');
  return withPrincipalDatabaseContext(
    resolveVerifiedOrganizationPrincipalScope(organizationPublicId),
    async (databaseHandle) => {
      const [organization] = await databaseHandle
        .insert(organizations)
        .values({
          public_id: organizationPublicId,
          name: input.name,
          slug: input.slug,
          type: input.type,
          owner_user_id: input.ownerUserId,
          created_by_user_id: input.ownerUserId,
          updated_by_user_id: input.ownerUserId,
        })
        .returning();

      const [role] = await databaseHandle
        .insert(roles)
        .values({
          public_id: generatePublicId('memberRole'),
          organization_id: organization!.id,
          name: OWNER_ROLE_NAME,
          is_system: true,
          created_by_user_id: input.ownerUserId,
        })
        .returning();

      await databaseHandle.insert(role_permissions).values(
        ownerPermissionCodesForOrganizationType(input.type).map((permission_code) => ({
          role_id: role!.id,
          permission_code,
          created_by_user_id: input.ownerUserId,
        })),
      );

      const [membership] = await databaseHandle
        .insert(memberships)
        .values({
          public_id: generatePublicId('membership'),
          user_id: input.ownerUserId,
          organization_id: organization!.id,
          role_id: role!.id,
          status: 'ACTIVE',
          joined_at: new Date(),
        })
        .returning();

      // TEAM organizations also receive the default non-owner system roles (Admin/Member/Viewer)
      // so the team can assign a role and invite members immediately. PERSONAL organizations are
      // single-member and reject custom roles, so they get Owner only.
      if (input.type === 'TEAM') {
        for (const defaultRole of DEFAULT_TEAM_ROLES) {
          const [defaultRoleRow] = await databaseHandle
            .insert(roles)
            .values({
              public_id: generatePublicId('memberRole'),
              organization_id: organization!.id,
              name: defaultRole.name,
              description: defaultRole.description,
              is_system: true,
              created_by_user_id: input.ownerUserId,
            })
            .returning();

          await databaseHandle.insert(role_permissions).values(
            defaultRole.permissionCodes.map((permission_code) => ({
              role_id: defaultRoleRow!.id,
              permission_code,
              created_by_user_id: input.ownerUserId,
            })),
          );
        }
      }

      return {
        organization: organization! as Organization,
        roleId: role!.id,
        membershipPublicId: membership!.public_id,
      };
    },
  );
}
