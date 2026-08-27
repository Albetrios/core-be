import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql as drizzleSql, eq } from 'drizzle-orm';
import { sql } from '@/infrastructure/database/connection.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
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
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { database } from '@/infrastructure/database/connection.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/**
 * RLS session variable + HTTP tenant header alignment (FORCE ROW LEVEL SECURITY migrations).
 */
describe('Security: Organization RLS session', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await sql`GRANT core_be_app TO CURRENT_USER`.catch(() => undefined);
    const testApp = await createTestApp();
    app = testApp.app;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedPermissions([TENANCY_PERMISSIONS.ORGANIZATION_READ]);
  });

  it('should hide other tenants when app.current_organization_public_id is set in a transaction', async () => {
    const forceRlsRows = await sql<{ relforcerowsecurity: boolean }[]>`
      SELECT c.relforcerowsecurity
      FROM pg_class c
      INNER JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'tenancy' AND c.relname = 'organizations'
    `;
    expect(
      forceRlsRows[0]?.relforcerowsecurity,
      'Apply migrations including 20260516000006_force_row_level_security.sql',
    ).toBe(true);
    const ownerA = await createTestUser();
    const ownerB = await createTestUser();
    const organizationA = await createTestOrganization({ ownerUserId: ownerA.id });
    const organizationB = await createTestOrganization({ ownerUserId: ownerB.id });

    await database.transaction(async (transaction) => {
      await transaction.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
      await transaction.execute(
        drizzleSql`SELECT set_config('app.current_organization_public_id', ${organizationA.public_id}, true)`,
      );
      const rows = await transaction
        .select({ public_id: organizations.public_id })
        .from(organizations)
        .where(eq(organizations.public_id, organizationB.public_id));
      expect(rows).toHaveLength(0);
    });
  });

  it('should return 200 when the org claim resolves the active organization', async () => {
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
    // Flat organization route resolves the active org from the JWT `org` claim,
    // which drives the RLS GUC (`app.current_organization_public_id`) for the request.
    const token = await generateTestToken({
      userId: user.public_id,
      organizationPublicId: organization.public_id,
    });

    const response = await injectAuthenticated(app, {
      method: 'GET',
      url: testApiPath('/tenancy/organization'),
      token,
    });

    expect(response.statusCode).toBe(200);
  });
});
