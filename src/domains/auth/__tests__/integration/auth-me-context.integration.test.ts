import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedPermissions,
  seedAllPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

const PERMISSIONS = [TENANCY_PERMISSIONS.ORGANIZATION_READ, TENANCY_PERMISSIONS.MEMBERSHIP_READ];

interface AuthMeContextBody {
  data: {
    user: { id: string };
    active_organization: { id: string; type: string } | null;
    my_permissions: string[];
    global_role: string | null;
    organizations: Array<{ id: string; is_active: boolean }>;
  };
}

describe('GET /api/v1/auth/me/context — Integration', () => {
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
    // /auth/me/context → getMe self-heals a missing personal organization; provisioning needs the full
    // owner-permission catalog present (role_permissions → permissions FK). Seed all codes so
    // the self-heal succeeds. This does NOT change my_permissions — those come from the role
    // built with seedPermissions(PERMISSIONS)/createRoleWithPermissions below.
    await seedAllPermissions();
    await seedPermissions(PERMISSIONS);
  });

  async function setupAuthorizedUser() {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: PERMISSIONS,
    });
    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, organization, token };
  }

  it('returns 401 without authentication', async () => {
    const response = await injectUnauthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/context'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns the caller context: identity, active organization, permissions, and switcher list', async () => {
    const { user, organization, token } = await setupAuthorizedUser();

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/context'),
      token,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as AuthMeContextBody;

    expect(body.data.user.id).toBe(user.public_id);
    expect(body.data.active_organization?.id).toBe(organization.public_id);
    expect(body.data.active_organization?.type).toBe('TEAM');
    expect(body.data.my_permissions).toContain('organization:read');
    expect(Array.isArray(body.data.organizations)).toBe(true);
    expect(body.data.organizations.find((o) => o.id === organization.public_id)?.is_active).toBe(
      true,
    );
  });
});
