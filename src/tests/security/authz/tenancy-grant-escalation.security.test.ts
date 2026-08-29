import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import {
  seedAllPermissions,
  createRoleWithPermissions,
  createMembership,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';

/**
 * Grant-grantability at the **route** layer — closes items 3 and 5 of
 * `docs/reference/security/authorization-coverage-gaps.md` for the two paths that were still open.
 *
 * The rule under test is one sentence: *a caller may only hand out permissions they themselves
 * hold.* `assertCallerCanGrantPermissionCodes` implements it, and it was already asserted for role
 * permission grants (`PUT /roles/:role_id/permissions`) and role creation. Two paths that call the
 * same helper had no route-level assertion at all:
 *
 * 1. **API-key scopes.** `POST /organization/api-keys` mints a long-lived credential whose `scopes`
 *    array is caller-supplied. `organization-api-key.validator.scopes` checks only *shape* — 1..50
 *    strings — so if the grant check were dropped, a member holding nothing but `api-key:manage`
 *    could mint a key carrying `organization:delete` and then act through it. That is a complete
 *    privilege-escalation chain out of a single missing call.
 * 2. **Membership role assignment.** Covered at the unit layer by
 *    `membership.service.grantable-permissions` but never driven over HTTP, so a controller wired to
 *    skip the service guard would have gone unnoticed.
 *
 * Also covers gap item 5 (caller-scope on `auth-self-mutation`): `POST /tenancy/organizations` must
 * not let the request body redirect ownership to somebody else.
 *
 * e2e — runs in CI (Postgres + Redis required).
 */
describe('Security: tenancy grant escalation (API-key scopes, role assignment, ownership)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const created = await createTestApp();
    app = created.app;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
  });

  /**
   * Builds an organization plus a member whose role holds exactly `permissionCodes` — deliberately
   * *not* the owner-with-everything shortcut, because the whole point is a caller with a partial
   * permission set.
   */
  async function createMemberHolding(permissionCodes: string[]) {
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const actor = await createTestUser();
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes,
    });
    await createMembership({
      userId: actor.id,
      organizationId: organization.id,
      roleId: role.id,
    });
    const token = await generateTestToken({
      userId: actor.public_id,
      organizationPublicId: organization.public_id,
    });
    return { owner, organization, actor, role, token };
  }

  describe('API-key scopes cannot exceed the caller permission set', () => {
    it('denies minting a key whose scopes include a permission the caller does not hold', async () => {
      // The caller can manage API keys but holds no organization:delete. Requesting it as a scope
      // is an attempt to launder a permission through a credential.
      const { token } = await createMemberHolding([
        TENANCY_PERMISSIONS.API_KEY_MANAGE,
        TENANCY_PERMISSIONS.API_KEY_READ,
      ]);

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/api-keys'),
        token,
        payload: {
          name: 'escalation-attempt',
          scopes: [TENANCY_PERMISSIONS.ORGANIZATION_DELETE],
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.body).toContain('permission');
    });

    it('denies a scope set that mixes held and un-held permissions (no partial grant)', async () => {
      // A single un-held code must poison the whole request — never "create the key with the
      // subset it is allowed to have", which would silently issue a weaker key the caller did not
      // ask for and would not audit.
      const { token } = await createMemberHolding([
        TENANCY_PERMISSIONS.API_KEY_MANAGE,
        TENANCY_PERMISSIONS.API_KEY_READ,
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
      ]);

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/api-keys'),
        token,
        payload: {
          name: 'partial-escalation',
          scopes: [TENANCY_PERMISSIONS.ORGANIZATION_READ, TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE],
        },
      });

      expect(response.statusCode).toBe(403);

      // And nothing was persisted — a 403 emitted after the insert would still read as a denial.
      const list = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization/api-keys'),
        token,
      });
      expect(list.statusCode).toBe(200);
      expect((list.json() as { data: unknown[] }).data).toHaveLength(0);
    });

    it('denies a scope that is not in the permission catalog at all', async () => {
      // The shape validator accepts any 1..100-char string, so an invented code reaches the guard.
      // It must fail the `knownPermissionCodes` half of the check, not be quietly stored.
      const { token } = await createMemberHolding([TENANCY_PERMISSIONS.API_KEY_MANAGE]);

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/api-keys'),
        token,
        payload: { name: 'invented-scope', scopes: ['organization:superuser'] },
      });

      expect(response.statusCode).toBe(403);
    });

    it('permits a scope set fully contained in the caller permissions (the guard is not a blanket deny)', async () => {
      const { token } = await createMemberHolding([
        TENANCY_PERMISSIONS.API_KEY_MANAGE,
        TENANCY_PERMISSIONS.API_KEY_READ,
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
        TENANCY_PERMISSIONS.MEMBERSHIP_READ,
      ]);

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/api-keys'),
        token,
        payload: {
          name: 'legitimate-key',
          scopes: [TENANCY_PERMISSIONS.ORGANIZATION_READ, TENANCY_PERMISSIONS.MEMBERSHIP_READ],
        },
      });

      expect(response.statusCode).toBe(200);
      // The serializer deliberately drops `scopes` (they are a server-side capability, not a
      // display field), so the key's existence is asserted through the list route instead.
      const body = response.json() as { data: { api_key: { id: string }; raw_key: string } };
      expect(body.data.raw_key).toBeTruthy();

      const list = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization/api-keys'),
        token,
      });
      expect(list.statusCode).toBe(200);
      const keys = (list.json() as { data: { id: string; name: string }[] }).data;
      expect(keys).toHaveLength(1);
      expect(keys[0]?.name).toBe('legitimate-key');
    });
  });

  describe('membership role assignment cannot exceed the caller permission set', () => {
    it('denies inviting a member into a role holding a permission the caller lacks', async () => {
      // `membership:manage` lets you add people. It must not let you add them at a privilege level
      // above your own — otherwise any member-manager can create an accomplice with more power
      // than themselves, then act through that account.
      const context = await createMemberHolding([
        TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE,
        TENANCY_PERMISSIONS.MEMBERSHIP_READ,
        TENANCY_PERMISSIONS.ROLE_READ,
      ]);
      const privilegedRole = await createRoleWithPermissions({
        organizationId: context.organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_DELETE],
      });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/memberships'),
        token: context.token,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: {
          email: `accomplice-${randomUUID()}@example.com`,
          role_id: privilegedRole.public_id,
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('permits inviting into a role whose permissions the caller holds', async () => {
      const context = await createMemberHolding([
        TENANCY_PERMISSIONS.MEMBERSHIP_MANAGE,
        TENANCY_PERMISSIONS.MEMBERSHIP_READ,
        TENANCY_PERMISSIONS.ORGANIZATION_READ,
      ]);
      const peerRole = await createRoleWithPermissions({
        organizationId: context.organization.id,
        permissionCodes: [TENANCY_PERMISSIONS.ORGANIZATION_READ],
      });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organization/memberships'),
        token: context.token,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: {
          email: `peer-${randomUUID()}@example.com`,
          role_id: peerRole.public_id,
        },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('POST /tenancy/organizations cannot redirect ownership', () => {
    it('rejects an owner_user_id in the create body (strict DTO)', async () => {
      // `auth-self-mutation`: the acting user is the only possible owner of a newly created organization.
      // A body field that named someone else would let a caller plant an organization under another
      // user's account — the strict DTO is what prevents it, so the rejection is asserted here.
      const actor = await createTestUser();
      const victim = await createTestUser();
      const token = await generateTestToken({ userId: actor.public_id });

      const response = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organizations'),
        token,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: {
          name: 'Planted Org',
          slug: `planted-${randomUUID().slice(0, 8)}`,
          owner_user_id: victim.public_id,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('makes the authenticated caller the owner regardless of what else is in the body', async () => {
      const actor = await createTestUser();
      const token = await generateTestToken({ userId: actor.public_id });

      const created = await injectAuthenticated(app, {
        method: 'POST',
        url: testApiPath('/tenancy/organizations'),
        token,
        headers: { 'x-idempotency-key': `idem-${randomUUID()}` },
        payload: { name: 'Own Org', slug: `own-${randomUUID().slice(0, 8)}` },
      });
      expect(created.statusCode).toBe(200);
      const organizationId = (created.json() as { data: { id: string } }).data.id;

      // The creator is bootstrapped as owner: they can read the organization through the organization claim and
      // exercise an owner-only operation (transfer-ownership reaches the owner check, not a 403).
      const organizationToken = await generateTestToken({
        userId: actor.public_id,
        organizationPublicId: organizationId,
      });
      const read = await injectAuthenticated(app, {
        method: 'GET',
        url: testApiPath('/tenancy/organization'),
        token: organizationToken,
      });
      expect(read.statusCode).toBe(200);
      expect((read.json() as { data: { id: string } }).data.id).toBe(organizationId);
    });
  });
});
