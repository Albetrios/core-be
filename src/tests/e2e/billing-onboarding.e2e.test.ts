import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  injectUnauthenticated,
  injectAuthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestUserWithPassword } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import type { FastifyInstance } from 'fastify';

const ONBOARDING_PERMISSIONS = ['subscription:read', 'organization:read', 'membership:read'];

describe('Cross-domain e2e: billing onboarding', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedPermissions(ONBOARDING_PERMISSIONS);
  });

  it('login → organization → billing plans and subscriptions', async () => {
    const { user, password } = await createTestUserWithPassword();
    const loginResponse = await injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/login'),
      payload: { email: user.email, password },
    });
    expect(loginResponse.statusCode).toBe(200);
    const token =
      (loginResponse.json() as { data?: { access_token?: string } }).data?.access_token ??
      (await generateTestToken({ userId: user.public_id }));

    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ONBOARDING_PERMISSIONS,
    });
    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    const plansResponse = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/billing/plans'),
      token: token as string,
    });
    expect(plansResponse.statusCode).toBe(200);

    // Flat subscription routes resolve the organization from the JWT `org`
    // claim, so mint a token scoped to the organization created above (the login token
    // was issued before the organization existed and carries no claim).
    const organizationScopedToken = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });

    const subscriptionsResponse = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/billing/subscriptions'),
      token: organizationScopedToken,
    });
    expect(subscriptionsResponse.statusCode).toBe(200);
  });
});
