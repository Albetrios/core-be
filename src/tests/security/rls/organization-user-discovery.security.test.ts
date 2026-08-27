import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql as drizzleSql, and, eq, isNull } from 'drizzle-orm';
import { sql } from '@/infrastructure/database/connection.js';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  createMembership,
  createRoleWithPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { member_invitations } from '@/domains/tenancy/sub-domains/membership/member-invitation/member-invitation.schema.js';
import { grantCoreBeAppRoleForTests } from '@/tests/helpers/rls-matrix.helper.js';

/**
 * Validates the user-discovery RLS policies and SECURITY DEFINER lookups that
 * unblock cross-organization and user-driven routes under
 * `DATABASE_RLS_SCOPED_CONTEXTS=true` (migration
 * `20260520000004_organization_discovery_and_invitation_lookup_rls.sql`).
 *
 * The fix-under-test is twofold:
 *   1. `organizations_user_discovery` + `memberships_user_self_discovery` PERMISSIVE
 *      policies grant access ONLY when `app.current_user_public_id` matches the row owner
 *      or an active membership. Existing `*_tenant_isolation` policies are unchanged.
 *   2. `tenancy.resolve_member_invitation_lookup_by_public_id` and
 *      `tenancy.list_pending_member_invitations_for_email` SECURITY DEFINER helpers
 *      let the invitation accept route resolve the owning organization
 *      without an active `app.current_organization_public_id` GUC, then wrap the actual write
 *      in `withOrganizationDatabaseContext`.
 *
 * All assertions run under `core_be_app` so RLS is enforced (the test runner role
 * `core` typically inherits BYPASSRLS, which would mask regressions).
 */

async function executeAsCoreBeAppUser<T>(
  userPublicId: string | null,
  callback: (transaction: typeof database) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
    const value = userPublicId ?? '';
    await transaction.execute(
      drizzleSql`SELECT set_config('app.current_user_public_id', ${value}, true)`,
    );
    return callback(transaction as unknown as typeof database);
  });
}

