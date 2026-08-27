import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import { users } from '@/domains/user/user.schema.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import {
  grantCoreBeAppRoleForTests,
  executeAsCoreBeAppUser,
} from '@/tests/helpers/rls-matrix.helper.js';
import {
  runWithPinnedDatabaseHandle,
  type RequestScopedPostgresDatabase,
} from '@/infrastructure/database/contexts/database-context-runtime.js';
import { OrganizationRepository } from '@/domains/tenancy/sub-domains/organization/organization.repository.js';

/**
 * Regression guard for `OrganizationRepository`'s two user-id resolvers.
 *
 * Both directions are called from ORG-only contexts (`withPrincipalDatabaseContext` sets ONLY
 * `app.current_organization_public_id`) and from post-commit paths with no GUC at all. `auth.users` is
 * FORCE RLS with a single self-or-admin policy, so the plain `auth.users` SELECT these methods
 * used matched ZERO rows under the non-superuser `core_be_app` role — silently nulling
 * `created_by_user_id` / `updated_by_user_id` attribution, and silently SKIPPING the
 * permission-cache purge in `MembershipService.invalidatePermissionsForMembership`.
 *
 * This mirrors the guard already covering the membership serializer's batch resolver. It runs as
 * `core_be_app` with NO user context precisely because the local/CI superuser bypasses RLS and
 * hides the bug; it fails if either method reverts to a direct `auth.users` query.
 */
describe('Security: OrganizationRepository user-id resolvers under FORCE RLS', () => {
  const repository = new OrganizationRepository();

  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('resolves internal id → public_id as core_be_app with NO user context', async () => {
    const user = await createTestUser();

    const resolved = await executeAsCoreBeAppUser(null, async (transaction) =>
      runWithPinnedDatabaseHandle(transaction as unknown as RequestScopedPostgresDatabase, () =>
        repository.resolveUserPublicIdByInternalId(user.id),
      ),
    );

    expect(resolved).toBe(user.public_id);
  });

  it('resolves public_id → internal id as core_be_app with NO user context', async () => {
    const user = await createTestUser();

    const resolved = await executeAsCoreBeAppUser(null, async (transaction) =>
      runWithPinnedDatabaseHandle(transaction as unknown as RequestScopedPostgresDatabase, () =>
        repository.resolveUserIdByPublicId(user.public_id),
      ),
    );

    expect(resolved).toBe(user.id);
  });

  it('excludes soft-deleted users in both directions', async () => {
    const user = await createTestUser();
    await database.update(users).set({ deleted_at: new Date() }).where(eq(users.id, user.id));

    const [byInternalId, byPublicId] = await executeAsCoreBeAppUser(null, async (transaction) =>
      runWithPinnedDatabaseHandle(
        transaction as unknown as RequestScopedPostgresDatabase,
        async () =>
          Promise.all([
            repository.resolveUserPublicIdByInternalId(user.id),
            repository.resolveUserIdByPublicId(user.public_id),
          ]),
      ),
    );

    expect(byInternalId).toBeNull();
    expect(byPublicId).toBeNull();
  });
});
