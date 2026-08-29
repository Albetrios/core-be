import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectAuthenticatedOrganizationMutation,
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
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * Mass-assignment / over-posting security tests.
 *
 * Every mutating DTO in the codebase is declared `.strict()`, so a request that
 * includes a server-owned / privileged field (ownership, identity, foreign keys,
 * audit columns, provider-managed status) must be rejected at validation — it
 * must NEVER reach the service and silently set that field. These tests are the
 * regression guard for that invariant.
 *
 * Every mutating request carries an `X-Idempotency-Key` header so the request
 * reaches DTO validation (routes with `idempotencyRequired` otherwise short-
 * circuit with 422 for a missing key, which would mask the actual check). With
 * the key present, the only rejection reason is the strict DTO catching the
 * forbidden field — the security property under test.
 */
const TENANCY_PERMISSIONS = {
  ORGANIZATION_UPDATE: 'organization:update',
  WEBHOOK_MANAGE: 'webhook:manage',
} as const;

const ADMIN_PERMISSIONS = Object.values(TENANCY_PERMISSIONS);

function idempotent(): { 'x-idempotency-key': string } {
  return { 'x-idempotency-key': generatePublicId('organization') };
}

function expectRejected(statusCode: number): void {
  // Strict DTOs reject unknown keys with 400; some layers surface 422. The
  // invariant is simply: the over-post never succeeds.
  expect(statusCode).not.toBe(200);
  expect(statusCode).not.toBe(200);
  expect(statusCode).not.toBe(204);
  expect([400, 422]).toContain(statusCode);
}

describe('Security: mass-assignment / over-posting', () => {
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
    await seedPermissions(ADMIN_PERMISSIONS);
  });

  /** Creates a user who is an admin member (organization-update + webhook-manage) of a fresh organization. */
  async function createOrgAdminContext() {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ADMIN_PERMISSIONS,
    });
    await createMembership({ userId: user.id, organizationId: organization.id, roleId: role.id });
    // Scope the bearer to this organization via the `org` claim. Flat webhook routes
    // resolve the organization from the claim (no organization path param); for the nested
    // organization-settings route the claim simply matches the path-derived organization. Either
    // way the request reaches DTO validation, where the strict-DTO check runs.
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, organization, token };
  }

  // ─── Organization create (POST /tenancy/organizations) ──────────────────────

  describe('POST /api/v1/tenancy/organizations', () => {
    async function createAuthedUserToken(): Promise<string> {
      const user = await createTestUser();
      return generateTestToken({ userId: user.public_id });
    }

    it('baseline: a valid body (with idempotency key) creates the organization (200)', async () => {
      const token = await createAuthedUserToken();
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organizations'),
        token,
        payload: { name: 'Acme Inc', slug: `acme-${generatePublicId('organization').slice(4)}` },
        headers: idempotent(),
      });
      expect(response.statusCode).toBe(200);
    });

    it('rejects an injected public_id (server generates identity)', async () => {
      const token = await createAuthedUserToken();
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organizations'),
        token,
        payload: {
          name: 'Acme Inc',
          slug: `acme-${generatePublicId('organization').slice(4)}`,
          public_id: 'attacker',
        },
        headers: idempotent(),
      });
      expectRejected(response.statusCode);
    });

    it('rejects an injected owner_user_id (ownership is server-set)', async () => {
      const token = await createAuthedUserToken();
      const otherUser = await createTestUser();
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organizations'),
        token,
        payload: {
          name: 'Acme Inc',
          slug: `acme-${generatePublicId('organization').slice(4)}`,
          owner_user_id: otherUser.public_id,
        },
        headers: idempotent(),
      });
      expectRejected(response.statusCode);
    });

    it('rejects injected audit/timestamp columns', async () => {
      const token = await createAuthedUserToken();
      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organizations'),
        token,
        payload: {
          name: 'Acme Inc',
          slug: `acme-${generatePublicId('organization').slice(4)}`,
          created_by_user_id: 1,
          created_at: '2000-01-01T00:00:00.000Z',
          deleted_at: null,
        },
        headers: idempotent(),
      });
      expectRejected(response.statusCode);
    });
  });

  // ─── Organization update (PATCH /tenancy/organization) ──────────────────────

  describe('PATCH /api/v1/tenancy/organization', () => {
    it('rejects an injected owner_user_id (no privilege transfer via update)', async () => {
      const { token } = await createOrgAdminContext();
      const otherUser = await createTestUser();
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: testApiPath('/tenancy/organization'),
        token,
        payload: { name: 'Renamed', owner_user_id: otherUser.public_id },
        headers: idempotent(),
      });
      expectRejected(response.statusCode);
    });

    it('rejects an injected public_id (identity is immutable)', async () => {
      const { token } = await createOrgAdminContext();
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: testApiPath('/tenancy/organization'),
        token,
        payload: { public_id: 'attacker-controlled' },
        headers: idempotent(),
      });
      expectRejected(response.statusCode);
    });

    it('rejects an injected stripe_customer_id (billing-owned field)', async () => {
      const { token } = await createOrgAdminContext();
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: testApiPath('/tenancy/organization'),
        token,
        payload: { stripe_customer_id: 'cus_attacker' },
        headers: idempotent(),
      });
      expectRejected(response.statusCode);
    });
  });

  // ─── Organization settings (PATCH /tenancy/organization/settings) ───────────

  describe('PATCH /api/v1/tenancy/organization/settings', () => {
    it('rejects an injected organization_id (tenant binding is from the token claim)', async () => {
      const { token } = await createOrgAdminContext();
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'PATCH',
        url: testApiPath('/tenancy/organization/settings'),
        token,
        payload: { organization_id: 999_999 },
        headers: idempotent(),
      });
      expectRejected(response.statusCode);
    });
  });

  // ─── Webhook create (POST /notify/webhooks) ──────────────────────────────────

  describe('POST /api/v1/notify/webhooks', () => {
    it('rejects an injected organization_id (cross-tenant binding attempt)', async () => {
      const { token } = await createOrgAdminContext();
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/notify/webhooks'),
        token,
        payload: {
          url: 'https://example.com/hook',
          events: ['billing.subscription.updated'],
          organization_id: 999_999,
        },
        headers: idempotent(),
      });
      expectRejected(response.statusCode);
    });

    it('rejects an injected encrypted_secret (server encrypts the plaintext secret)', async () => {
      const { token } = await createOrgAdminContext();
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/notify/webhooks'),
        token,
        payload: {
          url: 'https://example.com/hook',
          events: ['billing.subscription.updated'],
          encrypted_secret: 'pre-encrypted-by-attacker',
        },
        headers: idempotent(),
      });
      expectRejected(response.statusCode);
    });
  });

  // ─── Self update (PATCH /users/me) ──────────────────────────────────────────

  describe('PATCH /api/v1/users/me', () => {
    it('rejects an injected status (account status is not self-settable)', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath('/users/me'),
        token,
        payload: { status: 'SUPER_ADMIN' },
        headers: idempotent(),
      });
      expectRejected(response.statusCode);
    });

    it('rejects injected identity/security columns (public_id, email_hash, is_mfa_enabled)', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await injectAuthenticated(app, {
        method: 'PATCH',
        url: testApiPath('/users/me'),
        token,
        payload: { public_id: 'attacker', email_hash: 'x', is_mfa_enabled: false },
        headers: idempotent(),
      });
      expectRejected(response.statusCode);
    });
  });
});
