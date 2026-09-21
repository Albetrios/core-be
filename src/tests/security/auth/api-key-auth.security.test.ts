import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticatedOrganizationMutation,
  injectRoute,
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
import { NOTIFY_PERMISSIONS } from '@/domains/notify/notify.permissions.js';
import { database } from '@/infrastructure/database/connection.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { api_keys } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.schema.js';
type ApiKeyCreateResponse = {
  data: { api_key: { id: string }; raw_key: string };
};

describe('Security: Organization API key authentication', () => {
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
    await seedPermissions(Object.values(TENANCY_PERMISSIONS));
  });

  async function createApiKeyWithPermissions(permissionCodes: string[]) {
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
    // Flat api-key routes resolve the organization from the JWT `org` claim.
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });

    const createResponse = await injectAuthenticatedOrganizationMutation(app, {
      method: 'POST',
      url: testApiPath('/tenancy/organization/api-keys'),
      token,
      payload: { name: 'Security test key', scopes: permissionCodes },
    });
    expect(createResponse.statusCode).toBe(200);
    const body = createResponse.json() as ApiKeyCreateResponse;

    return {
      organization,
      rawKey: body.data.raw_key,
      apiKeyPublicId: body.data.api_key.id,
    };
  }

  it('returns 401 for unknown api key', async () => {
    // Auth runs before tenant resolution, so an unknown key is rejected on the
    // flat route regardless of organization context.
    const response = await injectRoute(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/api-keys'),
      headers: { authorization: 'ApiKey ak_00000000000000000000000000000000' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 403 when api key scopes exclude required permission', async () => {
    const { rawKey, apiKeyPublicId } = await createApiKeyWithPermissions([
      TENANCY_PERMISSIONS.API_KEY_READ,
      TENANCY_PERMISSIONS.API_KEY_MANAGE,
    ]);

    await database
      .update(api_keys)
      .set({ scopes: [TENANCY_PERMISSIONS.ORGANIZATION_READ] })
      .where(eq(api_keys.public_id, apiKeyPublicId));

    // The organization API-key principal carries its own organization, so the flat route
    // resolves the tenant from the key — no organization path segment.
    const response = await injectRoute(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/api-keys'),
      headers: { authorization: `ApiKey ${rawKey}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it('authenticates an organization API key end-to-end on a permission-guarded organization route', async () => {
    const { rawKey, apiKeyPublicId } = await createApiKeyWithPermissions([
      TENANCY_PERMISSIONS.API_KEY_READ,
      TENANCY_PERMISSIONS.API_KEY_MANAGE,
    ]);

    // The key principal carries an empty userId; previously the webhook controller's
    // requireAuth() rejected it after the permission preHandler passed. Grant the key
    // the webhook:read scope and confirm the request now succeeds end-to-end.
    await database
      .update(api_keys)
      .set({ scopes: [NOTIFY_PERMISSIONS.WEBHOOK_READ] })
      .where(eq(api_keys.public_id, apiKeyPublicId));

    // Flat webhook route: the organization is resolved from the API-key
    // principal (the key is pinned to one organization), not an organization path segment.
    const response = await injectRoute(app, {
      method: 'GET',
      url: testApiPath('/notify/webhooks'),
      headers: { authorization: `ApiKey ${rawKey}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('still refuses a revoked key on the very next request after a throttled one', async () => {
    // The `last_used_at` write is gated by a once-a-minute Redis claim, so the SECOND request with
    // a key skips the transaction that used to run on every one. This pins that the skip touches
    // only that write: authentication itself still resolves against Postgres each time, so a key
    // revoked between requests is refused immediately rather than for as long as some window.
    //
    // It matters because the gate sits in `authenticate`, one line above the code that decides the
    // request succeeds — a future refactor that hoisted the claim, or short-circuited on it, would
    // turn a throttle into a cache and this is the assertion that would notice.
    const { rawKey, apiKeyPublicId } = await createApiKeyWithPermissions([
      TENANCY_PERMISSIONS.API_KEY_READ,
      TENANCY_PERMISSIONS.API_KEY_MANAGE,
    ]);

    const authenticatedRequest = async () =>
      injectRoute(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization/api-keys'),
        headers: { authorization: `ApiKey ${rawKey}` },
      });

    // First claims the throttle window; second is the throttled one.
    expect((await authenticatedRequest()).statusCode).toBe(200);
    // Prove the throttle actually engaged rather than assuming it. Without this the test would
    // still pass if Redis were unreachable and every request fell back to writing — and it would
    // then be asserting nothing about the throttled path at all.
    await expect(redisConnection.exists(`apikey:last-used:${apiKeyPublicId}`)).resolves.toBe(1);
    expect((await authenticatedRequest()).statusCode).toBe(200);

    await database
      .update(api_keys)
      .set({ status: 'REVOKED' })
      .where(eq(api_keys.public_id, apiKeyPublicId));

    // Still inside the throttle window, so this request would skip the write if it got that far.
    expect((await authenticatedRequest()).statusCode).toBe(401);
  });

  it('rejects an organization API key on a user-only route that requires a real user', async () => {
    const { rawKey } = await createApiKeyWithPermissions([
      TENANCY_PERMISSIONS.API_KEY_READ,
      TENANCY_PERMISSIONS.API_KEY_MANAGE,
    ]);

    // Flat GET /tenancy/organization resolves the active organization from the principal
    // and calls requireAuth (no organization-permission preHandler), so an API-key
    // principal (empty userId) must be rejected with 401 even though it could
    // satisfy an organization-permission check on a permission-guarded route.
    const response = await injectRoute(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization'),
      headers: { authorization: `ApiKey ${rawKey}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 401 when api key is expired', async () => {
    const { rawKey, apiKeyPublicId } = await createApiKeyWithPermissions([
      TENANCY_PERMISSIONS.API_KEY_READ,
      TENANCY_PERMISSIONS.API_KEY_MANAGE,
    ]);

    await database
      .update(api_keys)
      .set({ expires_at: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(api_keys.public_id, apiKeyPublicId));

    const response = await injectRoute(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/api-keys'),
      headers: { authorization: `ApiKey ${rawKey}` },
    });
    expect(response.statusCode).toBe(401);
  });
});
