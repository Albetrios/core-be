import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
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
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';
import { database } from '@/infrastructure/database/connection.js';
import { auth_methods } from '@/domains/auth/sub-domains/auth-method/auth-method.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * Sensitive-field leakage sweep.
 *
 * No API response may serialize a secret/hash column. We assert the raw response
 * body (stringified) contains none of the forbidden field names, across the
 * endpoints that return user-, session-, and organization-scoped resources. This is the
 * regression guard against a serializer (or a missing serializer) leaking
 * credential material.
 */
const FORBIDDEN_FIELDS = [
  'password_hash',
  'token_hash',
  'refresh_token_hash',
  'key_hash',
  'encrypted_secret',
  'email_hash',
  'recovery_codes',
  'mfa_secret',
  'totp_secret',
  // Storage-internal fields — the client uses presigned URLs, never the raw key.
  'file_key',
  'fileKey',
  'bucket',
];

function expectNoSensitiveFields(body: string): void {
  for (const field of FORBIDDEN_FIELDS) {
    expect(body, `response leaked "${field}"`).not.toContain(field);
  }
}

describe('Security: sensitive-field leakage sweep', () => {
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
    await seedPermissions(['webhook:read', 'webhook:manage', 'api-key:read', 'api-key:manage']);
  });

  async function userWithToken() {
    const user = await createTestUser();
    const token = await generateTestToken({ userId: user.public_id });
    return { user, token };
  }

  it('GET /auth/me/sessions does not leak token hashes', async () => {
    const { token } = await userWithToken();
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/sessions'),
      token,
    });
    expect(response.statusCode).toBe(200);
    expectNoSensitiveFields(response.body);
  });

  it('GET /auth/me/auth-methods does not leak the encrypted TOTP secret or PII', async () => {
    const { user, token } = await userWithToken();
    // Seed a TOTP method carrying credential material + PII that must never be serialized.
    await database.insert(auth_methods).values({
      public_id: generatePublicId('user'),
      user_id: user.id,
      method_type: 'MFA_TOTP',
      encrypted_secret: 'leaked-totp-seed-ciphertext',
      phone_number: '+15557654321',
      provider_user_id: 'oauth-sub-leak',
      is_primary: true,
      verified_at: new Date(),
    });

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/auth/me/auth-methods'),
      token,
    });

    expect(response.statusCode).toBe(200);
    expectNoSensitiveFields(response.body);
    // PII must not leak either (not in the shared secret list, asserted explicitly here).
    expect(response.body).not.toContain('leaked-totp-seed-ciphertext');
    expect(response.body).not.toContain('+15557654321');
    expect(response.body).not.toContain('provider_user_id');
    expect(response.body).not.toContain('oauth-sub-leak');
    // Sanity: the method itself is still returned (not an empty/over-stripped response).
    expect(response.body).toContain('MFA_TOTP');
  });

  it('GET /users/me does not leak password/email hashes', async () => {
    const { token } = await userWithToken();
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/users/me'),
      token,
    });
    expect(response.statusCode).toBe(200);
    expectNoSensitiveFields(response.body);
  });

  it('GET organization webhooks does not leak the encrypted secret', async () => {
    const { user } = await userWithToken();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ['webhook:read', 'webhook:manage'],
    });
    await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });
    await createTestWebhook({ organizationId: organization.id });

    // Flat webhook route resolves the organization from the JWT `org` claim, so
    // mint a bearer scoped to this organization (the userWithToken bearer carries no claim).
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/notify/webhooks'),
      token,
    });
    expect(response.statusCode).toBe(200);
    expectNoSensitiveFields(response.body);
  });

  it('GET /uploads/:publicId does not leak the internal storage key or bucket', async () => {
    const { token } = await userWithToken();
    const createResponse = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/uploads'),
      token,
      payload: {
        purpose: 'avatar',
        for: 'user',
        content_type: 'image/png',
        file_name: 'avatar.png',
        file_size: 1024,
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const publicId = (createResponse.json() as { data: { id: string } }).data.id;

    const detailResponse = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath(`/uploads/${publicId}`),
      token,
    });
    expect(detailResponse.statusCode).toBe(200);
    expectNoSensitiveFields(detailResponse.body);
  });
});
