import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { generate as generateTotp } from 'otplib';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { generateTestToken, generateTestTokenAndSession } from '@/tests/helpers/test-auth.js';
import { seedRecentStepUpForTestUser } from '@/tests/helpers/test-step-up.helper.js';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

const ME_RETRY_ATTEMPTS = 3;
const ME_RETRY_DELAY_MS = 50;

/**
 * GET /api/v1/users/me with retries on 404 to absorb transient DB visibility after createTestUser().
 */
async function getMeWithRetry(
  application: FastifyInstance,
  token: string,
): Promise<InjectHttpResult> {
  for (let attempt = 1; attempt <= ME_RETRY_ATTEMPTS; attempt++) {
    const response = await injectAuthenticated(application, {
      url: testApiPath('/users/me'),
      token,
    });
    if (response.statusCode !== 404) return response;
    if (attempt < ME_RETRY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, ME_RETRY_DELAY_MS * attempt));
    }
  }
  return injectAuthenticated(application, {
    url: testApiPath('/users/me'),
    token,
  });
}

/**
 * Multi-step user flows.
 *
 * This suite and `__tests__/integration/user.integration.test.ts` used to be near-duplicates —
 * 21 of their `it()` titles were shared, including a seven-step MFA round-trip that ran twice.
 * They are now split by role: **`user.integration.test.ts` is canonical for route contracts**
 * (the declared status of every user route, plus its denials), and this file keeps only the
 * flows — cases whose value is the sequence of calls rather than any single status code.
 * Single-route status assertions belong in the integration suite, not here.
 */
describe('User Domain — flows', () => {
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
    // GET /users/me self-heals a missing personal organization (provisions on read when personal is
    // enabled); provisioning grants the owner role every permission code, so the full catalog
    // must exist or the role_permissions → permissions FK fails. Seed it so the self-heal
    // succeeds and personal_organization_id is reliably non-null (mirrors the tenancy suites).
    await seedAllPermissions();
  });

  describe('GET /api/v1/users/me', () => {
    it('exposes personal_organization_id (self-heal provisions one on demand)', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await getMeWithRetry(app, token);
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: {
          personal_organization_id: string | null;
        };
      };
      // Self-heal: a bare createTestUser has no personal organization, but with personal enabled
      // getMe provisions one on demand so personal_organization_id is reliably non-null
      // (a user can never dead-end onboarding for lack of a personal workspace).
      expect(body.data.personal_organization_id).toMatch(/^org_[a-z0-9]{21}$/);
    });

    it('should return is_mfa_enabled true after MFA enroll and false after revoke', async () => {
      // MFA enrollment requires a verified email (account pre-hijacking guard).
      const user = await createTestUser({ isEmailVerified: true });
      const { token, sessionPublicId } = await generateTestTokenAndSession({
        userId: user.public_id,
      });
      await seedRecentStepUpForTestUser(user.public_id, sessionPublicId);

      const meBefore = await getMeWithRetry(app, token);
      expect(meBefore.statusCode).toBe(200);
      const meBeforeBody = meBefore.json() as {
        data: { is_mfa_enabled: boolean };
      };
      expect(meBeforeBody.data.is_mfa_enabled).toBe(false);

      const enrollResponse = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/me/mfa/enroll'),
        token,
        payload: { method_type: 'MFA_TOTP' },
      });
      expect(enrollResponse.statusCode).toBe(200);
      const enrollBody = enrollResponse.json() as { data: { secret: string } };
      const confirmResponse = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/auth/me/mfa/enroll/confirm'),
        token,
        payload: {
          code: await generateTotp({ secret: enrollBody.data.secret }),
        },
      });
      expect(confirmResponse.statusCode).toBe(200);
      // route-#10: the serializer returns `mfa_method_id` and DELETE /auth/me/mfa/{mfa_method_id}
      // now accepts that opaque public id directly (the bigserial id is never exposed).
      const confirmBody = confirmResponse.json() as {
        data: { mfa_method_id: string };
      };
      const methodPublicId = confirmBody.data.mfa_method_id;
      expect(typeof methodPublicId).toBe('string');
      expect(methodPublicId).toMatch(/^am_[a-z0-9]{21}$/);

      const meAfterEnroll = await getMeWithRetry(app, token);
      expect(meAfterEnroll.statusCode).toBe(200);
      const meAfterEnrollBody = meAfterEnroll.json() as {
        data: { is_mfa_enabled: boolean };
      };
      expect(meAfterEnrollBody.data.is_mfa_enabled).toBe(true);

      await seedRecentStepUpForTestUser(user.public_id, sessionPublicId);

      const deleteResponse = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath(`/auth/me/mfa/${methodPublicId}`),
        token,
      });
      expect(deleteResponse.statusCode).toBe(204);

      const meAfterRevoke = await getMeWithRetry(app, token);
      expect(meAfterRevoke.statusCode).toBe(200);
      const meAfterRevokeBody = meAfterRevoke.json() as {
        data: { is_mfa_enabled: boolean };
      };
      expect(meAfterRevokeBody.data.is_mfa_enabled).toBe(false);
    });
  });

  describe('PATCH /api/v1/users/me', () => {
    it('should update name and job_title together (onboarding profile)', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath('/users/me'),
        token,
        payload: { first_name: 'NIK', last_name: 'PATEL', job_title: 'CEO' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: {
          first_name: string | null;
          last_name: string | null;
          job_title: string | null;
        };
      };
      expect(body.data).toMatchObject({
        first_name: 'NIK',
        last_name: 'PATEL',
        job_title: 'CEO',
      });
    });
  });

  describe('Onboarding then account deletion', () => {
    it('completes onboarding, then self-deletes and loses access to the profile', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });

      const onboarding = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/users/me/onboarding/complete'),
        token,
      });
      expect(onboarding.statusCode, onboarding.body).toBe(200);
      expect(
        (onboarding.json() as { data: { onboarding_completed: boolean } }).data
          .onboarding_completed,
      ).toBe(true);

      const deleteResponse = await injectAuthenticated(app, {
        method: 'DELETE',
        url: testApiPath('/users/me'),
        token,
      });
      expect(deleteResponse.statusCode, deleteResponse.body).toBe(204);

      // Soft-delete revokes the session, so the same bearer no longer authenticates.
      const meResponse = await injectAuthenticated(app, {
        url: testApiPath('/users/me'),
        token,
      });
      expect(meResponse.statusCode).toBe(401);
    });
  });
});
