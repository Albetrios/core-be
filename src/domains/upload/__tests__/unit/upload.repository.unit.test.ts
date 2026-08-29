import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UploadRepository } from '@/domains/upload/upload.repository.js';

const mockReturning = vi.fn().mockResolvedValue([]);
const mockLimit = vi.fn().mockResolvedValue([]);
const mockWhere = vi.fn(() => ({ limit: mockLimit, returning: mockReturning }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockValues = vi.fn(() => ({ returning: mockReturning }));
const mockInsert = vi.fn(() => ({ values: mockValues }));

vi.mock('@/shared/utils/infrastructure/postgres-error.util.js', () => ({
  runInsertWithPublicIdentifierRetry: async (operation: () => Promise<unknown>) => operation(),
}));

vi.mock('@/shared/utils/identity/public-id.util.js', () => ({
  generatePublicId: () => 'upload_public_test',
}));

const mockSet = vi.fn(() => ({ where: mockWhere }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));

vi.mock(
  '@/infrastructure/database/contexts/database-context-runtime.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      getRequestDatabase: () => ({
        select: mockSelect,
        insert: mockInsert,
        update: mockUpdate,
      }),
    };
  },
);

describe('UploadRepository', () => {
  const repository = new UploadRepository();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockReset();
    mockReturning.mockReset();
  });

  it('create inserts pending upload row', async () => {
    const row = { public_id: 'upload_public_test', status: 'PENDING' };
    mockReturning.mockResolvedValue([row]);

    const result = await repository.create({
      user_id: 1,
      file_name: 'avatar.png',
      file_key: 'avatars/key.png',
      mime_type: 'image/png',
      file_size: 1024,
      storage_provider: 's3',
      bucket: 'test-bucket',
    });

    expect(mockInsert).toHaveBeenCalled();
    expect(result).toEqual(row);
  });

  it('findByPublicId returns null when missing', async () => {
    mockLimit.mockResolvedValue([]);

    const result = await repository.findByPublicId('missing');

    expect(result).toBeNull();
  });

  // The sole lookup behind assertKeyConfirmed / assertKeyConfirmedForOwner — the gate that
  // decides whether an S3 object may be attached as an avatar or a logo — and it had no test.
  it('findByFileKey returns the row for a known key', async () => {
    const row = { public_id: 'upload_public_test', file_key: 'avatars/user_public/key.png' };
    mockLimit.mockResolvedValue([row]);

    expect(await repository.findByFileKey('avatars/user_public/key.png')).toEqual(row);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('findByFileKey returns null for an unknown key', async () => {
    mockLimit.mockResolvedValue([]);

    expect(await repository.findByFileKey('avatars/user_public/missing.png')).toBeNull();
  });

  it('findByPublicIdForUser scopes by user', async () => {
    const row = { public_id: 'upload_public_test', user_id: 1 };
    mockLimit.mockResolvedValue([row]);

    const result = await repository.findByPublicIdForUser('upload_public_test', 1);

    expect(result).toEqual(row);
  });

  it('softDelete returns null when upload missing', async () => {
    mockReturning.mockResolvedValue([]);
    expect(await repository.softDelete('missing', 1)).toBeNull();
  });

  it('softDeleteByPublicId returns null when upload missing', async () => {
    mockReturning.mockResolvedValue([]);
    expect(await repository.softDeleteByPublicId('missing')).toBeNull();
  });

  it('markStatusByPublicId returns updated row', async () => {
    const row = { public_id: 'upload_public_test', status: 'UPLOADED' };
    mockReturning.mockResolvedValue([row]);
    expect(await repository.markStatusByPublicId('upload_public_test', 'UPLOADED')).toEqual(row);
  });

  // sec-D12: the unbounded `findActiveByUserId` / `findActiveByOrganizationId`
  // siblings were removed — production goes through the keyset variants below.
  it('findActiveByUserIdAfter and findActiveByOrganizationIdAfter return keyset-paginated rows', async () => {
    const activeRows = [{ id: 11, file_key: 'avatars/key.png' }];

    mockFrom.mockReturnValueOnce({
      where: vi.fn().mockReturnValueOnce({
        orderBy: vi.fn().mockReturnValueOnce({
          limit: vi.fn().mockResolvedValue(activeRows),
        }),
      }),
    });
    const byUser = await repository.findActiveByUserIdAfter(1, 0, 100);
    expect(byUser).toEqual(activeRows);

    mockFrom.mockReturnValueOnce({
      where: vi.fn().mockReturnValueOnce({
        orderBy: vi.fn().mockReturnValueOnce({
          limit: vi.fn().mockResolvedValue(activeRows),
        }),
      }),
    });
    const byOrganization = await repository.findActiveByOrganizationIdAfter(10, 0, 100);
    expect(byOrganization).toEqual(activeRows);
  });

  it('softDeleteAllByUserId and softDeleteAllByOrganizationId return affected counts', async () => {
    mockReturning.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    expect(await repository.softDeleteAllByUserId(1)).toBe(2);
    expect(await repository.softDeleteAllByOrganizationId(10)).toBe(2);
  });
});
