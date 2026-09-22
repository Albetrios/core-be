import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateTestToken, generateTestTokenAndSession } from '@/tests/helpers/test-auth.js';
import { seedRecentStepUpForTestUser } from '@/tests/helpers/test-step-up.helper.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  seedAllPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { signAccessToken } from '@/shared/utils/security/jwt.util.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { provisionOrganizationWithOwner } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';
import { invalidatePermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import { database } from '@/infrastructure/database/connection.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/**
 * Session invalidation security tests — verify that revoked, forged, malformed,
 * and cross-tenant tokens are rejected by the auth middleware.
 */
describe('Security: Session invalidation', () => {
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
    // Whole catalog, not the tenancy subset: provisioning grants audit and upload codes too.
    await seedAllPermissions();
  });

  async function createActiveUserWithToken() {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
    });
    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    const { token, sessionPublicId } = await generateTestTokenAndSession({
      userId: user.public_id,
    });
    return { user, organization, token, sessionPublicId };
  }

  // POSITIVE — baseline: valid token returns 200
  it('should allow access with a valid token on an authenticated endpoint', async () => {
    const { token } = await createActiveUserWithToken();

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/sessions'),
      token,
    });

    expect(response.statusCode).toBe(200);
  });

  // NEGATIVE — token with non-existent userId (user never existed or was deleted)
  it('should return 401 for token where userId does not exist in the database', async () => {
    // Sign a JWT for a user that has no session row and no DB record.
    // `signAccessToken` only produces the JWT without touching the DB;
    // the auth middleware then calls `verifyActiveAccessToken` which looks up
    // the session row by token_hash — which will not exist — and throws 401.
    const ghostToken = await signAccessToken({
      userId: 'ghost-user-public-id-that-does-not-exist',
      role: 'user',
    });

    const response = await injectUnauthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/sessions'),
      headers: { authorization: `Bearer ${ghostToken}` },
    });

    expect(response.statusCode).toBe(401);
  });

  // NEGATIVE — a user with no membership in organization B cannot reach organization B's resources.
  //
  // Flat tenancy routes resolve the organization from the JWT `org` claim, so
  // cross-tenant access is expressed by scoping user A's token to organization B's claim:
  // A holds no membership in B, so the flat settings route resolves to B and the
  // permission preHandler denies it (403). A forged claim is scope, not authority.
  it("should return 403 when a user's token claims an organization they don't belong to", async () => {
    const userA = await createActiveUserWithToken();
    const userB = await createActiveUserWithToken();

    const userATokenScopedToB = await generateTestToken({
      userId: userA.user.public_id,
      organizationPublicId: userB.organization.public_id,
    });

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/settings'),
      token: userATokenScopedToB,
    });

    expect([403, 404]).toContain(response.statusCode);
  });

  /**
   * Lists the caller's session public ids via GET /auth/me/sessions.
   *
   * @remarks
   * The endpoint returns the active session rows as a plain array under `data`,
   * each carrying an `id` (the value accepted by DELETE /auth/me/sessions/:session_id).
   */
  async function listSessionPublicIds(token: string): Promise<string[]> {
    const listResponse = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/sessions'),
      token,
    });
    expect(listResponse.statusCode).toBe(200);
    const sessions = (listResponse.json() as { data: { id: string }[] }).data;
    expect(Array.isArray(sessions)).toBe(true);
    return sessions.map((session) => session.id);
  }

  // NEGATIVE — a revoked (non-current) session's token must be rejected.
  //
  // DELETE /auth/me/sessions/:session_id revokes OTHER devices, not the caller's current
  // session, so we revoke a second session (device B) using device A's token and
  // assert device B's token is then rejected while device A's still works. This
  // proves the auth middleware enforces per-session revocation (verifyActiveAccessToken).
  it('should return 401 when a revoked (other-device) session token is reused', async () => {
    const {
      token: tokenA,
      sessionPublicId: sessionPublicIdA,
      user,
    } = await createActiveUserWithToken();

    // Snapshot device A's session public id.
    const idsBeforeB = await listSessionPublicIds(tokenA);
    expect(idsBeforeB.length).toBe(1);
    const sessionIdA = idsBeforeB[0]!;

    // Create a second session (device B) for the same user.
    const tokenB = await generateTestToken({ userId: user.public_id });
    await seedRecentStepUpForTestUser(user.public_id, sessionPublicIdA);

    // Device A now sees two sessions; identify device B as the new one.
    const idsAfterB = await listSessionPublicIds(tokenA);
    expect(idsAfterB.length).toBe(2);
    const sessionIdB = idsAfterB.find((id) => id !== sessionIdA);
    expect(sessionIdB).toBeDefined();

    // Device A revokes device B's session.
    const revokeResponse = await injectAuthenticated(app, {
      method: 'DELETE',
      url: testApiPath(`/auth/me/sessions/${sessionIdB}`),
      token: tokenA,
    });
    expect([200, 204]).toContain(revokeResponse.statusCode);

    // Device B's token must now be rejected (session revoked, cache invalidated).
    const afterRevokeResponseB = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/sessions'),
      token: tokenB,
    });
    expect(afterRevokeResponseB.statusCode).toBe(401);

    // Device A (the caller's current session) must still work.
    const stillActiveResponseA = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/sessions'),
      token: tokenA,
    });
    expect(stillActiveResponseA.statusCode).toBe(200);
  });

  // sec-new-A3 + sec-r4-A1: DELETE /auth/me/sessions intentionally PRESERVES
  // the caller's own session so the client is not silently logged out — only
  // OTHER sessions are revoked. The caller's token must therefore still work
  // after the bulk revoke; a second device's token must be rejected.
  it(
    'after DELETE /auth/me/sessions: caller session preserved (sec-new-A3 / sec-r4-A1), ' +
      'other sessions revoked',
    async () => {
      const {
        token: tokenA,
        sessionPublicId: sessionPublicIdA,
        user,
      } = await createActiveUserWithToken();
      await seedRecentStepUpForTestUser(user.public_id, sessionPublicIdA);

      // Second login on the same user → simulates a different device.
      const tokenB = (await generateTestTokenAndSession({ userId: user.public_id })).token;

      // Pre-condition: both tokens succeed against /auth/me/sessions.
      const sanityA = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/auth/me/sessions'),
        token: tokenA,
      });
      expect(sanityA.statusCode).toBe(200);
      const sanityB = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/auth/me/sessions'),
        token: tokenB,
      });
      expect(sanityB.statusCode).toBe(200);

      // Device A revokes ALL sessions for this user via the bulk endpoint.
      const revokeAll = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath('/auth/me/sessions'),
        token: tokenA,
      });
      expect([200, 204]).toContain(revokeAll.statusCode);

      // Caller (device A) MUST still work — sec-new-A3 preserves the caller's
      // own session; sec-r4-A1 leaves the session cookie intact too.
      const callerAfter = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/auth/me/sessions'),
        token: tokenA,
      });
      expect(callerAfter.statusCode).toBe(200);

      // Device B's token must now be rejected — every session OTHER THAN the
      // caller's was revoked.
      const otherDeviceAfter = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/auth/me/sessions'),
        token: tokenB,
      });
      expect(otherDeviceAfter.statusCode).toBe(401);
    },
  );

  // NEGATIVE — token signed with a different (wrong) algorithm / tampered signature
  it('should return 401 for a token with a tampered payload', async () => {
    const { token } = await createActiveUserWithToken();
    const parts = token.split('.');
    // Swap out the payload with an attacker-crafted one (signature will be invalid)
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'attacker', role: 'super_admin', iat: Math.floor(Date.now() / 1000) }),
    ).toString('base64url');
    const tamperedToken = `${parts[0]}.${forgedPayload}.${parts[2]}`;

    const response = await injectUnauthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/sessions'),
      headers: { authorization: `Bearer ${tamperedToken}` },
    });

    expect(response.statusCode).toBe(401);
  });

  // NEGATIVE — completely malformed JWT (base64 corrupted)
  it('should return 401 for a malformed / corrupted JWT', async () => {
    const malformed = 'eyJhbGciOiJSUzI1NiJ9.CORRUPTED_PAYLOAD.BROKEN_SIGNATURE';

    const response = await injectUnauthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/sessions'),
      headers: { authorization: `Bearer ${malformed}` },
    });

    expect(response.statusCode).toBe(401);
  });

  // M3 — TRUST GUARANTEE: a removed member's still-valid `org`-claim token must lose
  // access on its NEXT request. The claim is SCOPE, not AUTHORITY: requireOrganizationPermission
  // re-checks membership per request, and a membership change invalidates the permission cache.
  // This proves that revoking someone's membership takes effect immediately even though their
  // bearer token (claim still = the organization) is otherwise unexpired.
  it('should return 403 on the next request after a member is removed (stale organization-claim token loses access)', async () => {
    // An ACTIVE owner-member of organization A holds role:read (the owner role grants all tenancy perms).
    const user = await createTestUser();
    const organizationA = await provisionOrganizationWithOwner({
      name: 'M3 Org A',
      slug: `m3-organization-a-${generatePublicId('organization').slice(4, 14)}`,
      type: 'TEAM',
      ownerUserId: user.id,
    });
    const { token } = await generateTestTokenAndSession({
      userId: user.public_id,
      organizationPublicId: organizationA.organization.public_id,
    });

    // Pre-condition: the organization-scoped role:read route resolves the organization from the claim and allows it.
    const before = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/roles'),
      token,
    });
    expect(before.statusCode).toBe(200);

    // Remove the user's membership in organization A, exactly as the membership service does: soft-delete
    // the row, then invalidate the per-(user, organization) permission cache so the change is immediate.
    await database
      .update(memberships)
      .set({ deleted_at: new Date() })
      .where(
        and(
          eq(memberships.user_id, user.id),
          eq(memberships.organization_id, organizationA.organization.id),
        ),
      );
    await invalidatePermissions(user.public_id, organizationA.organization.public_id);

    // The SAME token (claim still = organization A) now resolves zero permissions for a non-member →
    // requireOrganizationPermission denies role:read with 403. The token was never re-minted.
    const after = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization/roles'),
      token,
    });
    expect(after.statusCode).toBe(403);
  });

  // NEGATIVE — token with role claim tampered to super_admin must not bypass session check
  it('should return 401 for a token whose role claim is forged to super_admin', async () => {
    const { token } = await createActiveUserWithToken();
    const parts = token.split('.');
    // Decode original header and payload, forge role
    const originalHeader = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
    const originalPayload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());

    const forgedPayload = { ...originalPayload, role: 'super_admin' };
    const forgedHeader = Buffer.from(JSON.stringify(originalHeader)).toString('base64url');
    const forgedBody = Buffer.from(JSON.stringify(forgedPayload)).toString('base64url');
    // Signature remains from original — will be invalid for this payload
    const forgedToken = `${forgedHeader}.${forgedBody}.${parts[2]}`;

    const response = await injectUnauthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/sessions'),
      headers: { authorization: `Bearer ${forgedToken}` },
    });

    expect(response.statusCode).toBe(401);
  });
});
