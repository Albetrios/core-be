import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectUnauthenticated, injectRoute } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { eq } from 'drizzle-orm';
import { createTestUserWithPassword } from '@/tests/factories/user.factory.js';
import { database } from '@/infrastructure/database/connection.js';
import { users } from '@/domains/user/user.schema.js';
import type { FastifyInstance } from 'fastify';

const AUTH_LOGIN_PATH = '/auth/login';

/**
 * Domain integration — **canonical for what comes back through the routes**.
 *
 * This file and the bundled e2e `__tests__/auth.test.ts` used to share 33 `it()` titles, and both
 * are DB-bound, so every duplicated case cost two real HTTP round-trips against Postgres and Redis
 * on every CI run. Both files are structurally required (the bundled e2e by convention, this one by
 * `validate:domain`), so they were split by responsibility rather than one being deleted:
 *
 * - **In `auth.test.ts`:** every route is reachable and every denial fires — the 400 / 401 / 403 /
 *   404 gate shapes and each route's plain success status.
 * - **Here:** the response contract *through* those gates — the session and CSRF cookie pair, the
 *   refresh Origin/Referer allowlist matrix, the MFA-challenge login envelope, and the translated
 *   i18n copy.
 *
 * Nothing is asserted in both files. When adding a case, pick the file by that question.
 */
