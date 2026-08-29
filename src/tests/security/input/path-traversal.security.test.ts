import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import type { FastifyInstance } from 'fastify';

const TRAVERSAL_PAYLOADS = [
  '../../../etc/passwd',
  '..%2F..%2F..%2Fetc%2Fpasswd',
  '....//....//etc/passwd',
  '%2e%2e%2f%2e%2e%2f',
];

describe('Security: Path traversal', () => {
  let app: FastifyInstance;
  // Bearer scoped to a real organization via the JWT `org` claim — flat tenancy
  // routes resolve the tenant from the claim, so the traversal payload exercises
  // a resource-id path param (`role_id`) rather than the organization segment.
  let token: string;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
    await seedPermissions([TENANCY_PERMISSIONS.ROLE_READ]);
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [TENANCY_PERMISSIONS.ROLE_READ],
    });
    await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });
    token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  for (const payload of TRAVERSAL_PAYLOADS) {
    it(`should not expose files for traversal payload in a tenancy resource id path (${payload})`, async () => {
      const encoded = encodeURIComponent(payload);
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/tenancy/organization/roles/${encoded}`),
        token,
      });

      // The set already excludes every 5xx, so a separate `toBeLessThan(500)` added nothing.
      expect([400, 401, 403, 404]).toContain(response.statusCode);
    });
  }

  it('rejects an unauthenticated request to the flat organization route with 401', async () => {
    // The organization path segment is gone (organization comes from the token claim);
    // an unauthenticated caller is rejected before any tenant resolution.
    const response = await injectUnauthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization'),
    });

    expect(response.statusCode).toBe(401);
  });
});
