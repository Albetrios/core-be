import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectUnauthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUserWithPassword } from '@/tests/factories/user.factory.js';
import {
  provisionPersonalOrganization,
  provisionOrganizationWithOwner,
} from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * audit-#3: organization switching only re-bound the access-token hash; the
 * selected organization was not persisted on the session, so `/auth/refresh` recomputed
 * the DEFAULT active organization and silently moved the caller off the organization they
 * had switched to. The fix persists the active organization on the session and refresh
 * revalidates + preserves it. These tests drive the real HTTP login → switch →
 * refresh flow and assert the refreshed JWT `org` claim.
 */
describe('refresh preserves the switched active organization (audit-#3)', () => {
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
    // Full catalog: provisionOrganizationWithOwner grants billing codes for TEAM organizations.
    await seedAllPermissions();
  });

  function decodeOrgClaim(accessToken: string): string | undefined {
    const payloadSegment = accessToken.split('.')[1]!;
    const json = Buffer.from(payloadSegment, 'base64url').toString('utf8');
    return (JSON.parse(json) as { org?: string }).org;
  }

  function sessionCookie(headers: { 'set-cookie'?: string | string[] }): string {
    const raw = headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const sessionHeader = list.find((cookie) => cookie.startsWith('session_id='));
    expect(sessionHeader).toBeDefined();
    return String(sessionHeader).split(';')[0]!.trim();
  }

  it('refresh keeps the organization claim on the organization the caller switched to', async () => {
    const { user, password } = await createTestUserWithPassword();
    // Default active organization at login is the personal organization; the caller then switches to TEAM organization B.
    const personal = await provisionPersonalOrganization(user.id);
    const organizationB = await provisionOrganizationWithOwner({
      name: 'Refresh Org B',
      slug: `refresh-organization-b-${generatePublicId('organization').slice(4, 14)}`,
      type: 'TEAM',
      ownerUserId: user.id,
    });

    const loginResponse = await injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/login'),
      payload: { email: user.email, password },
    });
    expect(loginResponse.statusCode).toBe(200);
    const loginToken = (loginResponse.json() as { data: { access_token: string } }).data
      .access_token;
    expect(decodeOrgClaim(loginToken)).toBe(personal.organization.public_id);
    const cookie = sessionCookie(loginResponse.headers);

    const switchResponse = await app.inject({
      method: 'POST',
      url: testApiPath('/auth/switch-to-organization'),
      headers: { authorization: `Bearer ${loginToken}` },
      payload: { organization_id: organizationB.organization.public_id },
    });
    expect(switchResponse.statusCode).toBe(200);
    const switchedToken = (switchResponse.json() as { data: { access_token: string } }).data
      .access_token;
    expect(decodeOrgClaim(switchedToken)).toBe(organizationB.organization.public_id);

    const refreshResponse = await app.inject({
      method: 'POST',
      url: testApiPath('/auth/refresh'),
      headers: { cookie, origin: 'http://localhost:3000' },
      payload: {},
    });
    expect(refreshResponse.statusCode).toBe(200);
    const refreshedToken = (refreshResponse.json() as { data: { access_token: string } }).data
      .access_token;

    // The crux of audit-#3: refresh must NOT silently revert to the personal/default organization.
    expect(decodeOrgClaim(refreshedToken)).toBe(organizationB.organization.public_id);
  });

  it('refresh falls back to the default organization when the persisted membership is no longer valid', async () => {
    const { user, password } = await createTestUserWithPassword();
    const personal = await provisionPersonalOrganization(user.id);

    const loginResponse = await injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/login'),
      payload: { email: user.email, password },
    });
    expect(loginResponse.statusCode).toBe(200);
    const cookie = sessionCookie(loginResponse.headers);

    // No switch performed → session has no persisted organization → refresh resolves the default.
    const refreshResponse = await app.inject({
      method: 'POST',
      url: testApiPath('/auth/refresh'),
      headers: { cookie, origin: 'http://localhost:3000' },
      payload: {},
    });
    expect(refreshResponse.statusCode).toBe(200);
    const refreshedToken = (refreshResponse.json() as { data: { access_token: string } }).data
      .access_token;
    expect(decodeOrgClaim(refreshedToken)).toBe(personal.organization.public_id);
  });
});