describe('Auth Domain — Response contract (integration)', () => {
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

  // ─── Login envelope ───────────────────────────────────────────

  describe('POST /api/v1/auth/login — MFA challenge envelope', () => {
    it('should return mfa_required without access_token when MFA is enabled', async () => {
      const { user, password } = await createTestUserWithPassword();
      await database
        .update(users)
        .set({ is_mfa_enabled: true })
        .where(eq(users.public_id, user.public_id));

      const response = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath(AUTH_LOGIN_PATH),
        payload: { email: user.email, password },
      });
      expect(response.statusCode).toBe(200);
      const data = (response.json() as { data: Record<string, unknown> }).data;
      expect(data.mfa_required).toBe(true);
      expect(typeof data.mfa_session_token).toBe('string');
      expect(data.access_token).toBeUndefined();

      const cookies = response.headers['set-cookie'];
      const sessionCookie = Array.isArray(cookies)
        ? cookies.find((cookie: string) => cookie.startsWith('session_id='))
        : undefined;
      expect(sessionCookie).toBeUndefined();
    });

    it('should return 401 on refresh when login stopped at MFA and no session cookie was set', async () => {
      const { user, password } = await createTestUserWithPassword();
      await database
        .update(users)
        .set({ is_mfa_enabled: true })
        .where(eq(users.public_id, user.public_id));

      const loginResponse = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath(AUTH_LOGIN_PATH),
        payload: { email: user.email, password },
      });
      expect(loginResponse.statusCode).toBe(200);

      const refreshResponse = await app.inject({
        method: 'POST',
        url: testApiPath('/auth/refresh'),
        headers: { referer: 'http://localhost:3000/' },
        payload: {},
      });
      expect(refreshResponse.statusCode).toBe(401);
    });
  });

  // ─── Session Refresh: cookie pair + Origin/Referer allowlist ──

  describe('POST /api/v1/auth/refresh', () => {
    function cookiePairFromLoginResponse(
      loginResponseHeaders: { 'set-cookie'?: string | string[] },
      cookieName: string,
    ): string {
      const cookiesRaw = loginResponseHeaders['set-cookie'];
      let cookieHeader: string | undefined;
      if (Array.isArray(cookiesRaw)) {
        cookieHeader = cookiesRaw.find((cookie) => cookie.startsWith(`${cookieName}=`));
      } else if (typeof cookiesRaw === 'string' && cookiesRaw.startsWith(`${cookieName}=`)) {
        cookieHeader = cookiesRaw;
      }
      expect(cookieHeader).toBeDefined();
      const onlyPair = String(cookieHeader).split(';')[0]!.trim();
      expect(onlyPair.startsWith(`${cookieName}=`)).toBe(true);
      return onlyPair;
    }

    function sessionIdCookiePairFromLoginResponse(loginResponseHeaders: {
      'set-cookie'?: string | string[];
    }): string {
      return cookiePairFromLoginResponse(loginResponseHeaders, 'session_id');
    }

    function authCookieHeaderFromLoginResponse(loginResponseHeaders: {
      'set-cookie'?: string | string[];
    }): string {
      const sessionPair = sessionIdCookiePairFromLoginResponse(loginResponseHeaders);
      const csrfPair = cookiePairFromLoginResponse(loginResponseHeaders, 'csrf_token');
      return `${sessionPair}; ${csrfPair}`;
    }

    async function loginAndGetResponseHeaders() {
      const { user, password } = await createTestUserWithPassword();
      const loginResponse = await injectUnauthenticated(app, {
        method: 'POST',
        url: testApiPath(AUTH_LOGIN_PATH),
        payload: { email: user.email, password },
      });
      expect(loginResponse.statusCode).toBe(200);
      return loginResponse.headers;
    }

    it('should return 401 for missing session cookie', async () => {
      const response = await app.inject({
        method: 'POST',
        url: testApiPath('/auth/refresh'),
        headers: { referer: 'http://localhost:3000/' },
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });

    it('should return new access_token when valid session cookie is provided', async () => {
      const loginHeaders = await loginAndGetResponseHeaders();
      const cookieHeader = authCookieHeaderFromLoginResponse(loginHeaders);

      const refreshResponse = await app.inject({
        method: 'POST',
        url: testApiPath('/auth/refresh'),
        headers: {
          cookie: cookieHeader,
          referer: 'http://localhost:3000/',
        },
        payload: {},
      });
      expect(refreshResponse.statusCode).toBe(200);
      const body = refreshResponse.json() as { data?: { access_token?: string } };
      expect(body.data).toHaveProperty('access_token');
      const newToken = body.data?.access_token;
      expect(typeof newToken).toBe('string');
      expect((newToken as string).length).toBeGreaterThan(0);
      const refreshSetCookie = refreshResponse.headers['set-cookie'];
      expect(refreshSetCookie).toBeDefined();
      expect(
        cookiePairFromLoginResponse(
          { 'set-cookie': refreshSetCookie as string | string[] },
          'csrf_token',
        ),
      ).toMatch(/^csrf_token=/);
    });

    it('should set csrf_token cookie on login', async () => {
      const loginHeaders = await loginAndGetResponseHeaders();
      expect(cookiePairFromLoginResponse(loginHeaders, 'csrf_token')).toMatch(/^csrf_token=/);
    });

    it('should return 403 when Origin header is not in ALLOWED_ORIGINS', async () => {
      const loginHeaders = await loginAndGetResponseHeaders();
      const cookiePair = sessionIdCookiePairFromLoginResponse(loginHeaders);

      const refreshResponse = await app.inject({
        method: 'POST',
        url: testApiPath('/auth/refresh'),
        headers: {
          cookie: cookiePair,
          origin: 'https://untrusted.example.com',
        },
        payload: {},
      });
      expect(refreshResponse.statusCode).toBe(403);
    });

    it('should return 403 when Origin and Referer are both absent', async () => {
      const loginHeaders = await loginAndGetResponseHeaders();
      const cookiePair = sessionIdCookiePairFromLoginResponse(loginHeaders);

      const refreshResponse = await app.inject({
        method: 'POST',
        url: testApiPath('/auth/refresh'),
        headers: { cookie: cookiePair },
        payload: {},
      });
      expect(refreshResponse.statusCode).toBe(403);
    });

    it('should return 200 when Referer origin matches ALLOWED_ORIGINS', async () => {
      const loginHeaders = await loginAndGetResponseHeaders();
      const cookiePair = sessionIdCookiePairFromLoginResponse(loginHeaders);

      const refreshResponse = await app.inject({
        method: 'POST',
        url: testApiPath('/auth/refresh'),
        headers: {
          cookie: cookiePair,
          referer: 'http://localhost:3000/auth',
        },
        payload: {},
      });
      expect(refreshResponse.statusCode).toBe(200);
    });

    it('should return 403 when Referer origin is not in ALLOWED_ORIGINS', async () => {
      const loginHeaders = await loginAndGetResponseHeaders();
      const cookiePair = sessionIdCookiePairFromLoginResponse(loginHeaders);

      const refreshResponse = await app.inject({
        method: 'POST',
        url: testApiPath('/auth/refresh'),
        headers: {
          cookie: cookiePair,
          referer: 'https://untrusted.example.com/page',
        },
        payload: {},
      });
      expect(refreshResponse.statusCode).toBe(403);
    });

    it('should return 200 when Origin matches ALLOWED_ORIGINS', async () => {
      const loginHeaders = await loginAndGetResponseHeaders();
      const cookiePair = sessionIdCookiePairFromLoginResponse(loginHeaders);

      const refreshResponse = await app.inject({
        method: 'POST',
        url: testApiPath('/auth/refresh'),
        headers: {
          cookie: cookiePair,
          origin: 'http://localhost:3000',
        },
        payload: {},
      });
      expect(refreshResponse.statusCode).toBe(200);
      const body = refreshResponse.json() as { data?: { access_token?: string } };
      expect(body.data).toHaveProperty('access_token');
    });
  });

  // ─── i18n (Accept-Language) ────────────────────────────────────

  describe('i18n response messages', () => {
    it('returns translated success message for send-code with Accept-Language: es', async () => {
      const response = await injectRoute(app, {
        method: 'POST',
        url: testApiPath('/auth/email/send-code'),
        headers: { 'accept-language': 'es' },
        payload: { email: 'unknown-email-code-user@example.com' },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { data: Record<string, unknown> }).data.message).toBeDefined();
      expect([
        'If an account exists with this email, you will receive a sign-in code shortly.',
        'Si existe una cuenta con este correo, recibirás un código de inicio de sesión en breve.',
      ]).toContain((response.json() as { data: Record<string, unknown> }).data.message);
    });

    it('returns 404 error detail in English with Accept-Language: en', async () => {
      const response = await injectRoute(app, {
        method: 'GET',
        url: testApiPath('/auth/nonexistent-route-for-i18n-test'),
        headers: { 'accept-language': 'en' },
      });
      expect(response.statusCode).toBe(404);
      expect((response.json() as { error?: Record<string, unknown> }).error?.detail).toBe(
        'Route not found',
      );
    });

    it('returns 404 error detail in Spanish when Accept-Language: es is supported', async () => {
      const response = await injectRoute(app, {
        method: 'GET',
        url: testApiPath('/auth/nonexistent-route-for-i18n-test'),
        headers: { 'accept-language': 'es' },
      });
      expect(response.statusCode).toBe(404);
      const errorDetail = (response.json() as { error?: { detail?: string } }).error?.detail;
      // Deterministic once i18nMiddleware is fp()-wrapped: Accept-Language: es yields Spanish.
      expect(errorDetail).toBe('Ruta no encontrada');
    });
  });
});
