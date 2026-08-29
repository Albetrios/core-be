import { describe, it, expect, beforeEach } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import {
  UserDataExportRepository,
  createWorkerUserDataExportRepository,
} from '@/domains/user/sub-domains/user-data-export/user-data-export.repository.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

/**
 * The last repository in the user domain without a database test. Its reads are all scoped by
 * `(public_id, user_id)` — the property that stops one user reading another's export bundle by
 * guessing a public id — and it exposes a worker-context factory that must refuse to run outside
 * a worker database context.
 */
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * `idx_user_data_exports_user_pending` is a partial unique index — a user may hold at most one
 * pending export at a time, so any fixture needing two rows for one user must vary the status.
 */
function exportRow(userId: number, status: 'pending' | 'completed' = 'pending') {
  return {
    public_id: generatePublicId('userDataExport'),
    user_id: userId,
    status,
    s3_key: `exports/${userId}/bundle.zip`,
    expires_at: new Date(Date.now() + ONE_HOUR_MS),
  };
}

describe('UserDataExportRepository (database)', () => {
  const repository = new UserDataExportRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('create returns the inserted row with its generated identifiers', async () => {
    const user = await createTestUser();
    const row = exportRow(user.id);

    const created = await repository.create(row);

    expect(created.id).toBeGreaterThan(0);
    expect(created.public_id).toBe(row.public_id);
    expect(created.user_id).toBe(user.id);
    expect(created.status).toBe('pending');
  });

  it('findByPublicIdAndUserId scopes the read to the owning user', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const created = await repository.create(exportRow(owner.id));

    const asOwner = await repository.findByPublicIdAndUserId(created.public_id, owner.id);
    const asStranger = await repository.findByPublicIdAndUserId(created.public_id, stranger.id);

    expect(asOwner?.public_id).toBe(created.public_id);
    // The ownership property that matters: a valid public id belonging to someone else reads as
    // absent, so the route answers 404 rather than leaking another user's export.
    expect(asStranger).toBeNull();
  });

  it('updateStatus returns null when the row belongs to a different user', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const created = await repository.create(exportRow(owner.id));

    const updated = await repository.updateStatus(created.public_id, stranger.id, {
      status: 'completed',
    });

    expect(updated).toBeNull();
    const stillPending = await repository.findByPublicIdAndUserId(created.public_id, owner.id);
    expect(stillPending?.status).toBe('pending');
  });

  it('createWorkerUserDataExportRepository reads under a worker database handle', async () => {
    const user = await createTestUser();
    const created = await repository.create(exportRow(user.id));

    const found = await withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ userPublicId: user.public_id }),
      async (databaseHandle) => {
        const workerRepository = createWorkerUserDataExportRepository(databaseHandle);
        return workerRepository.findByPublicIdAndUserId(created.public_id, user.id);
      },
    );

    expect(found?.public_id).toBe(created.public_id);
  });

  it('deleteAllByUserId removes only the calling user rows and reports the count', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    await repository.create(exportRow(owner.id, 'pending'));
    await repository.create(exportRow(owner.id, 'completed'));
    const strangerExport = await repository.create(exportRow(stranger.id));

    const deleted = await repository.deleteAllByUserId(owner.id);

    expect(deleted).toBe(2);
    expect(await repository.listByUserId(owner.id)).toEqual([]);
    expect(
      await repository.findByPublicIdAndUserId(strangerExport.public_id, stranger.id),
    ).not.toBeNull();
  });
});
