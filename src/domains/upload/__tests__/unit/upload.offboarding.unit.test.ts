import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/infrastructure/storage/storage.service.js', () => ({
  deleteObject: vi.fn().mockResolvedValue(true),
  createPresignedUploadUrl: vi.fn(),
  headObject: vi.fn(),
  getObjectUrl: vi.fn(),
}));

vi.mock('@/domains/user/user.service.js', () => ({
  UserService: class UserService {},
}));

vi.mock('@/domains/tenancy/sub-domains/organization/organization.service.js', () => ({
  OrganizationService: class OrganizationService {},
}));

// Offboarding now runs its reads and its tombstoning UPDATE under
// `MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP` — without it `upload.uploads` (FORCE RLS, both
// arms GUC-gated) matches nothing and the sweep silently erases zero rows. The real wrapper
// opens a `database.transaction()`, and the unit lane has no Postgres, so pass the callback
// through here. The context itself is asserted for real in
// `src/tests/security/rls/uploads-offboarding-rls.security.test.ts`, which runs as
// `core_be_app` where RLS actually applies.
vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
    withAppDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

import { deleteObject } from '@/infrastructure/storage/storage.service.js';
import type { UploadRepository } from '@/domains/upload/upload.repository.js';
import { UploadService } from '@/domains/upload/upload.service.js';

describe('UploadService offboarding', () => {
  beforeEach(() => {
    vi.mocked(deleteObject).mockClear();
  });

  it('tombstoneAllByUserId deletes S3 objects before tombstoning rows', async () => {
    const repository = {
      findActiveByUserIdAfter: vi.fn().mockResolvedValue([
        { id: 1, file_key: 'avatars/user-1/a.png' },
        { id: 2, file_key: 'user-files/user-1/doc.pdf' },
      ]),
      softDeleteAllByUserId: vi.fn().mockResolvedValue(2),
    } as unknown as UploadRepository;

    const service = new UploadService(
      repository,
      {} as ConstructorParameters<typeof UploadService>[1],
      {} as ConstructorParameters<typeof UploadService>[2],
      { deleteObject } as unknown as ConstructorParameters<typeof UploadService>[3],
      {} as ConstructorParameters<typeof UploadService>[4],
    );

    const count = await service.tombstoneAllByUserId(42);

    expect(count).toBe(2);
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(deleteObject).toHaveBeenCalledWith('avatars/user-1/a.png');
    expect(repository.softDeleteAllByUserId).toHaveBeenCalledWith(42);
  });

  it('tombstoneAllByUserId streams uploads in bounded keyset batches', async () => {
    // First page is full (500 rows) so iteration must keyset past it; second page is
    // partial, signalling the final batch. Proves the loop never loads everything at once.
    const firstPage = Array.from({ length: 500 }, (_unused, index) => ({
      id: index + 1,
      file_key: `user-files/user-9/${index + 1}.pdf`,
    }));
    const secondPage = [{ id: 501, file_key: 'user-files/user-9/501.pdf' }];
    const findActiveByUserIdAfter = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);
    const repository = {
      findActiveByUserIdAfter,
      softDeleteAllByUserId: vi.fn().mockResolvedValue(501),
    } as unknown as UploadRepository;

    const service = new UploadService(
      repository,
      {} as ConstructorParameters<typeof UploadService>[1],
      {} as ConstructorParameters<typeof UploadService>[2],
      { deleteObject } as unknown as ConstructorParameters<typeof UploadService>[3],
      {} as ConstructorParameters<typeof UploadService>[4],
    );

    const count = await service.tombstoneAllByUserId(9);

    expect(count).toBe(501);
    expect(deleteObject).toHaveBeenCalledTimes(501);
    // Page 1 starts at id 0; page 2 keysets after the last id of page 1 (500).
    expect(findActiveByUserIdAfter).toHaveBeenNthCalledWith(1, 9, 0, 500);
    expect(findActiveByUserIdAfter).toHaveBeenNthCalledWith(2, 9, 500, 500);
  });
});
