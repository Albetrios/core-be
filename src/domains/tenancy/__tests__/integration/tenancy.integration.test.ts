import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
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

const ALL_TENANCY_PERMISSIONS = Object.values(TENANCY_PERMISSIONS);

describe('Tenancy Domain — Integration', () => {
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
    // Flat tenancy routes resolve the organization from the JWT `org` claim.
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, organization, role, token };
  }

  // ─── Organizations ────────────────────────────────────────────

  describe('GET /api/v1/users/me/organizations', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'GET',
        url: testApiPath('/users/me/organizations'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return organizations for authenticated user', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/users/me/organizations'),
        token: token,
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { data: Record<string, unknown> }).data).toBeDefined();
    });
  });

  describe('POST /api/v1/tenancy/organizations', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organizations'),
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });

    it('should create organization for authenticated user', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organizations'),
        token: token,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { name: 'Test Org', slug: 'test-org' },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { data: Record<string, unknown> }).data).toBeDefined();
      expect((response.json() as { data: Record<string, unknown> }).data.name).toBe('Test Org');
    });

    it('R9: reclaims a team slug after the owning organization is soft-deleted', async () => {
      // Regression for the full-vs-partial slug unique index. Before the fix, a soft-deleted team
      // kept its slug indexed, so re-creating the same slug hit the tombstone and returned 409 for a
      // slug no visible organization owned. With the partial index (WHERE deleted_at IS NULL) the slug frees
      // immediately on soft-delete.
      const user = await createTestUser();
      const userToken = await generateTestToken({ userId: user.public_id });

      const createResponse = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organizations'),
        token: userToken,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { name: 'Reclaim Co', slug: 'reclaim-me' },
      });
      expect(createResponse.statusCode).toBe(200);
      const createdId = (createResponse.json() as { data: { id: string } }).data.id;

      // The creator is bootstrapped as owner with full permissions — soft-delete the organization.
      const ownerOrgToken = await generateTestToken({
        userId: user.public_id,
        organizationPublicId: createdId,
      });
      const deleteResponse = await injectAuthenticatedOrganizationMutation(app, {
        method: 'DELETE',
        url: testApiPath('/tenancy/organization'),
        token: ownerOrgToken,
      });
      expect(deleteResponse.statusCode).toBe(204);

      // The same slug must be reusable now (was 409 before the partial index).
      const recreateResponse = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organizations'),
        token: userToken,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { name: 'Reclaim Co 2', slug: 'reclaim-me' },
      });
      expect(recreateResponse.statusCode).toBe(200);
    });

    it('R9: still rejects a slug already held by a LIVE organization (constraint not over-loosened)', async () => {
      const user = await createTestUser();
      const userToken = await generateTestToken({ userId: user.public_id });
      const payload = (name: string) => ({
        method: 'POST' as const,
        url: testApiPath('/tenancy/organizations'),
        token: userToken,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { name, slug: 'taken-slug' },
      });

      const first = await injectAuthenticated(app, payload('First Co'));
      expect(first.statusCode).toBe(200);

      const second = await injectAuthenticated(app, payload('Second Co'));
      expect(second.statusCode).toBe(409);
    });
  });

  describe('GET /api/v1/tenancy/organization', () => {
    it('should return the active organization from the token claim', async () => {
      const user = await createTestUser();
      const organization = await createTestOrganization({ ownerUserId: user.id });
      const token = await generateTestToken({
        userId: user.public_id,
        organizationPublicId: organization.public_id,
      });
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization'),
        token: token,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: { id: string } };
      expect(body.data).toBeDefined();
      expect(body.data.id).toBe(organization.public_id);
    });

    it('should return 403 when the token carries no organization claim', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization'),
        token: token,
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('PATCH /api/v1/tenancy/organization', () => {
    it('should return 403 without update permission', async () => {
      const authorized = await createAuthorizedUserAndOrganization([
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
      ]);
      const otherUser = await createTestUser({ email: 'other@test.com' });
      const { organization } = authorized;
      const readRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
      });
      await createMembership({
        userId: otherUser.id,
        organizationId: organization.id,
        roleId: readRole.id,
      });
      const otherToken = await generateTestToken({
        userId: otherUser.public_id,
        organizationPublicId: organization.public_id,
      });

      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath('/tenancy/organization'),
        token: otherToken,
        payload: { name: 'Updated' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('should update organization with update permission', async () => {
      const { token } = await createAuthorizedUserAndOrganization();
      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath('/tenancy/organization'),
        token: token,
        payload: { name: 'Updated Org' },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('DELETE /api/v1/tenancy/organization', () => {
    it('should return 403 without delete permission', async () => {
      const { organization } = await createAuthorizedUserAndOrganization();
      const otherUser = await createTestUser({ email: 'other2@test.com' });
      const readRole = await createRoleWithPermissions({
        organizationId: organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
      });
      await createMembership({
        userId: otherUser.id,
        organizationId: organization.id,
        roleId: readRole.id,
      });
      const otherToken = await generateTestToken({
        userId: otherUser.public_id,
        organizationPublicId: organization.public_id,
      });
      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath('/tenancy/organization'),
        token: otherToken,
      });
      expect(response.statusCode).toBe(403);
    });

    it('should soft-delete organization and hide it from subsequent reads', async () => {
      const { token } = await createAuthorizedUserAndOrganization();
      const deleteResponse = await injectAuthenticatedOrganizationMutation(app, {
        method: 'DELETE',
        url: testApiPath('/tenancy/organization'),
        token: token,
      });
      expect(deleteResponse.statusCode).toBe(204);

      const getResponse = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization'),
        token: token,
      });
      expect(getResponse.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/tenancy/organizations/by-slug/:slug', () => {
    it('should return organization by slug', async () => {
      const user = await createTestUser();
      await createTestOrganization({
        ownerUserId: user.id,
        slug: 'my-org',
      });
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organizations/by-slug/my-org'),
        token: token,
      });
      expect(response.statusCode).toBe(200);
    });
  });

  // ─── Permissions (authenticated catalog) ────────────────────

  describe('GET /api/v1/tenancy/permissions', () => {
    it('should list all permissions', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/permissions'),
        token,
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { data: Record<string, unknown> }).data).toBeDefined();
    });

    it('returns cache headers and 304 on repeat fetch with If-None-Match', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const firstResponse = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/permissions'),
        token,
      });
      expect(firstResponse.statusCode).toBe(200);
      const etag = firstResponse.headers.etag;
      expect(etag).toBeDefined();
      expect(firstResponse.headers['cache-control']).toContain('max-age=300');

      const secondResponse = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/permissions'),
        token,
        headers: { 'if-none-match': String(etag) },
      });
      expect(secondResponse.statusCode).toBe(304);
      expect(secondResponse.body).toBe('');
    });
  });
});
