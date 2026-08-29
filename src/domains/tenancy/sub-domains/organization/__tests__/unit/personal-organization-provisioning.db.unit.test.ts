import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { sql } from '@/infrastructure/database/connection.js';
import { seedPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { env } from '@/shared/config/env.config.js';
import { provisionPersonalOrganization } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import {
  resolveDefaultActiveOrganizationPublicId,
  findUserActiveOrganizationPublicId,
  resolvePersonalOrganizationPublicId,
  ensurePersonalOrganization,
  ensurePersonalOrganizationPublicId,
} from '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js';

describe('personal organization provisioning (database)', () => {
  beforeEach(async () => {
    await cleanupDatabase();
    // The owner role is granted every tenancy permission; the codes must exist as reference rows.
    await seedPermissions(Object.values(TENANCY_PERMISSIONS));
  });

  it('provisions a PERSONAL organization with a null slug owned by the user', async () => {
    const user = await createTestUser();

    const result = await provisionPersonalOrganization(user.id);

    expect(result.organization.type).toBe('PERSONAL');
    expect(result.organization.slug).toBeNull();
    expect(result.organization.owner_user_id).toBe(user.id);
    expect(result.organization.public_id).toMatch(/^org_[a-z0-9]{21}$/);
    expect(result.membershipPublicId).toMatch(/^mem_[a-z0-9]{21}$/);
  });

  it('enforces at most one personal organization per owner', async () => {
    const user = await createTestUser();
    await provisionPersonalOrganization(user.id);

    // The idx_org_one_personal_per_owner partial unique index rejects a second one.
    await expect(provisionPersonalOrganization(user.id)).rejects.toThrow();
  });

  it('provisions independent personal organizations for different users', async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();

    const a = await provisionPersonalOrganization(userA.id);
    const b = await provisionPersonalOrganization(userB.id);

    expect(a.organization.public_id).not.toBe(b.organization.public_id);
    expect(a.organization.owner_user_id).toBe(userA.id);
    expect(b.organization.owner_user_id).toBe(userB.id);
  });

  describe('resolveDefaultActiveOrganizationPublicId (login selection)', () => {
    it('returns the personal organization for a freshly provisioned user', async () => {
      const user = await createTestUser();
      const { organization } = await provisionPersonalOrganization(user.id);

      const resolved = await resolveDefaultActiveOrganizationPublicId(user.id);

      expect(resolved).toBe(organization.public_id);
    });

    it('returns undefined when the user belongs to no organization', async () => {
      const user = await createTestUser();

      const resolved = await resolveDefaultActiveOrganizationPublicId(user.id);

      expect(resolved).toBeUndefined();
    });
  });

  describe('switch-target resolvers', () => {
    it('resolvePersonalOrganizationPublicId returns the user personal org', async () => {
      const user = await createTestUser();
      const { organization } = await provisionPersonalOrganization(user.id);

      expect(await resolvePersonalOrganizationPublicId(user.id)).toBe(organization.public_id);
    });

    it('resolvePersonalOrganizationPublicId returns undefined without a personal org', async () => {
      const user = await createTestUser();
      expect(await resolvePersonalOrganizationPublicId(user.id)).toBeUndefined();
    });

    it('findUserActiveOrganizationPublicId confirms the owner active membership', async () => {
      const user = await createTestUser();
      const { organization } = await provisionPersonalOrganization(user.id);

      expect(await findUserActiveOrganizationPublicId(user.id, organization.public_id)).toBe(
        organization.public_id,
      );
    });

    it('findUserActiveOrganizationPublicId rejects a non-member organization', async () => {
      const member = await createTestUser();
      const stranger = await createTestUser();
      const { organization } = await provisionPersonalOrganization(member.id);

      // The stranger has no membership in the member's personal organization → undefined (→ 403).
      expect(
        await findUserActiveOrganizationPublicId(stranger.id, organization.public_id),
      ).toBeUndefined();
    });
  });

  describe('ensurePersonalOrganization (self-heal on read)', () => {
    const originalPersonalEnabled = env.PERSONAL_ORGANIZATION_ENABLED;

    afterEach(() => {
      env.PERSONAL_ORGANIZATION_ENABLED = originalPersonalEnabled;
    });

    it('provisions a personal organization on demand when missing and personal is enabled', async () => {
      env.PERSONAL_ORGANIZATION_ENABLED = true;
      const user = await createTestUser();

      // Precondition: no personal organization (signup-time provision failed/was skipped).
      expect(await resolvePersonalOrganizationPublicId(user.id)).toBeUndefined();

      const ensured = await ensurePersonalOrganization(user.id);

      expect(ensured).toBeDefined();
      expect(ensured!.public_id).toMatch(/^org_[a-z0-9]{21}$/);
      // Now resolvable by the normal read path (an existing stuck user is fixed).
      expect(await resolvePersonalOrganizationPublicId(user.id)).toBe(ensured!.public_id);
    });

    it('returns the existing personal organization without creating a second one', async () => {
      env.PERSONAL_ORGANIZATION_ENABLED = true;
      const user = await createTestUser();
      const { organization } = await provisionPersonalOrganization(user.id);

      const ensured = await ensurePersonalOrganization(user.id);

      expect(ensured!.public_id).toBe(organization.public_id);
    });

    it('is idempotent — calling twice does not create duplicates', async () => {
      env.PERSONAL_ORGANIZATION_ENABLED = true;
      const user = await createTestUser();

      const first = await ensurePersonalOrganization(user.id);
      const second = await ensurePersonalOrganization(user.id);

      expect(first!.public_id).toBe(second!.public_id);
    });

    it('does NOT provision when personal organizations are disabled (team-only)', async () => {
      env.PERSONAL_ORGANIZATION_ENABLED = false;
      const user = await createTestUser();

      expect(await ensurePersonalOrganization(user.id)).toBeUndefined();
      // No organization created — switch-to-personal legitimately stays a 404.
      expect(await resolvePersonalOrganizationPublicId(user.id)).toBeUndefined();
    });

    it('ensurePersonalOrganizationPublicId returns the id (enabled) / undefined (disabled)', async () => {
      env.PERSONAL_ORGANIZATION_ENABLED = true;
      const enabledUser = await createTestUser();
      const id = await ensurePersonalOrganizationPublicId(enabledUser.id);
      expect(id).toMatch(/^org_[a-z0-9]{21}$/);

      env.PERSONAL_ORGANIZATION_ENABLED = false;
      const disabledUser = await createTestUser();
      expect(await ensurePersonalOrganizationPublicId(disabledUser.id)).toBeUndefined();
    });
  });

  // Regression for the #865 post-merge failure: on the "auth + user" e2e shard the
  // tenancy.permissions reference catalog is empty, so the self-heal provision fails the
  // role_permissions → permissions FK (23503). The READ path (getMe) must degrade gracefully
  // to a 200 rather than 500; the EXPLICIT path (switch-to-personal) must still surface it.
  describe('self-heal degradation when the permission catalog is absent', () => {
    const originalPersonalEnabled = env.PERSONAL_ORGANIZATION_ENABLED;

    beforeEach(async () => {
      // Force the CI condition: empty the reference catalog that cleanupDatabase exempts.
      await sql`DELETE FROM tenancy.role_permissions`;
      await sql`DELETE FROM tenancy.permissions`;
    });

    afterEach(async () => {
      env.PERSONAL_ORGANIZATION_ENABLED = originalPersonalEnabled;
      // Restore the catalog so sibling suites relying on it are unaffected.
      await seedPermissions(Object.values(TENANCY_PERMISSIONS));
    });

    it('READ path (ensurePersonalOrganizationPublicId) degrades to undefined, never throws', async () => {
      env.PERSONAL_ORGANIZATION_ENABLED = true;
      const user = await createTestUser();

      // provisioning FK-fails, but the read-safe variant swallows it → undefined (→ null id).
      await expect(ensurePersonalOrganizationPublicId(user.id)).resolves.toBeUndefined();
      // No personal organization was created (the provision genuinely failed).
      expect(await resolvePersonalOrganizationPublicId(user.id)).toBeUndefined();
    });

    it('EXPLICIT path (ensurePersonalOrganization) still throws so switch-to-personal surfaces it', async () => {
      env.PERSONAL_ORGANIZATION_ENABLED = true;
      const user = await createTestUser();

      await expect(ensurePersonalOrganization(user.id)).rejects.toThrow();
    });
  });
});
