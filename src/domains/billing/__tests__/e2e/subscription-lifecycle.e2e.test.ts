import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import type { FastifyInstance } from 'fastify';

const BILLING_PERMISSIONS = ['subscription:read', 'subscription:manage'];

describe('Billing e2e: subscription lifecycle', () => {
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
    await seedPermissions(BILLING_PERMISSIONS);
  });

  it('lists plans then subscriptions for organization', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    await createTestPlan();
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: BILLING_PERMISSIONS,
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

    const plansResponse = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/billing/plans'),
      token,
    });
    expect(plansResponse.statusCode).toBe(200);

    const subscriptionsResponse = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/billing/subscriptions'),
      token,
    });
    expect(subscriptionsResponse.statusCode).toBe(200);
  });
});
