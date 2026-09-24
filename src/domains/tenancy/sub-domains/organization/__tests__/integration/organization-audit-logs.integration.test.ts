import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '@/tests/helpers/test-app.js';
import {
  injectAuthenticated,
  injectUnauthenticated,
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
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { AUDIT_PERMISSIONS } from '@/domains/audit/audit.permissions.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { logs } from '@/domains/audit/audit.schema.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/**
 * `GET /tenancy/organization/audit-logs` was the only tenancy route in the catalog with **no
 * asserted status anywhere in the repository** — 40 of 41 routes had at least one, this one had
 * zero. `organization.controller.unit` covers the handler's delegation and its "audit service not
 * configured" throw, but nothing drove the route.
 *
 * That matters more here than on an ordinary read: the route is permission-gated on
 * `audit-log:read` and returns the tenant's audit trail, so the two ways it can regress are
 * (a) silently returning nothing, and (b) returning another tenant's trail. Both are asserted below,
 * along with the auth/permission denials and the serializer contract that keeps internal bigint ids
 * out of the response.
 */

const AUDIT_LOG_ROUTE = '/tenancy/organization/audit-logs';
const REQUIRED_PERMISSIONS = [
  AUDIT_PERMISSIONS.AUDIT_LOG_READ,
  TENANCY_PERMISSIONS.ORGANIZATION_READ,
];

type AuditLogListBody = {
  data: { id: string; action: string; resource_type: string }[];
  meta?: Record<string, unknown>;
};

describe('GET /api/v1/tenancy/organization/audit-logs — Integration', () => {
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
    await seedPermissions(REQUIRED_PERMISSIONS);
  });

  async function createContext(permissionCodes: string[] = REQUIRED_PERMISSIONS) {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes,
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

  async function writeAuditLog(options: {
    organizationId: number;
    actorUserId: number;
    action: string;
  }) {
    const [row] = await getOperatorDatabase()
      .insert(logs)
      .values({
        organization_id: options.organizationId,
        actor_user_id: options.actorUserId,
        action: options.action,
        resource_type: 'organization',
      })
      .returning();
    return row!;
  }

  it('returns 401 without authentication', async () => {
    const response = await injectUnauthenticated(app, {
      method: 'GET',
      url: testApiPath(AUDIT_LOG_ROUTE),
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 403 for a member without the audit-log:read permission', async () => {
    // The organization read permission alone must not open the audit trail — a regression that widened the
    // preHandler to ORGANIZATION_READ would hand every member the tenant's full history.
    const { token } = await createContext([TENANCY_PERMISSIONS.ORGANIZATION_READ]);
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath(AUDIT_LOG_ROUTE),
      token,
    });
    expect(response.statusCode).toBe(403);
  });

  it('returns 200 with the declared paginated envelope when the trail is empty', async () => {
    const { token } = await createContext();
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath(AUDIT_LOG_ROUTE),
      token,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as AuditLogListBody;
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
    expect(body.meta).toBeDefined();
  });

  it('returns 200 and lists the organization own audit rows', async () => {
    const { organization, user, token } = await createContext();
    await writeAuditLog({
      organizationId: organization.id,
      actorUserId: user.id,
      action: 'organization.updated',
    });
    await writeAuditLog({
      organizationId: organization.id,
      actorUserId: user.id,
      action: 'organization.settings.updated',
    });

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath(AUDIT_LOG_ROUTE),
      token,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as AuditLogListBody;
    expect(body.data).toHaveLength(2);
    expect(body.data.map((entry) => entry.action).sort()).toEqual([
      'organization.settings.updated',
      'organization.updated',
    ]);
  });

  it('never returns another organization audit rows (tenant scoping at the route)', async () => {
    // The regression this exists to catch is a leak, not an error: a handler that dropped the
    // organization filter would still answer 200, just with the wrong tenant's history in it.
    const alpha = await createContext();
    const beta = await createContext();
    await writeAuditLog({
      organizationId: beta.organization.id,
      actorUserId: beta.user.id,
      action: 'beta.only.action',
    });
    await writeAuditLog({
      organizationId: alpha.organization.id,
      actorUserId: alpha.user.id,
      action: 'alpha.only.action',
    });

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath(AUDIT_LOG_ROUTE),
      token: alpha.token,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as AuditLogListBody;
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.action).toBe('alpha.only.action');
    expect(response.body).not.toContain('beta.only.action');
  });

  it('resolves every id to a public id and never emits an internal bigint', async () => {
    // sec-T #4 / sec-re-08: the handler routes rows through `AuditSerializer.many` so the strip-only
    // allowlist replaces each internal bigint with the resolved public id. The contract is a
    // substitution, not a deletion — the keys stay, the values become `<prefix>_<21>`.
    const { organization, user, token } = await createContext();
    const row = await writeAuditLog({
      organizationId: organization.id,
      actorUserId: user.id,
      action: 'organization.updated',
    });

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath(AUDIT_LOG_ROUTE),
      token,
    });
    expect(response.statusCode).toBe(200);
    const [entry] = (response.json() as AuditLogListBody).data as unknown as Record<
      string,
      unknown
    >[];
    expect(entry).toBeDefined();
    expect(entry?.organization_id).toBe(organization.public_id);
    expect(entry?.actor_user_id).toBe(user.public_id);
    // The internal auto-increment id must not surface anywhere in the entry, under any key.
    for (const [key, value] of Object.entries(entry ?? {})) {
      expect(typeof value === 'number', `${key} must not be a raw numeric id`).toBe(false);
    }
    expect(entry?.id).not.toBe(String(row.id));
  });

  it('rejects legacy page-based pagination with 400', async () => {
    // The route mounts `rejectLegacyPagePagination` in preValidation; cursor pagination is the
    // only supported mode and a `?page=` caller must be told so rather than silently paging.
    const { token } = await createContext();
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: `${testApiPath(AUDIT_LOG_ROUTE)}?page=2`,
      token,
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an out-of-range limit with 400', async () => {
    const { token } = await createContext();
    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: `${testApiPath(AUDIT_LOG_ROUTE)}?limit=100000`,
      token,
    });
    expect(response.statusCode).toBe(400);
  });
});
