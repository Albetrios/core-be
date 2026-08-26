import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/maintenance-database.context.js';
import { eq } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { UploadRepository, markConfirmedByInternalId } from '@/domains/upload/upload.repository.js';
import { uploads } from '@/domains/upload/upload.schema.js';
import { database } from '@/infrastructure/database/connection.js';

describe('UploadRepository (database)', () => {
  const repository = new UploadRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  /** Run the worker-scoped confirm the way the pending-sweep worker does (global retention context). */
  const confirm = (id: number, finalKey: string) =>
    withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_retention_cleanup, (handle) =>
      markConfirmedByInternalId(handle, id, finalKey),
    );

  async function readRow(id: number) {
    const [row] = await database
      .select({
        status: uploads.status,
        file_key: uploads.file_key,
        deleted_at: uploads.deleted_at,
      })
      .from(uploads)
      .where(eq(uploads.id, id));
    return row;
  }

  it('creates and finds uploads by public id for user and organization', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });

    const created = await repository.create({
      user_id: user.id,
      organization_id: organization.id,
      file_name: 'logo.png',
      file_key: 'organization-logos/logo.png',
      mime_type: 'image/png',
      file_size: 2048,
      storage_provider: 's3',
      bucket: 'test-bucket',
    });

    const byPublicId = await repository.findByPublicId(created.public_id);
    expect(byPublicId?.file_name).toBe('logo.png');

    const forUser = await repository.findByPublicIdForUser(created.public_id, user.id);
    expect(forUser?.public_id).toBe(created.public_id);

    const missing = await repository.findByPublicId('nonexistent_public_id');
    expect(missing).toBeNull();
  });

  it('soft-deletes all uploads for a user', async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: user.id });

    await repository.create({
      user_id: user.id,
      organization_id: organization.id,
      file_name: 'a.png',
      file_key: 'a.png',
      mime_type: 'image/png',
      file_size: 100,
      storage_provider: 's3',
      bucket: 'test',
    });

    const deletedCount = await repository.softDeleteAllByUserId(user.id);
    expect(deletedCount).toBeGreaterThanOrEqual(1);
  });

  // sec-re-13: markConfirmedByInternalId is the pending-sweep's confirm. Its WHERE guard —
  // id ∧ deleted_at IS NULL ∧ status = 'PENDING' — is what stops a stale confirm from publishing a
  // soft-deleted or already-terminal row. Only mocked in the sweep unit test; run the real SQL here.
  it('markConfirmedByInternalId confirms a PENDING, undeleted row (positive control)', async () => {
    const user = await createTestUser({ email: 'confirm-ok@example.com' });
    const created = await repository.create({
      user_id: user.id,
      organization_id: null,
      file_name: 'a.png',
      file_key: 'pending/user-files/a.png',
      mime_type: 'image/png',
      file_size: 100,
      storage_provider: 's3',
      bucket: 'test',
      status: 'PENDING',
    });

    await confirm(created.id, 'user-files/a.png');

    const row = await readRow(created.id);
    expect(row?.status).toBe('UPLOADED');
    expect(row?.file_key).toBe('user-files/a.png');
  });

  it('markConfirmedByInternalId does NOT confirm a soft-deleted row (deleted_at guard)', async () => {
    const user = await createTestUser({ email: 'confirm-deleted@example.com' });
    const created = await repository.create({
      user_id: user.id,
      organization_id: null,
      file_name: 'b.png',
      file_key: 'pending/user-files/b.png',
      mime_type: 'image/png',
      file_size: 100,
      storage_provider: 's3',
      bucket: 'test',
      status: 'PENDING',
    });
    await repository.softDeleteByPublicId(created.public_id);

    await confirm(created.id, 'user-files/b.png');

    // The row is still PENDING with its pending/ key — the deleted_at guard blocked the confirm, so
    // bytes are never published on behalf of an upload the user already abandoned.
    const row = await readRow(created.id);
    expect(row?.status).toBe('PENDING');
    expect(row?.file_key).toBe('pending/user-files/b.png');
    expect(row?.deleted_at).not.toBeNull();
  });

  it('markConfirmedByInternalId does NOT re-confirm a non-PENDING row (status guard)', async () => {
    const user = await createTestUser({ email: 'confirm-failed@example.com' });
    const created = await repository.create({
      user_id: user.id,
      organization_id: null,
      file_name: 'c.png',
      file_key: 'pending/user-files/c.png',
      mime_type: 'image/png',
      file_size: 100,
      storage_provider: 's3',
      bucket: 'test',
      status: 'FAILED',
    });

    await confirm(created.id, 'user-files/c.png');

    // A terminal (FAILED) row is untouched — the status guard prevents resurrecting it to UPLOADED.
    const row = await readRow(created.id);
    expect(row?.status).toBe('FAILED');
    expect(row?.file_key).toBe('pending/user-files/c.png');
  });
});
