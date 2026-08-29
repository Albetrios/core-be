import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import {
  seedPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import {
  loadRouteRegistryFromCatalog,
  loadOrganizationPermissionRoutesFromCatalog,
  type RouteEntry,
} from '@/tests/helpers/route-catalog-registry.js';
import { materializeRoutePath } from '@/tests/helpers/route-http-coverage.helper.js';
import type { FastifyInstance } from 'fastify';

const catalogRoutes = loadRouteRegistryFromCatalog();
const allPermissionCodes = [
  ...new Set(loadOrganizationPermissionRoutesFromCatalog().map((route) => route.permissionCode)),
];

/**
 * Routes that revoke or destroy the shared fixture identity when they succeed
 * (logout, session revocation, self/organization deletion). They run LAST, in this
 * order, so a successful destructive call cannot turn the remaining sweep
 * into a meaningless 401 parade. The never-5xx assertion still applies.
 */
const DESTRUCTIVE_SELF_TAIL: string[] = [
  'POST /api/v1/tenancy/organization/leave',
  'DELETE /api/v1/tenancy/organization',
  'DELETE /api/v1/auth/me/sessions/:session_id',
  'DELETE /api/v1/auth/me/sessions',
  'POST /api/v1/auth/logout',
  'DELETE /api/v1/users/me',
];

function routeKey(route: RouteEntry): string {
  return `${route.method} ${route.path}`;
}

function orderWithDestructiveTail(routes: RouteEntry[]): RouteEntry[] {
  const tailIndex = new Map(DESTRUCTIVE_SELF_TAIL.map((key, index) => [key, index]));
  const head = routes.filter((route) => !tailIndex.has(routeKey(route)));
  const tail = routes
    .filter((route) => tailIndex.has(routeKey(route)))
    .sort(
      (left, right) => (tailIndex.get(routeKey(left)) ?? 0) - (tailIndex.get(routeKey(right)) ?? 0),
    );
  return [...head, ...tail];
}

const FUZZ_PAYLOAD = {
  __fuzz: 'junk',
  unexpected: { deeply: ['nested', 42], nullish: null },
};

/**
 * Catalog-wide negative sweep — an authenticated caller with every permission
 * sending junk payloads and placeholder path params must never produce a 5xx
 * on any of the 129 routes. Validation (400/422), not-found (404), auth
 * (401/403), and method-specific rejections are all acceptable; an unhandled
 * exception is not.
 */
describe('Security: route fuzz — authenticated junk never 5xx', () => {
  let app: FastifyInstance;
  let token: string;
  let organizationPublicId: string;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;

    await cleanupDatabase();
    await seedPermissions(allPermissionCodes);

    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: allPermissionCodes,
      createdByUserId: user.id,
    });
    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: role.id,
    });

    organizationPublicId = organization.public_id;
    token = await generateTestToken({ userId: user.public_id, role: 'super_admin' });

    expect(catalogRoutes.length).toBeGreaterThan(100);
  });

  afterAll(async () => {
    await app.close();
  });

  for (const route of orderWithDestructiveTail(catalogRoutes)) {
    const isMutating = route.method !== 'GET' && route.method !== 'DELETE';

    it(`${route.method} ${route.path} responds below 500 to junk input`, async () => {
      const response = await injectAuthenticated(app, {
        method: route.method,
        url: materializeRoutePath(route.path, organizationPublicId),
        token,
        organizationPublicId,
        ...(isMutating
          ? {
              payload: FUZZ_PAYLOAD,
              headers: { 'x-idempotency-key': `route-fuzz-${randomUUID()}` },
            }
          : {}),
      });

      expect(
        response.statusCode,
        `${route.method} ${route.path} returned ${response.statusCode}: ${response.body}`,
      ).toBeLessThan(500);
    });
  }
});
