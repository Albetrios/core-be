import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generateTestToken, generateTestTokenAndSession } from '@/tests/helpers/test-auth.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { FastifyInstance } from 'fastify';

/**
 * Admin user-management happy paths (`ROLE: super_admin` routes) — the
 * declared success status of every /users/:user_id admin route observed with a
 * super_admin caller.
 */
describe('User admin routes — happy paths', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    // SUPER_ADMIN is re-derived per request from GLOBAL_ADMIN_EMAILS (sec-A6):
    // the actor's email must be allowlisted, ACTIVE, and verified.
    const admin = await createTestUser({ email: 'ops@example.com', isEmailVerified: true });
    adminToken = await generateTestToken({ userId: admin.public_id, role: 'super_admin' });
  });

  it('GET /users returns the paginated user list for an admin', async () => {
    // The admin LIST route had no HTTP test anywhere in the repo — every admin case below targets
    // /users/:user_id. Observed-status capture across e2e+integration+security showed only a 401.
    await createTestUser();
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/users'),
      token: adminToken,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { data: Array<{ id: string }> };
    // The seeded admin plus the target — the list actually lists, it does not just answer.
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /users/:user_id returns the target profile', async () => {
    const target = await createTestUser();
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath(`/users/${target.public_id}`),
      token: adminToken,
    });
    expect(response.statusCode, response.body).toBe(200);
  });

  it('PATCH /users/:user_id updates profile fields', async () => {
    const target = await createTestUser();
    const response = await injectAuthenticated(app, {
      method: 'PATCH',
      url: testApiPath(`/users/${target.public_id}`),
      token: adminToken,
      payload: { first_name: 'Updated' },
    });
    expect(response.statusCode, response.body).toBe(200);
  });

  it('POST /users/:user_id/suspend then /unsuspend round-trips status', async () => {
    const target = await createTestUser();

    const suspend = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath(`/users/${target.public_id}/suspend`),
      token: adminToken,
    });
    expect(suspend.statusCode, suspend.body).toBe(200);

    const unsuspend = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath(`/users/${target.public_id}/unsuspend`),
      token: adminToken,
    });
    expect(unsuspend.statusCode, unsuspend.body).toBe(200);
  });

  it('DELETE /users/:user_id soft-deletes the target', async () => {
    const target = await createTestUser();
    const response = await injectAuthenticated(app, {
      method: 'DELETE',
      url: testApiPath(`/users/${target.public_id}`),
      token: adminToken,
    });
    expect(response.statusCode, response.body).toBe(204);
  });

  /**
   * Denial paths for the same three routes. Each previously asserted its happy path and nothing
   * else — including `PATCH` and `DELETE /users/:user_id`, the two destructive admin operations,
   * where a missing authorization check would have gone unnoticed by every user-owned test.
   */
  describe('denials', () => {
    /** Well-formed but unallocated — proves 404 (not found) rather than 422 (bad id shape). */
    const UNKNOWN_USER_ID = generatePublicId('user');

    it('GET /users returns 403 for a plain user', async () => {
      const caller = await createTestUser();
      const token = await generateTestToken({ userId: caller.public_id, role: 'user' });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/users'),
        token,
      });
      expect(response.statusCode, response.body).toBe(403);
    });

    it('PATCH /users/:user_id returns 400 when the body sets status DELETED', async () => {
      // AdminUpdateUserDto only allows ACTIVE/SUSPENDED — DELETED is reachable solely through the
      // dedicated delete endpoint (soft-delete + offboarding). This 400 pins that boundary rule;
      // no admin-PATCH validator refusal was observed anywhere before it.
      const target = await createTestUser();
      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/users/${target.public_id}`),
        token: adminToken,
        payload: { status: 'DELETED' },
      });
      expect(response.statusCode, response.body).toBe(400);
    });

    it('GET /users/:user_id returns 403 for a plain user', async () => {
      const caller = await createTestUser();
      const target = await createTestUser();
      const token = await generateTestToken({ userId: caller.public_id, role: 'user' });

      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/users/${target.public_id}`),
        token,
      });
      expect(response.statusCode, response.body).toBe(403);
    });

    it('GET /users/:user_id returns 404 for an unknown user id', async () => {
      const response = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath(`/users/${UNKNOWN_USER_ID}`),
        token: adminToken,
      });
      expect(response.statusCode, response.body).toBe(404);
    });

    it('PATCH /users/:user_id returns 403 for a plain user', async () => {
      const caller = await createTestUser();
      const target = await createTestUser();
      const token = await generateTestToken({ userId: caller.public_id, role: 'user' });

      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/users/${target.public_id}`),
        token,
        payload: { first_name: 'Nope' },
      });
      expect(response.statusCode, response.body).toBe(403);
    });

    it('PATCH /users/:user_id returns 404 for an unknown user id', async () => {
      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath(`/users/${UNKNOWN_USER_ID}`),
        token: adminToken,
        payload: { first_name: 'Ghost' },
      });
      expect(response.statusCode, response.body).toBe(404);
    });

    it('DELETE /users/:user_id returns 403 for a plain user', async () => {
      const caller = await createTestUser();
      const target = await createTestUser();
      const token = await generateTestToken({ userId: caller.public_id, role: 'user' });

      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/users/${target.public_id}`),
        token,
      });
      expect(response.statusCode, response.body).toBe(403);
    });

    it('DELETE /users/:user_id returns 404 for an unknown user id', async () => {
      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/users/${UNKNOWN_USER_ID}`),
        token: adminToken,
      });
      expect(response.statusCode, response.body).toBe(404);
    });

    it('POST /users/:user_id/suspend returns 404 for an unknown user id', async () => {
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/users/${UNKNOWN_USER_ID}/suspend`),
        token: adminToken,
      });
      expect(response.statusCode, response.body).toBe(404);
    });

    it('POST /users/:user_id/unsuspend returns 404 for an unknown user id', async () => {
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/users/${UNKNOWN_USER_ID}/unsuspend`),
        token: adminToken,
      });
      expect(response.statusCode, response.body).toBe(404);
    });
  });

  /**
   * Suspension is only meaningful if it takes effect. `suspendUser` revokes every active session
   * for the target ("an outstanding bearer/cookie session cannot outlive the deactivation") and
   * `AuthSessionService` busts the 60-second session-validity cache; separately, session
   * validation rejects any user whose status is not ACTIVE. Until now the two suspend routes
   * asserted only their success status — nothing proved the target actually lost access.
   */
  describe('suspension takes effect', () => {
    it('revokes the suspended user active session', async () => {
      const target = await createTestUser({ email: 'suspend-target@example.com' });
      const { token: targetToken } = await generateTestTokenAndSession({
        userId: target.public_id,
      });

      const before = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/users/me'),
        token: targetToken,
      });
      expect(before.statusCode, before.body).toBe(200);

      const suspend = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/users/${target.public_id}/suspend`),
        token: adminToken,
      });
      expect(suspend.statusCode, suspend.body).toBe(200);

      const after = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/users/me'),
        token: targetToken,
      });
      expect(after.statusCode, after.body).toBe(401);
    });

    it('unsuspend restores ACTIVE status without resurrecting the revoked session', async () => {
      // Deliberately asymmetric: unsuspend flips the status back but does NOT re-issue the
      // sessions suspend revoked, so the old bearer must stay dead and the user must sign in
      // again. Asserting a symmetric "access restored" here would encode the wrong contract.
      const target = await createTestUser({ email: 'unsuspend-target@example.com' });
      const { token: targetToken } = await generateTestTokenAndSession({
        userId: target.public_id,
      });

      await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/users/${target.public_id}/suspend`),
        token: adminToken,
      });

      const unsuspend = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath(`/users/${target.public_id}/unsuspend`),
        token: adminToken,
      });
      expect(unsuspend.statusCode, unsuspend.body).toBe(200);
      expect((unsuspend.json() as { data: { status: string } }).data.status).toBe('ACTIVE');

      const withOldSession = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/users/me'),
        token: targetToken,
      });
      expect(withOldSession.statusCode, withOldSession.body).toBe(401);
    });
  });
});
