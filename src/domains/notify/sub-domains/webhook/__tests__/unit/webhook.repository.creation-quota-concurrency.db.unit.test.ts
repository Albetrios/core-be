import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { WebhookRepository } from '@/domains/notify/sub-domains/webhook/webhook.repository.js';
import { withPrincipalDatabaseContext } from '@/infrastructure/database/contexts/principal-database.context.js';
import { resolveVerifiedOrganizationPrincipalScope } from '@/shared/utils/identity/verified-principal-scope.util.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const CAP = 3;
const CONCURRENT = 8;

/**
 * audit-#8: per-org resource caps must be enforced atomically (advisory lock + count + insert in
 * one transaction). This drives the exact repository sequence the create services use — acquire
 * the per-org creation lock, count, then insert under the cap — concurrently, and asserts the cap
 * is strict. Without the lock, concurrent callers each pass the same count and overshoot.
 */
describe('WebhookRepository creation-quota concurrency (database — audit-#8)', () => {
  const repository = new WebhookRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('never exceeds the per-org cap under concurrent create attempts', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });

    const attempt = (index: number) =>
      withPrincipalDatabaseContext(
        resolveVerifiedOrganizationPrincipalScope(organization.public_id),
        async () => {
          // Mirror the service: lock → count → conditional insert, all in this one transaction.
          await repository.acquireCreationQuotaLock(organization.id);
          const activeCount = await repository.countActiveByOrganization(organization.id);
          if (activeCount >= CAP) {
            throw new Error('cap_reached');
          }
          return repository.create({
            organization_id: organization.id,
            url: `https://example.com/hook-${index}`,
            encrypted_secret: 'secret',
            events: ['webhook.test'],
            is_enabled: true,
            created_by_user_id: user.id,
          });
        },
      );

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT }, (_value, index) => attempt(index)),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(CAP);

    const finalCount = await withPrincipalDatabaseContext(
      resolveVerifiedOrganizationPrincipalScope(organization.public_id),
      () => repository.countActiveByOrganization(organization.id),
    );
    expect(finalCount).toBe(CAP);
  });
});
