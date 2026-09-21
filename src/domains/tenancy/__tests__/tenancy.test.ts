import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectAuthenticatedOrganizationMutation,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedAllPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

const ALL_TENANCY_PERMISSIONS = Object.values(TENANCY_PERMISSIONS);

/**
 * Domain e2e for the tenancy surfaces that are *flows* rather than single route contracts —
 * membership listing with search / sort / keyset pagination, leaving an organization, and the role
 * and role-permission surface.
 *
 * The flat organization routes (`/organizations`, `/organization`, `/organizations/by-slug/:slug`,
 * `/permissions`) deliberately live in `tenancy.integration.test.ts` instead. Both files previously
 * carried the same 12 cases against the same real app and database — identical assertions, twice the
 * DB-bound runtime, and two places to edit when a contract changed. The split is now by role:
 * **integration owns route contracts, this file owns multi-step behaviour.** The integration suite
 * additionally carries the two cases this one never had (slug reclaim after soft-delete, and the
 * permission catalog's 304 revalidation), so nothing was lost in the trim.
 */
describe('Tenancy Domain — flows (memberships, leave, roles)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    // Full catalog, not the tenancy subset: POST /tenancy/organizations
    // provisions a TEAM owner role that also grants billing codes.
    await seedAllPermissions();
  });

  // ─── Helper: create user with full organization permissions ────────────
  async function createAuthorizedUserAndOrganization(permissionCodes = ALL_TENANCY_PERMISSIONS) {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes,
    });
    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    // Flat tenancy routes resolve the organization from the JWT `org` claim, so
    // the bearer must embed `organizationPublicId` to reach the organization-scoped
    // permission preHandlers and controllers.
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, organization, role, token };
  }

  // ─── Memberships ──────────────────────────────────────────────

  describe('GET /api/v1/tenancy/organization/memberships', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        url: testApiPath('/tenancy/organization/memberships'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return 403 without membership read permission', async () => {
      const { organization } = await createAuthorizedUserAndOrganization();
      const user = await createTestUser({ email: 'noperm2@test.com' });
      const token = await generateTestToken({
        userId: user.public_id,
        organizationPublicId: organization.public_id,
      });
      const response = await injectAuthenticated(app, {
        url: testApiPath('/tenancy/organization/memberships'),
        token,
      });
      expect(response.statusCode).toBe(403);
    });

    it('should return memberships with embedded user + role summaries (REQ-2)', async () => {
      const { token } = await createAuthorizedUserAndOrganization();
      const response = await injectAuthenticated(app, {
        url: testApiPath('/tenancy/organization/memberships'),
        token,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data?: Array<{
          status: string;
          user_id: string;
          role_id: string;
          user?: {
            id: string;
            email: string;
            first_name: string | null;
            last_name: string | null;
            avatar_url: string | null;
          };
          role?: { id: string; name: string };
          invitation?: unknown;
        }>;
      };
      expect(Array.isArray(body.data) && body.data!.length > 0).toBe(true);
      const owner = body.data![0]!;
      // Embedded user summary lets the FE render a members table without an N+1 per-row fetch.
      expect(owner.user).toBeDefined();
      expect(typeof owner.user!.id).toBe('string');
      expect(typeof owner.user!.email).toBe('string');
      expect(owner.user!.id).toBe(owner.user_id); // flat id mirrors the embedded public id
      expect(owner.user).toHaveProperty('avatar_url');
      // Embedded role summary (id + name).
      expect(owner.role).toBeDefined();
      expect(owner.role!.id).toBe(owner.role_id);
      expect(typeof owner.role!.name).toBe('string');
      // The owner membership is ACTIVE → no live invitation embedded.
      expect(owner.status).toBe('ACTIVE');
      expect(owner.invitation).toBeNull();
    });

    it('filters members by the `q` search term (email / name)', async () => {
      const { organization, role, token } = await createAuthorizedUserAndOrganization();
      const searchable = await createTestUser({
        email: 'searchable.member@example.com',
        firstName: 'Searchable',
        lastName: 'Member',
      });
      await createMembership({
        userId: searchable.id,
        organizationId: organization.id,
        roleId: role.id,
      });

      const response = await injectAuthenticated(app, {
        url: testApiPath('/tenancy/organization/memberships?q=searchable.member'),
        token,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data?: Array<{ user?: { email: string } }> };
      expect(body.data).toHaveLength(1);
      expect(body.data![0]!.user!.email).toBe('searchable.member@example.com');

      // A term that matches nobody returns an empty page.
      const empty = await injectAuthenticated(app, {
        url: testApiPath('/tenancy/organization/memberships?q=nobodyhere'),
        token,
      });
      expect(empty.statusCode).toBe(200);
      expect((empty.json() as { data?: unknown[] }).data).toHaveLength(0);
    });

    it('accepts sort/order and genuinely orders members by name asc and desc', async () => {
      const { organization, role, token } = await createAuthorizedUserAndOrganization();
      // Owner already exists (ACTIVE). Add two members with names that bracket a typical owner name.
      const alice = await createTestUser({
        email: 'aaa.sortmember@example.com',
        firstName: 'Aaron',
        lastName: 'Aardvark',
      });
      await createMembership({
        userId: alice.id,
        organizationId: organization.id,
        roleId: role.id,
      });
      const zoe = await createTestUser({
        email: 'zzz.sortmember@example.com',
        firstName: 'Zelda',
        lastName: 'Zephyr',
      });
      await createMembership({ userId: zoe.id, organizationId: organization.id, roleId: role.id });

      const nameOf = (row: { user?: { first_name: string | null; last_name: string | null } }) =>
        `${row.user?.first_name ?? ''} ${row.user?.last_name ?? ''}`.trim().toLowerCase();

      const asc = await injectAuthenticated(app, {
        url: testApiPath('/tenancy/organization/memberships?sort=name&order=asc'),
        token,
      });
      expect(asc.statusCode).toBe(200);
      const ascNames = (
        asc.json() as {
          data: Array<{ user?: { first_name: string | null; last_name: string | null } }>;
        }
      ).data.map(nameOf);
      expect(ascNames).toEqual([...ascNames].sort());
      expect(ascNames[0]).toBe('aaron aardvark');

      const desc = await injectAuthenticated(app, {
        url: testApiPath('/tenancy/organization/memberships?sort=name&order=desc'),
        token,
      });
      expect(desc.statusCode).toBe(200);
      const descNames = (
        desc.json() as {
          data: Array<{ user?: { first_name: string | null; last_name: string | null } }>;
        }
      ).data.map(nameOf);
      // Descending is the reverse of ascending — proves the param is honored, not accept-and-ignored.
      expect(descNames).toEqual([...ascNames].reverse());
    });

    it('keyset-paginates the name sort across pages and resets on a filter change', async () => {
      const { organization, role, token } = await createAuthorizedUserAndOrganization();
      for (const [first, last] of [
        ['Bella', 'Bright'],
        ['Cara', 'Clark'],
        ['Dana', 'Dixon'],
      ] as const) {
        const member = await createTestUser({
          email: `${first}.${last}.page@example.com`.toLowerCase(),
          firstName: first,
          lastName: last,
        });
        await createMembership({
          userId: member.id,
          organizationId: organization.id,
          roleId: role.id,
        });
      }

      const firstPage = await injectAuthenticated(app, {
        url: testApiPath('/tenancy/organization/memberships?sort=name&order=asc&limit=2'),
        token,
      });
      expect(firstPage.statusCode).toBe(200);
      const firstPageBody = firstPage.json() as {
        data: Array<{ id: string }>;
        meta: { pagination: { next?: string | null } };
      };
      expect(firstPageBody.data).toHaveLength(2);
      const cursor = firstPageBody.meta.pagination.next;
      expect(typeof cursor).toBe('string');

      const nextPage = await injectAuthenticated(app, {
        url: testApiPath(
          `/tenancy/organization/memberships?sort=name&order=asc&limit=2&after=${encodeURIComponent(cursor!)}`,
        ),
        token,
      });
      expect(nextPage.statusCode).toBe(200);
      const nextPageBody = nextPage.json() as { data: Array<{ id: string }> };
      // No overlap between pages — the keyset advanced past the boundary row.
      const firstPageIds = new Set(firstPageBody.data.map((row) => row.id));
      for (const row of nextPageBody.data) expect(firstPageIds.has(row.id)).toBe(false);

      // Reusing a name-asc cursor under order=desc must reset to the first page (fingerprint guard),
      // not 400 and not interleave.
      const reset = await injectAuthenticated(app, {
        url: testApiPath(
          `/tenancy/organization/memberships?sort=name&order=desc&limit=2&after=${encodeURIComponent(cursor!)}`,
        ),
        token,
      });
      expect(reset.statusCode).toBe(200);
      const resetIds = (reset.json() as { data: Array<{ id: string }> }).data.map((row) => row.id);
      expect(resetIds.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/v1/tenancy/organization/leave', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/leave'),
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ─── Add member (invite by email) ─────────────────────────────
  // REQ-1: the standalone POST/GET /organization/invitations and the invitee
  // pending-list / decline routes were removed. Adding a member now issues the
  // invitation via POST /organization/memberships (validation guard kept here;
  // the full add-member flow is covered in membership.integration.test.ts).

  describe('POST /api/v1/tenancy/organization/memberships', () => {
    it('should return 400 for missing body', async () => {
      const { token } = await createAuthorizedUserAndOrganization();
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/memberships'),
        token,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ─── Roles ────────────────────────────────────────────────────

  describe('GET /api/v1/tenancy/organization/roles', () => {
    it('should return 403 without role read permission', async () => {
      const { organization } = await createAuthorizedUserAndOrganization();
      const user = await createTestUser({ email: 'noperm4@test.com' });
      const token = await generateTestToken({
        userId: user.public_id,
        organizationPublicId: organization.public_id,
      });
      const response = await injectAuthenticated(app, {
        url: testApiPath('/tenancy/organization/roles'),
        token,
      });
      expect(response.statusCode).toBe(403);
    });

    it('should return roles with permission', async () => {
      const { token } = await createAuthorizedUserAndOrganization();
      const response = await injectAuthenticated(app, {
        url: testApiPath('/tenancy/organization/roles'),
        token,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data?: unknown };
      expect(body.data).toBeDefined();
    });
  });

  describe('POST /api/v1/tenancy/organization/roles', () => {
    it('should return 403 without role manage permission', async () => {
      const { organization } = await createAuthorizedUserAndOrganization([
        TENANCY_PERMISSIONS.ROLE_READ,
      ]);
      const user = await createTestUser({ email: 'roleread@test.com' });
      const readRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.ROLE_READ],
      });
      await createMembership({
        userId: user.id,
        organizationId: organization.id,
        roleId: readRole.id,
      });
      const token = await generateTestToken({
        userId: user.public_id,
        organizationPublicId: organization.public_id,
      });
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/roles'),
        token,
        payload: { name: 'New Role' },
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
      });
      expect(response.statusCode).toBe(403);
    });

    it('should create role with manage permission', async () => {
      const { token } = await createAuthorizedUserAndOrganization();
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/roles'),
        token,
        payload: { name: 'New Role', description: 'A test role' },
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: { name: string } };
      expect(body.data.name).toBe('New Role');
    });
  });

  // ─── Role Permissions ─────────────────────────────────────────

  describe('GET /api/v1/tenancy/organization/roles/:role_id/permissions', () => {
    it('should return role permissions', async () => {
      const { role, token } = await createAuthorizedUserAndOrganization();
      const response = await injectAuthenticated(app, {
        url: testApiPath(`/tenancy/organization/roles/${role.public_id}/permissions`),
        token,
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('PUT /api/v1/tenancy/organization/roles/:role_id/permissions', () => {
    it('should replace role permissions', async () => {
      const { organization, token } = await createAuthorizedUserAndOrganization();
      const targetRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.ROLE_READ],
      });
      const response = await injectAuthenticated(app, {
        method: 'PUT',
        url: testApiPath(`/tenancy/organization/roles/${targetRole.public_id}/permissions`),
        token,
        payload: { permission_codes: [TENANCY_PERMISSIONS.ORGANIZATION_READ] },
      });
      expect(response.statusCode).toBe(200);
    });
  });
});
