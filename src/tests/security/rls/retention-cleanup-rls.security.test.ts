import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { sql as drizzleSql, and, eq, isNotNull, lt } from 'drizzle-orm';
import { sql } from '@/infrastructure/database/connection.js';
import { database } from '@/infrastructure/database/connection.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';
import { deleteInBatchesByCondition } from '@/infrastructure/database/utils/batch-delete.util.js';
import { webhooks } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import { grantCoreBeAppRoleForTests } from '@/tests/helpers/rls-matrix.helper.js';

async function hasGlobalRetentionCleanupPolicyOnWebhooks(): Promise<boolean> {
  const rows = await sql<{ has_policy: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'notify'
        AND tablename = 'webhooks'
        AND policyname = 'webhooks_tenant_isolation'
        AND qual::text LIKE '%global_retention_cleanup%'
    ) AS has_policy
  `;
  return rows[0]?.has_policy === true;
}

describe('Security: retention cleanup RLS', () => {
  let migrationApplied = false;

  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
    migrationApplied = await hasGlobalRetentionCleanupPolicyOnWebhooks();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('hard-deletes tombstoned webhooks under core_be_app when global_retention_cleanup is set', async () => {
    if (!migrationApplied) {
      console.warn(
        'Skipping retention RLS test: apply migrations/00000000000000_init.sql (defines the global_retention_cleanup RLS policies)',
      );
      return;
    }

    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 60);
    const tombstoneDeletedAt = new Date(cutoffDate);
    tombstoneDeletedAt.setDate(tombstoneDeletedAt.getDate() - 1);

    const tombstonedWebhook = await createTestWebhook({
      organizationId: organization.id,
      isEnabled: false,
    });
    await database
      .update(webhooks)
      .set({ deleted_at: tombstoneDeletedAt })
      .where(eq(webhooks.id, tombstonedWebhook.id));

    const withoutRetentionGuc = await database.transaction(async (transaction) => {
      const databaseHandle = transaction as unknown as RequestScopedPostgresDatabase;
      await databaseHandle.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
      return deleteInBatchesByCondition({
        databaseHandle,
        table: webhooks,
        idColumn: webhooks.id,
        whereCondition: and(isNotNull(webhooks.deleted_at), lt(webhooks.deleted_at, cutoffDate))!,
        logContext: 'retention-cleanup-rls-test-without-guc',
        tableLabel: 'notify.webhooks',
      });
    });

    expect(withoutRetentionGuc.deletedCount).toBe(0);

    const withRetentionGuc = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      async (databaseHandle) =>
        deleteInBatchesByCondition({
          databaseHandle,
          table: webhooks,
          idColumn: webhooks.id,
          whereCondition: and(isNotNull(webhooks.deleted_at), lt(webhooks.deleted_at, cutoffDate))!,
          logContext: 'retention-cleanup-rls-test-with-guc',
          tableLabel: 'notify.webhooks',
        }),
      { useApplicationDatabaseRole: true },
    );

    expect(withRetentionGuc.deletedCount).toBe(1);

    const remainingAfterRetentionDelete = await database
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(and(isNotNull(webhooks.deleted_at), lt(webhooks.deleted_at, cutoffDate)));
    expect(remainingAfterRetentionDelete).toHaveLength(0);
  });
});
