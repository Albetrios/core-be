import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser, createTestUserWithPassword } from '@/tests/factories/user.factory.js';
import { generateTestToken, generateTestTokenAndSession } from '@/tests/helpers/test-auth.js';
import { seedRecentStepUpForTestUser } from '@/tests/helpers/test-step-up.helper.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { auth_methods } from '@/domains/auth/sub-domains/auth-method/auth-method.schema.js';
import { verification_tokens } from '@/domains/auth/sub-domains/auth-method/verification-token/verification-token.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/**
 * Bundled domain e2e — **canonical for route reachability and gates**.
 *
 * This file and `__tests__/integration/auth.integration.test.ts` used to share 33 `it()` titles,
 * and both are DB-bound, so every duplicated case was paid twice on every CI run. Both files are
 * structurally required (the bundled e2e by convention, the integration file by `validate:domain`),
 * so they were split by responsibility rather than one being deleted:
 *
 * - **Here:** every route is reachable and every denial fires — 400 / 401 / 403 / 404 shapes plus
 *   the plain success status of each route.
 * - **In `auth.integration.test.ts`:** what comes back *through* those gates — the session and
 *   CSRF cookie contract, the refresh Origin/Referer matrix, the MFA login envelope, and the
 *   translated i18n copy.
 *
 * Nothing is asserted in both files. When adding a case, pick the file by that question.
 */
