import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import type { FastifyInstance } from 'fastify';

const TENANCY_PERMISSION_CODES = Object.values(TENANCY_PERMISSIONS);

describe('Tenancy Organization Settings Sub-Domain — Integration', () => {
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
    await seedPermissions(TENANCY_PERMISSION_CODES);
  });

  async function createAuthorizedOrganizationContext(permissionCodes: string[]) {
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

  const ORGANIZATION_SETTINGS_PATH = '/api/v1/tenancy/organization/settings';

  describe('GET /api/v1/tenancy/organization/settings', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        url: ORGANIZATION_SETTINGS_PATH,
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return 403 without organization read permission', async () => {
      const { token } = await createAuthorizedOrganizationContext([
        TENANCY_PERMISSIONS.ORGANIZATION_UPDATE,
      ]);

      const response = await injectAuthenticated(app, {
        url: ORGANIZATION_SETTINGS_PATH,
        token,
      });
      expect(response.statusCode).toBe(403);
    });

    it('should return settings with organization read permission', async () => {
      const { organization, token } = await createAuthorizedOrganizationContext([
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
      ]);

      const response = await injectAuthenticated(app, {
        url: ORGANIZATION_SETTINGS_PATH,
        token,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: {
          organization_id: string;
          is_email_notifications_enabled: boolean;
          security_policy: unknown;
        };
      };
      expect(body.data).toHaveProperty('organization_id', organization.public_id);
      expect(body.data).toHaveProperty('is_email_notifications_enabled');
      expect(body.data).toHaveProperty('security_policy');
    });
  });

  describe('PATCH /api/v1/tenancy/organization/settings', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'PATCH',
        url: ORGANIZATION_SETTINGS_PATH,
        payload: { is_email_notifications_enabled: false },
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return 403 without organization update permission', async () => {
      const updateContext = await createAuthorizedOrganizationContext([
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
        TENANCY_PERMISSIONS.ORGANIZATION_UPDATE,
      ]);
      const readOnlyUser = await createTestUser({
        email: 'organization-settings-read-only@test.com',
      });
      const readOnlyRole = await createRoleWithPermissions({
        organizationId: updateContext.organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
      });
      await createMembership({
        userId: readOnlyUser.id,
        organizationId: updateContext.organization.id,
        roleId: readOnlyRole.id,
      });
      const readOnlyToken = await generateTestToken({
        userId: readOnlyUser.public_id,
        organizationPublicId: updateContext.organization.public_id,
      });

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: ORGANIZATION_SETTINGS_PATH,
        token: readOnlyToken,
        payload: { is_email_notifications_enabled: false },
      });
      expect(response.statusCode).toBe(403);
    });

    it('should return 400 when body contains unknown keys', async () => {
      const { token } = await createAuthorizedOrganizationContext([
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
        TENANCY_PERMISSIONS.ORGANIZATION_UPDATE,
      ]);

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: ORGANIZATION_SETTINGS_PATH,
        token,
        payload: { is_email_notifications_enabled: true, unknown_field: true },
      });
      expect(response.statusCode).toBe(400);
    });

    it('should return 400 when is_email_notifications_enabled has wrong type', async () => {
      const { token } = await createAuthorizedOrganizationContext([
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
        TENANCY_PERMISSIONS.ORGANIZATION_UPDATE,
      ]);

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: ORGANIZATION_SETTINGS_PATH,
        token,
        payload: { is_email_notifications_enabled: 'not-a-boolean' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('should update settings with organization update permission', async () => {
      const { token } = await createAuthorizedOrganizationContext([
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
        TENANCY_PERMISSIONS.ORGANIZATION_UPDATE,
      ]);

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: ORGANIZATION_SETTINGS_PATH,
        token,
        payload: {
          is_email_notifications_enabled: false,
          security_policy: { mfa_required: true },
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: {
          is_email_notifications_enabled: boolean;
          security_policy: { mfa_required: boolean };
        };
      };
      expect(body.data.is_email_notifications_enabled).toBe(false);
      expect(body.data.security_policy).toMatchObject({ mfa_required: true });
    });

    // audit #11: security_policy is MERGED, not whole-object replaced — so a second PATCH editing a
    // different key cannot silently revert the first (e.g. an admin enabling organization-mandated MFA).
    it('merges security_policy keys across sequential PATCHes (no lost update)', async () => {
      const { token } = await createAuthorizedOrganizationContext([
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
        TENANCY_PERMISSIONS.ORGANIZATION_UPDATE,
      ]);

      const first = await injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: ORGANIZATION_SETTINGS_PATH,
        token,
        payload: { security_policy: { mfa_required: true } },
      });
      expect(first.statusCode).toBe(200);

      const second = await injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: ORGANIZATION_SETTINGS_PATH,
        token,
        payload: { security_policy: { sso_enforced: true } },
      });
      expect(second.statusCode).toBe(200);

      const body = second.json() as {
        data: { security_policy: Record<string, unknown> };
      };
      // Both keys survive — the second PATCH did NOT clobber the first admin's mfa_required toggle.
      expect(body.data.security_policy).toMatchObject({ mfa_required: true, sso_enforced: true });
    });
  });
});
