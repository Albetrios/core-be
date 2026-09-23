import { describe, it, expect, beforeEach } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestWebhook } from '@/tests/factories/webhook.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { database } from '@/infrastructure/database/connection.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { webhooks } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import { isPostgresUniqueViolation } from '@/shared/utils/infrastructure/postgres-error.util.js';

function hasUniqueViolation(error: unknown): boolean {
  if (isPostgresUniqueViolation(error)) return true;
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    return hasUniqueViolation((error as { cause: unknown }).cause);
  }
  return false;
}

describe('Integration: database constraints', () => {
  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('should reject duplicate organization slug (23505)', async () => {
    const owner = await createTestUser();
    await database.insert(organizations).values({
      public_id: generatePublicId('organization'),
      name: 'Acme',
      slug: 'duplicate-slug-constraint',
      owner_user_id: owner.id,
      created_by_user_id: owner.id,
    });

    await expect(
      database.insert(organizations).values({
        public_id: generatePublicId('organization'),
        name: 'Other',
        slug: 'duplicate-slug-constraint',
        owner_user_id: owner.id,
        created_by_user_id: owner.id,
      }),
    ).rejects.toSatisfy((error: unknown) => hasUniqueViolation(error));
  });

  it('should reject duplicate webhook public_id (23505)', async () => {
    const organization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    const webhook = await createTestWebhook({ organizationId: organization.id });

    await expect(
      database.insert(webhooks).values({
        public_id: webhook.public_id,
        organization_id: organization.id,
        url: 'https://example.com/hook-duplicate',
        encrypted_secret: 'secret',
        events: ['test'],
        is_enabled: true,
      }),
    ).rejects.toSatisfy((error: unknown) => hasUniqueViolation(error));
  });
});
