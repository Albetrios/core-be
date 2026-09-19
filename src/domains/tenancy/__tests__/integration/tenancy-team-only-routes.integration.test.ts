import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
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
  seedAllPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/**
 * Four tenancy routes are `O = team` in `docs/routes.txt` — they must answer **422** on a PERSONAL
 * organization. Two of them (`POST /organization/memberships`, `POST /organization/roles`) already
 * pair a 422 with a TEAM success. The other two — `DELETE /organization` and
 * `POST /organization/transfer-ownership` — had no route-level assertion at all; the guard was
 * covered only generically by `organization-capability.unit`, which tests the helper function in
 * isolation and cannot tell whether a route actually calls it.
 *
 * That gap is load-bearing. A PERSONAL organization is the user's own account workspace: deleting it
 * out from under the account, or handing it to a different user, are both states the rest of the
 * system does not model. Each 422 below is paired with its TEAM twin so the test proves the guard
 * discriminates rather than simply refusing everything.
 *
 * Also covers the domain's missing **415** assertion (Part 5 gap 9) — no tenancy route asserted a
 * wrong-content-type rejection anywhere.
 */

const ALL_TENANCY_PERMISSIONS = Object.values(TENANCY_PERMISSIONS);

type ErrorBody = { error?: { code?: string; detail?: string } };

describe('Tenancy team-only route guards — Integration', () => {
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
    await seedAllPermissions();
  });

  /**
   * Builds an organization of the requested type with the caller as owner and full tenancy
   * permissions. A user may hold only one PERSONAL organization (`idx_organizations_personal_owner`), so
   * each case creates its own user.
   */
  async function createOwnedOrganization(type: 'PERSONAL' | 'TEAM') {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id, type });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes: ALL_TENANCY_PERMISSIONS,
    });
    await createMembership({
      userId: user.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });
    return { user, organization, role, token };
  }

  /** Adds a second ACTIVE member so ownership has somewhere to go. */
  async function addSecondMember(organizationId: number, roleId: number) {
    const member = await createTestUser();
    await createMembership({ userId: member.id, organizationId, roleId });
    return member;
  }

  describe('DELETE /api/v1/tenancy/organization', () => {
    it('refuses to delete a PERSONAL organization with 422', async () => {
      const { token } = await createOwnedOrganization('PERSONAL');
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'DELETE',
        url: testApiPath('/tenancy/organization'),
        token,
      });

      expect(response.statusCode).toBe(422);
      const body = response.json() as ErrorBody;
      expect(body.error?.code).toBe('unprocessable_entity');
    });

    it('still deletes a TEAM organization with 204 (the guard discriminates on type, not on the route)', async () => {
      const { token } = await createOwnedOrganization('TEAM');
      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'DELETE',
        url: testApiPath('/tenancy/organization'),
        token,
      });
      expect(response.statusCode).toBe(204);
    });

    it('leaves the PERSONAL organization readable after the refused delete', async () => {
      // A 422 that had already marked the row deleted would still read as a clean refusal at the
      // response layer — assert the organization survives.
      const { token } = await createOwnedOrganization('PERSONAL');
      await injectAuthenticatedOrganizationMutation(app, {
        method: 'DELETE',
        url: testApiPath('/tenancy/organization'),
        token,
      });

      const read = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization'),
        token,
      });
      expect(read.statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/tenancy/organization/transfer-ownership', () => {
    it('refuses to transfer a PERSONAL organization with 422', async () => {
      const personal = await createOwnedOrganization('PERSONAL');
      const recipient = await addSecondMember(personal.organization.id, personal.role.id);

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/transfer-ownership'),
        token: personal.token,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { new_owner_user_id: recipient.public_id },
      });

      expect(response.statusCode).toBe(422);
      const body = response.json() as ErrorBody;
      expect(body.error?.code).toBe('unprocessable_entity');
    });

    it('transfers a TEAM organization to an active member with 200', async () => {
      const team = await createOwnedOrganization('TEAM');
      const recipient = await addSecondMember(team.organization.id, team.role.id);

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/transfer-ownership'),
        token: team.token,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { new_owner_user_id: recipient.public_id },
      });

      expect(response.statusCode).toBe(200);
    });

    it('runs the PERSONAL guard before the owner check — a non-owner also gets 422, not 403', async () => {
      // Ordering matters: the type guard is evaluated first, so a PERSONAL organization never leaks
      // "you are not the owner" (which would confirm the organization exists and has a different owner).
      const personal = await createOwnedOrganization('PERSONAL');
      const outsider = await addSecondMember(personal.organization.id, personal.role.id);
      const outsiderToken = await generateTestToken({
        userId: outsider.public_id,
        organizationPublicId: personal.organization.public_id,
      });

      const response = await injectAuthenticatedOrganizationMutation(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/transfer-ownership'),
        token: outsiderToken,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { new_owner_user_id: personal.user.public_id },
      });

      expect(response.statusCode).toBe(422);
    });
  });

  describe('prototype poisoning', () => {
    it('rejects a __proto__ key from the body without polluting Object.prototype', async () => {
      // Found by the new tenancy property suite: Zod's `.strict()` does NOT treat `__proto__` as an
      // unrecognized key — `roleIdParamsDto.safeParse({ role_id, ['__proto__']: 'x' })` succeeds
      // where any other extra key fails, and that holds for objects produced by `JSON.parse` too.
      // So `.strict()` is not what protects these routes from a poisoned body.
      //
      // Newer Fastify/Zod parsing rejects the poisoned body before update handling. Keep this
      // pinned so dependency updates cannot silently downgrade prototype-poisoning protection.
      const { token } = await createOwnedOrganization('TEAM');
      const response = await app.inject({
        method: 'PATCH',
        url: testApiPath('/tenancy/organization'),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: '{"name":"Poisoned","__proto__":{"admin":true}}',
      });

      expect(response.statusCode).toBe(400);
      // Nothing was grafted onto Object.prototype.
      expect(({} as Record<string, unknown>).admin).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty('admin');
    });
  });

  describe('content-type handling (415)', () => {
    it('rejects an unparseable content type on PATCH /tenancy/organization with 415', async () => {
      const { token } = await createOwnedOrganization('TEAM');
      const response = await app.inject({
        method: 'PATCH',
        url: testApiPath('/tenancy/organization'),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/xml',
        },
        payload: '<organization><name>Updated</name></organization>',
      });
      expect(response.statusCode).toBe(415);
    });

    it('answers 400, not 415, for text/plain — Fastify parses it, so the body fails schema instead', async () => {
      // Recorded as a contrast so the 415 above is not mistaken for "any non-JSON type". Fastify
      // ships a built-in `text/plain` parser, so such a request gets past content-type negotiation
      // and is rejected by the route schema. Both are correct; they are different refusals.
      const { token } = await createOwnedOrganization('TEAM');
      const response = await app.inject({
        method: 'PATCH',
        url: testApiPath('/tenancy/organization'),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'text/plain',
        },
        payload: 'name=Updated',
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a non-JSON content type on POST /tenancy/organizations with 415', async () => {
      const user = await createTestUser();
      const token = await generateTestToken({ userId: user.public_id });
      const response = await app.inject({
        method: 'POST',
        url: testApiPath('/tenancy/organizations'),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/xml',
          'x-idempotency-key': `idem-${randomUUID()}`,
        },
        payload: '<organization><name>Acme</name></organization>',
      });
      expect(response.statusCode).toBe(415);
    });
  });
});
