import { afterEach, describe, expect, it } from 'vitest';
import { SubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import { createWorkerSubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import { WorkerDatabaseContextError } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { withPrincipalDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';
import { resolveVerifiedOrganizationPrincipalScope } from '@/shared/utils/identity/verified-principal-scope.util.js';

describe('Security: worker RLS database context', () => {
  const originalRuntime = process.env.CORE_BE_RUNTIME;

  afterEach(async () => {
    if (originalRuntime === undefined) {
      delete process.env.CORE_BE_RUNTIME;
    } else {
      process.env.CORE_BE_RUNTIME = originalRuntime;
    }
    await cleanupDatabase();
  });

  it('throws when SubscriptionRepository is used in worker runtime without a pinned context', async () => {
    process.env.CORE_BE_RUNTIME = 'worker';
    const repository = new SubscriptionRepository();

    await expect(repository.listByOrganization(1)).rejects.toThrow(WorkerDatabaseContextError);
  });

  it('allows tenant-scoped reads when wrapped in withPrincipalDatabaseContext and createWorkerSubscriptionRepository', async () => {
    process.env.CORE_BE_RUNTIME = 'worker';
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    await withPrincipalDatabaseContext(
      resolveVerifiedOrganizationPrincipalScope(organization.public_id),
      async (databaseHandle) => {
        const repository = createWorkerSubscriptionRepository(databaseHandle);
        const rows = await repository.listByOrganization(organization.id);
        expect(Array.isArray(rows)).toBe(true);
      },
    );
  });
});
