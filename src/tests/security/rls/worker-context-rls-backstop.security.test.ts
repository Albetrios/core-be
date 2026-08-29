import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql as drizzleSql, eq } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import { notifications } from '@/domains/notify/sub-domains/notification/notification.schema.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { grantCoreBeAppRoleForTests } from '@/tests/helpers/rls-matrix.helper.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

/**
 * Worker context RLS backstop.
 *
 * Workers run without the HTTP tenant middleware and establish their own organization
 * context via {@link withAppDatabaseContext} (the real wrapper used by every tenant-scoped
 * job). `worker-tenant-isolation.security.test.ts` proves the repository layer scopes by
 * `organizationPublicId`; this proves the LAST line of defense: even a raw query run inside
 * `withAppDatabaseContext(PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organizationB })` cannot read or mutate organizationA's rows), because the wrapper sets
 * the `app.current_organization_public_id` GUC and RLS engages.
 *
 * The production worker connects as the non-bypass `core_be_app` role; the test connection is
 * the RLS-exempt `core` superuser, so each callback issues `SET LOCAL ROLE core_be_app` to
 * reproduce production faithfully (the wrapper has already set the organization GUC for the transaction).
 */
describe('Security: worker context RLS backstop (wrong-organization context cannot reach another tenant)', () => {
  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  async function seedOrganizationNotification(
    organizationInternalId: number,
    userInternalId: number,
  ): Promise<number> {
    const [row] = await database
      .insert(notifications)
      .values({
        public_id: generatePublicId('organization'),
        user_id: userInternalId,
        organization_id: organizationInternalId,
        type: 'security.worker-backstop',
        title: 'Tenant A notification',
        message: 'RLS backstop probe',
        data: { channels: ['in_app'] },
      })
      .returning({ id: notifications.id });
    return row!.id;
  }

  it('a raw SELECT under withAppDatabaseContext(PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organizationB }) cannot see organizationA rows', async () => {
    const user = await createTestUser();
    const organizationA = await createTestOrganization({ ownerUserId: user.id });
    const organizationB = await createTestOrganization({ ownerUserId: user.id });
    const notificationId = await seedOrganizationNotification(organizationA.id, user.id);

    // Wrong context: a worker scoped to organization B raw-queries organization A's row.
    const visibleUnderB = await withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organizationB.public_id }),
      async (handle) => {
        await handle.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
        return handle
          .select({ id: notifications.id })
          .from(notifications)
          .where(eq(notifications.id, notificationId));
      },
    );
    expect(visibleUnderB).toHaveLength(0);

    // Correct context: a worker scoped to organization A sees its own row — proves the wrapper actually
    // set the organization GUC (so the empty result above is RLS isolation, not a broken query).
    const visibleUnderA = await withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organizationA.public_id }),
      async (handle) => {
        await handle.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
        return handle
          .select({ id: notifications.id })
          .from(notifications)
          .where(eq(notifications.id, notificationId));
      },
    );
    expect(visibleUnderA).toHaveLength(1);
  });

  it('a raw UPDATE under withAppDatabaseContext(PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organizationB }) cannot mutate organizationA rows', async () => {
    const user = await createTestUser();
    const organizationA = await createTestOrganization({ ownerUserId: user.id });
    const organizationB = await createTestOrganization({ ownerUserId: user.id });
    const notificationId = await seedOrganizationNotification(organizationA.id, user.id);

    await withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organizationB.public_id }),
      async (handle) => {
        await handle.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
        await handle
          .update(notifications)
          .set({ title: 'tampered by organization B' })
          .where(eq(notifications.id, notificationId));
      },
    );

    // Re-read as the RLS-exempt superuser: organization A's row is untouched (RLS USING blocked the UPDATE).
    const [row] = await database
      .select({ title: notifications.title })
      .from(notifications)
      .where(eq(notifications.id, notificationId));
    expect(row?.title).toBe('Tenant A notification');
  });
});