describe('Security: organization user-discovery RLS + invitation SECURITY DEFINER lookups', () => {
  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('owner sees their own organization under app.current_user_public_id (organizations_user_discovery)', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    const rows = await executeAsCoreBeAppUser(owner.public_id, (transaction) =>
      transaction
        .select({ public_id: organizations.public_id })
        .from(organizations)
        .where(eq(organizations.public_id, organization.public_id)),
    );
    expect(rows).toHaveLength(1);
  });

  it('active member sees member organization under app.current_user_public_id', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [],
    });
    await createMembership({
      userId: member.id,
      organizationId: organization.id,
      roleId: role.id,
    });

    const rows = await executeAsCoreBeAppUser(member.public_id, (transaction) =>
      transaction
        .select({ public_id: organizations.public_id })
        .from(organizations)
        .where(eq(organizations.public_id, organization.public_id)),
    );
    expect(rows).toHaveLength(1);
  });

  it('non-member with valid user context cannot see another tenant organization', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    const rows = await executeAsCoreBeAppUser(stranger.public_id, (transaction) =>
      transaction
        .select({ public_id: organizations.public_id })
        .from(organizations)
        .where(eq(organizations.public_id, organization.public_id)),
    );
    expect(rows).toHaveLength(0);
  });

  it('unset user context blocks organization SELECT (tenant-isolation policy still gates)', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    const rows = await executeAsCoreBeAppUser(null, (transaction) =>
      transaction
        .select({ public_id: organizations.public_id })
        .from(organizations)
        .where(eq(organizations.public_id, organization.public_id)),
    );
    expect(rows).toHaveLength(0);
  });

  it('user sees own memberships under app.current_user_public_id (memberships_user_self_discovery)', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [],
    });
    await createMembership({
      userId: member.id,
      organizationId: organization.id,
      roleId: role.id,
    });

    const rows = await executeAsCoreBeAppUser(member.public_id, (transaction) =>
      transaction
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.organization_id, organization.id),
            eq(memberships.user_id, member.id),
            isNull(memberships.deleted_at),
          ),
        ),
    );
    expect(rows).toHaveLength(1);
  });

  it('resolve_member_invitation_lookup_by_public_id returns owning organization without org context', async () => {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [],
    });
    const membership = await createMembership({
      userId: owner.id,
      organizationId: organization.id,
      roleId: role.id,
    });

    /**
     * Seed an invitation via the SECURITY DEFINER-friendly path: we are running as
     * the migrations role (superuser-equivalent in test), which lets the INSERT
     * happen. The lookup must return the membership's owning organization.
     */
    const invitationPublicId = `inv_${Math.random().toString(36).slice(2, 12)}`;
    await database.insert(member_invitations).values({
      public_id: invitationPublicId,
      membership_id: membership.id,
      email: 'invitee@example.com',
      token_hash: 'token-hash-placeholder',
      invited_by_user_id: owner.id,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const rows = await sql<
      Array<{
        organization_public_id: string;
        organization_id: string | number;
        membership_public_id: string;
        membership_id: string | number;
      }>
    >`
      SELECT organization_public_id, organization_id, membership_public_id, membership_id
      FROM tenancy.resolve_member_invitation_lookup_by_public_id(${invitationPublicId})
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organization_public_id).toBe(organization.public_id);
    expect(rows[0]?.membership_public_id).toBe(membership.public_id);
  });

  it('list_pending_member_invitations_for_email returns active invitations across organizations', async () => {
    const ownerA = await createTestUser();
    const ownerB = await createTestUser();
    const organizationA = await createTestOrganization({ ownerUserId: ownerA.id });
    const organizationB = await createTestOrganization({ ownerUserId: ownerB.id });
    const roleA = await createRoleWithPermissions({
      organizationId: organizationA.id,
      permissionCodes: [],
    });
    const roleB = await createRoleWithPermissions({
      organizationId: organizationB.id,
      permissionCodes: [],
    });
    const membershipA = await createMembership({
      userId: ownerA.id,
      organizationId: organizationA.id,
      roleId: roleA.id,
    });
    const membershipB = await createMembership({
      userId: ownerB.id,
      organizationId: organizationB.id,
      roleId: roleB.id,
    });
    const invitationEmail = `invitee-${Math.random().toString(36).slice(2, 8)}@example.com`;

    await database.insert(member_invitations).values([
      {
        public_id: `inv_${Math.random().toString(36).slice(2, 12)}`,
        membership_id: membershipA.id,
        email: invitationEmail,
        token_hash: 'hash-a',
        invited_by_user_id: ownerA.id,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      {
        public_id: `inv_${Math.random().toString(36).slice(2, 12)}`,
        membership_id: membershipB.id,
        email: invitationEmail,
        token_hash: 'hash-b',
        invited_by_user_id: ownerB.id,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      {
        public_id: `inv_${Math.random().toString(36).slice(2, 12)}`,
        membership_id: membershipA.id,
        email: invitationEmail,
        token_hash: 'hash-expired',
        invited_by_user_id: ownerA.id,
        /**
         * Expired invitation must be filtered out by
         * `list_pending_member_invitations_for_email`. `created_at` is
         * pinned earlier than `expires_at` so the `chk_member_inv_expires`
         * check constraint (`expires_at > created_at`) still holds while
         * the row remains past its `expires_at`.
         */
        created_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
        expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    ]);

    const rows = await sql<
      Array<{
        invitation_public_id: string;
        organization_public_id: string;
      }>
    >`
      SELECT invitation_public_id, organization_public_id
      FROM tenancy.list_pending_member_invitations_for_email(${invitationEmail}, 100)
    `;
    expect(rows).toHaveLength(2);
    const orgIds = new Set(rows.map((row) => row.organization_public_id));
    expect(orgIds.has(organizationA.public_id)).toBe(true);
    expect(orgIds.has(organizationB.public_id)).toBe(true);
  });
});