describe('Auth Domain — Route gates (e2e)', () => {
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
  });

  // ─── Login ────────────────────────────────────────────────────

  describe('POST /api/v1/auth/login', () => {
    it('should return 400 for missing credentials', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('should return 401 for invalid credentials', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: {
          email: 'nonexistent@test.com',
          password: 'wrong-password',
        },
      });
      expect(response.statusCode).toBe(401);
    });

    it('when BLOCK_DISPOSABLE_EMAIL is off, login with disposable email returns 401 (invalid creds) not 400', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: {
          email: 'test@yopmail.com',
          password: 'wrong-password',
        },
      });
      expect(response.statusCode).toBe(401);
      expect(response.statusCode).not.toBe(400);
    });

    it('when BLOCK_DISPOSABLE_EMAIL is off, login with disposable email and valid credentials succeeds', async () => {
      const { user, password } = await createTestUserWithPassword({
        email: 'test@yopmail.com',
      });
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: {
          email: user.email,
          password,
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: Record<string, unknown> };
      expect(body.data).toHaveProperty('access_token');
    });

    it('should return 200 with access_token and set session cookie on valid login', async () => {
      const { user, password } = await createTestUserWithPassword();
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: {
          email: user.email,
          password,
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: { access_token: string } };
      expect(body.data).toHaveProperty('access_token');
      expect(typeof body.data.access_token).toBe('string');

      // Verify httpOnly session cookie is set
      const cookies = response.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const sessionCookie = Array.isArray(cookies)
        ? cookies.find((cookie: string) => cookie.startsWith('session_id='))
        : typeof cookies === 'string' && cookies.startsWith('session_id=')
          ? cookies
          : undefined;
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie).toContain('HttpOnly');
    });

    it('should create distinct sessions when logging in twice in quick succession', async () => {
      const { user, password } = await createTestUserWithPassword();
      const credentials = { email: user.email, password };

      const [firstLogin, secondLogin] = await Promise.all([
        injectUnauthenticated(app, {
          method: 'POST',
          url: testApiPath('/auth/login'),
          payload: credentials,
        }),
        injectUnauthenticated(app, {
          method: 'POST',
          url: testApiPath('/auth/login'),
          payload: credentials,
        }),
      ]);

      expect(firstLogin.statusCode).toBe(200);
      expect(secondLogin.statusCode).toBe(200);
      const firstBody = firstLogin.json() as { data: { access_token: string } };
      const secondBody = secondLogin.json() as { data: { access_token: string } };
      expect(firstBody.data.access_token).not.toBe(secondBody.data.access_token);
    });

    it('rejects login for a suspended user and revokes existing sessions on suspend (bug 31)', async () => {
      const { user, password } = await createTestUserWithPassword();

      // Establish an active session and prime the positive token-validity cache.
      const loginResponse = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: { email: user.email, password },
      });
      expect(loginResponse.statusCode).toBe(200);
      const accessToken = (loginResponse.json() as { data: { access_token: string } }).data
        .access_token;
      const beforeSuspend = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/auth/me/sessions'),
        token: accessToken,
      });
      expect(beforeSuspend.statusCode).toBe(200);

      // Suspend the user out-of-band, exercising UserService.suspendUser revocation.
      await app.userDomain.userService.suspendUser(user.public_id);

      // The previously-valid bearer token is rejected immediately (cache invalidated).
      const afterSuspend = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/auth/me/sessions'),
        token: accessToken,
      });
      expect(afterSuspend.statusCode).toBe(401);

      // A suspended user cannot mint a fresh session via password login.
      const reLogin = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: { email: user.email, password },
      });
      expect(reLogin.statusCode).toBe(401);
    });
  });

  // ─── Logout ───────────────────────────────────────────────────

  describe('POST /api/v1/auth/logout', () => {
    it('rejects a logout with no bearer token', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/logout'),
        payload: {},
      });
      // Previously a three-status band (`[200, 204, 401]`) on this route, which would
      // have passed whether the handler rejected the anonymous caller or silently succeeded.
      // The handler requires a bearer and raises UnauthorizedError when it is absent; the
      // authenticated 200 is asserted by the logout-after-login case below.
      expect(response.statusCode, response.body).toBe(401);
    });

    it('should clear session cookie on logout after login', async () => {
      const { user, password } = await createTestUserWithPassword();
      const loginResponse = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: {
          email: user.email,
          password,
        },
      });
      expect(loginResponse.statusCode).toBe(200);
      const loginBody = loginResponse.json() as { data: { access_token: string } };
      const accessToken = loginBody.data.access_token;

      const logoutResponse = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/logout'),
        token: accessToken,
      });
      expect([200]).toContain(logoutResponse.statusCode);
    });
  });

  // ─── Email verification-code login ────────────────────────────

  describe('POST /api/v1/auth/email/send-code', () => {
    it('should return 400 for missing email', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/email/send-code'),
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('should accept valid email format', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/email/send-code'),
        payload: { email: 'test@example.com' },
      });
      // Uniform 200 for known and unknown emails (no account enumeration).
      expect(response.statusCode).toBe(200);
    });

    it('when BLOCK_DISPOSABLE_EMAIL is off, send-code accepts disposable email', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/email/send-code'),
        payload: { email: 'test@yopmail.com' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: { message?: string } };
      expect(body.data.message).toBeDefined();
    });
  });

  describe('POST /api/v1/auth/email/login', () => {
    it('should return 400 for missing email/code', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/email/login'),
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('should return 401 for an unknown email / wrong code', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/email/login'),
        payload: { email: 'unknown-email-login@example.com', code: 'ZZZZZZ' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ─── OAuth ────────────────────────────────────────────────────

  describe('GET /api/v1/auth/oauth/providers', () => {
    it('should list OAuth providers', async () => {
      const response = await injectUnauthenticated(app, {
        url: testApiPath('/auth/oauth/providers'),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: { providers: string[] } };
      expect(body.data).toHaveProperty('providers');
      expect(Array.isArray(body.data.providers)).toBe(true);
      expect(body.data.providers).toContain('google');
      expect(body.data.providers).toContain('github');
    });
  });

  describe('GET /api/v1/auth/oauth/:provider', () => {
    it('should return 404 for an unknown provider name', async () => {
      const response = await injectUnauthenticated(app, {
        url: testApiPath('/auth/oauth/twitter'),
      });
      // Unknown provider names are a missing resource (404); the typed 501 is
      // reserved for supported-but-unconfigured providers.
      expect(response.statusCode).toBe(404);
    });

    it('should return 200 with the authorize redirect URL', async () => {
      // setup.ts pins fake OAuth client credentials, so the authorize URL is
      // built deterministically in every environment.
      const response = await injectUnauthenticated(app, {
        url: testApiPath('/auth/oauth/google'),
      });
      expect(response.statusCode).toBe(200);
    });
  });

  // ─── Password: Forgot / Reset ─────────────────────────────────

  describe('POST /api/v1/auth/password/forgot', () => {
    it('should return 400 for missing email', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/password/forgot'),
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('should return 200 with message for existing user (no enumeration)', async () => {
      const { user } = await createTestUserWithPassword();
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/password/forgot'),
        payload: { email: user.email },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: Record<string, unknown> };
      expect(body.data).toHaveProperty('message');
    });

    it('should return 200 with same message for non-existent email (anti-enumeration)', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/password/forgot'),
        payload: { email: 'nobody@nonexistent.com' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: Record<string, unknown> };
      expect(body.data).toHaveProperty('message');
    });

    it('when BLOCK_DISPOSABLE_EMAIL is off, password forgot accepts disposable email', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/password/forgot'),
        payload: { email: 'test@yopmail.com' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: Record<string, unknown> };
      expect(body.data).toHaveProperty('message');
    });
  });

  describe('POST /api/v1/auth/password/reset', () => {
    it('should return 400 for missing token/password', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/password/reset'),
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('should return 401 for invalid reset token', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/password/reset'),
        payload: {
          token: 'invalid-token-value',
          password: 'NewSecurePassword123!',
        },
      });
      expect(response.statusCode).toBe(401);
    });

    it('should reset password with a valid token and allow login with new password', async () => {
      const { user } = await createTestUserWithPassword();

      // Create a password reset token directly in DB
      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 3_600_000); // 1 hour

      await getOperatorDatabase().insert(verification_tokens).values({
        token_type: 'PASSWORD_RESET',
        token_hash: tokenHash,
        user_id: user.id,
        email: user.email,
        expires_at: expiresAt,
      });

      // Reset password
      const newPassword = 'BrandNewPassword456!';
      const resetResponse = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/password/reset'),
        payload: {
          token: rawToken,
          password: newPassword,
        },
      });
      expect(resetResponse.statusCode).toBe(200);

      // Login with new password
      const loginResponse = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: {
          email: user.email,
          password: newPassword,
        },
      });
      expect(loginResponse.statusCode).toBe(200);
      const loginBody = loginResponse.json() as { data: Record<string, unknown> };
      expect(loginBody.data).toHaveProperty('access_token');
    });
  });

  describe('POST /api/v1/auth/password/change', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/password/change'),
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return 400 for missing body with authentication', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/password/change'),
        token,
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('should change password for authenticated user with valid current password', async () => {
      const { user, password } = await createTestUserWithPassword();
      const { token, sessionPublicId } = await generateTestTokenAndSession({
        userId: user.public_id,
      });
      await seedRecentStepUpForTestUser(user.public_id, sessionPublicId);
      const newPassword = 'ChangedPassword789!';
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/password/change'),
        token,
        payload: {
          current_password: password,
          new_password: newPassword,
        },
      });
      expect(response.statusCode).toBe(200);

      // Verify login works with new password
      const loginResponse = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/login'),
        payload: {
          email: user.email,
          password: newPassword,
        },
      });
      expect(loginResponse.statusCode).toBe(200);
    });
  });

  // ─── Step-up (sudo) ───────────────────────────────────────────

  describe('POST /api/v1/auth/step-up', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/step-up'),
        payload: { password: 'whatever' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return 401 for an incorrect password', async () => {
      const { user } = await createTestUserWithPassword();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/step-up'),
        token,
        payload: { password: 'WrongPassword999!' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('grants a step-up window for a gated route after correct password', async () => {
      // Verified so the post-step-up enroll exercises the step-up window, not the separate
      // email-verification gate on credential enrollment (pre-hijacking guard).
      const { user, password } = await createTestUserWithPassword({ isEmailVerified: true });
      const token = await generateTestToken({ userId: user.public_id });

      // Fresh login / token must NOT carry a step-up window: a gated mutation is rejected.
      const beforeStepUp = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/me/mfa/enroll'),
        token,
        payload: { method_type: 'MFA_TOTP' },
      });
      expect(beforeStepUp.statusCode).toBe(403);

      const stepUp = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/step-up'),
        token,
        payload: { password },
      });
      expect(stepUp.statusCode).toBe(200);

      // After an explicit step-up the same gated route is reachable.
      const afterStepUp = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/me/mfa/enroll'),
        token,
        payload: { method_type: 'MFA_TOTP' },
      });
      expect(afterStepUp.statusCode).not.toBe(403);
    });
  });

  // ─── MFA ──────────────────────────────────────────────────────

  describe('POST /api/v1/auth/mfa/login', () => {
    it('should return 400 for missing body', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/mfa/login'),
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('should return 401 for a TOTP code without a valid mfa_session_token', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/mfa/login'),
        payload: { mfa_session_token: 'forged-or-expired-token', totp_code: '123456' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/auth/me/mfa/enroll', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/me/mfa/enroll'),
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/auth/me/mfa', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, { url: testApiPath('/auth/me/mfa') });
      expect(response.statusCode).toBe(401);
    });

    it('should return MFA methods for authenticated user', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        url: testApiPath('/auth/me/mfa'),
        token,
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/auth/me/mfa/verify', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/me/mfa/verify'),
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('DELETE /api/v1/auth/me/mfa/:mfa_method_id', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'DELETE',
        url: testApiPath('/auth/me/mfa/test-id'),
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ─── Sessions ─────────────────────────────────────────────────

  describe('GET /api/v1/auth/me/sessions', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, { url: testApiPath('/auth/me/sessions') });
      expect(response.statusCode).toBe(401);
    });

    it('should return sessions for authenticated user', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        url: testApiPath('/auth/me/sessions'),
        token,
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('DELETE /api/v1/auth/me/sessions/:id', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'DELETE',
        url: testApiPath('/auth/me/sessions/test-id'),
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('DELETE /api/v1/auth/me/sessions', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'DELETE',
        url: testApiPath('/auth/me/sessions'),
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ─── Auth Methods ─────────────────────────────────────────────

  describe('GET /api/v1/auth/me/auth-methods', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        url: testApiPath('/auth/me/auth-methods'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return auth methods for authenticated user', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        url: testApiPath('/auth/me/auth-methods'),
        token,
      });
      expect(response.statusCode).toBe(200);
    });

    it('sec-new-B4: response items expose public_id, not bigserial id', async () => {
      const user = await createTestUser();
      // `cleanupDatabase` runs in beforeEach, so the user starts with zero auth
      // methods. Seed one verified primary auth method directly so the list
      // response has an item to inspect for the B4 (public_id, no bigserial)
      // shape contract.
      await getOperatorDatabase()
        .insert(auth_methods)
        .values({
          public_id: generatePublicId('authMethod'),
          user_id: user.id,
          method_type: 'EMAIL_CODE',
          is_primary: true,
          verified_at: new Date(),
          created_by_user_id: user.id,
        });
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        url: testApiPath('/auth/me/auth-methods'),
        token,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: { id?: unknown; public_id?: unknown }[] };
      expect(body.data.length).toBeGreaterThan(0);
      for (const item of body.data) {
        // sec-new-B4: `id` is the opaque prefixed identifier, never the bigserial
        expect(typeof item.id).toBe('string');
        expect(item.id).toMatch(/^am_[a-z0-9]{21}$/);
        expect(item.public_id).toBeUndefined();
      }
    });
  });

  describe('POST /api/v1/auth/me/auth-methods', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/me/auth-methods'),
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('DELETE /api/v1/auth/me/auth-methods/:publicId', () => {
    it('should return 401 without authentication', async () => {
      const response = await injectUnauthenticated(app, {
        method: 'DELETE',
        url: testApiPath('/auth/me/auth-methods/abc12345678901234567'),
      });
      expect(response.statusCode).toBe(401);
    });

    it('sec-new-B4: rejects a numeric (bigserial) id in the path param with 400', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath('/auth/me/auth-methods/123'),
        token,
      });
      // Zod rejects the non-public-id value at the route level
      expect(response.statusCode).toBe(400);
    });
  });
});
