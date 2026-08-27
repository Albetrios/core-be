import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enterOnCommitScope, eventBus } from '@/core/events/event-bus.js';
import { NotFoundError } from '@/shared/errors/index.js';
import {
  capExportCategory,
  UserDataExportService,
} from '@/domains/user/sub-domains/user-data-export/user-data-export.service.js';
import { GDPR_EXPORT_MAX_ROWS_PER_TABLE } from '@/shared/constants/query-limits.constants.js';
import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';
import {
  USER_DATA_EXPORT_STATUSES,
  UserDataExportCancelledError,
} from '@/domains/user/sub-domains/user-data-export/user-data-export.types.js';
import { USER_DATA_EXPORT_PRESIGNED_DOWNLOAD_EXPIRY_SECONDS } from '@/shared/constants/ttl.constants.js';
import {
  createPrincipalDatabaseScope,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

const { workerExportRepository } = vi.hoisted(() => ({
  workerExportRepository: {
    findByPublicIdAndUserId: vi.fn(),
  },
}));

vi.mock('@/domains/user/sub-domains/user-data-export/queues/user-data-export.queue.js', () => ({
  enqueueUserDataExport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/domains/user/sub-domains/user-data-export/user-data-export.repository.js', () => ({
  createWorkerUserDataExportRepository: () => workerExportRepository,
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Blanket maintenance passthrough: services this suite touches (directly or via
    // cross-domain imports) may enter maintenance contexts (tombstoning, admin reads) —
    // the real wrapper opens a database.transaction() and CI's unit lane has no Postgres.
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
    withPrincipalDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

const userRecord = {
  id: 1,
  public_id: 'user_public',
  email: 'user@example.com',
  first_name: null,
  last_name: null,
  deleted_at: null,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
};

const asUserScope = (userPublicId: string) =>
  createPrincipalDatabaseScope({
    userPublicId,
    organizationPublicId: 'org_scope_test',
    source: 'request',
  }) as UserPrincipalDatabaseScope;

describe('UserDataExportService', () => {
  const userService = {
    findUserRecordByPublicId: vi.fn(),
    requireUserRecordByPublicId: vi.fn(),
  };
  const exportRepository = {
    create: vi.fn(),
    findPendingOrProcessingByUserId: vi.fn().mockResolvedValue(null),
    findByPublicIdAndUserId: vi.fn(),
    listByUserId: vi.fn(),
    // sec-r4-R2: offboarding pages s3 keys with this method instead of listByUserId.
    findS3KeysByUserIdAfter: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn(),
    deleteAllByUserId: vi.fn(),
  };
  const crossDomainServices = {
    authSessionService: { listForUserDataExport: vi.fn().mockResolvedValue([]) },
    membershipService: { listOrganizationsForUserDataExport: vi.fn().mockResolvedValue([]) },
    notificationService: { listForUserDataExport: vi.fn().mockResolvedValue([]) },
    auditService: { listActivityForUserDataExport: vi.fn().mockResolvedValue([]) },
  };
  const objectStorage = createObjectStoragePortMock();
  const service = new UserDataExportService(
    userService as never,
    exportRepository as never,
    objectStorage,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    service.wireCrossDomainServices(crossDomainServices as never);
    userService.findUserRecordByPublicId.mockResolvedValue(userRecord);
    userService.requireUserRecordByPublicId.mockResolvedValue(userRecord);
    crossDomainServices.authSessionService.listForUserDataExport.mockResolvedValue([]);
    crossDomainServices.membershipService.listOrganizationsForUserDataExport.mockResolvedValue([]);
    crossDomainServices.notificationService.listForUserDataExport.mockResolvedValue([]);
    crossDomainServices.auditService.listActivityForUserDataExport.mockResolvedValue([]);
  });

  it('buildExportPayload returns aggregated user data via cross-domain services', async () => {
    const result = await service.buildExportPayload('user_public');

    expect(result.user.email).toBe('user@example.com');
    expect(result.organizations).toEqual([]);
    expect(result.exported_at).toBeDefined();
    expect(
      crossDomainServices.membershipService.listOrganizationsForUserDataExport,
    ).toHaveBeenCalled();
  });

  it('buildExportPayload throws when user is missing', async () => {
    userService.requireUserRecordByPublicId.mockRejectedValue(new NotFoundError('User'));
    await expect(service.buildExportPayload('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('requestExport creates row and defers enqueue until flushOnCommit', async () => {
    const { enqueueUserDataExport } = await import(
      '@/domains/user/sub-domains/user-data-export/queues/user-data-export.queue.js'
    );
    exportRepository.create.mockResolvedValue({
      public_id: 'exp_test',
      status: USER_DATA_EXPORT_STATUSES.PENDING,
      expires_at: new Date(),
      created_at: new Date(),
    });

    enterOnCommitScope();
    const result = await service.requestExport(asUserScope('user_public'));

    expect(exportRepository.create).toHaveBeenCalled();
    expect(enqueueUserDataExport).not.toHaveBeenCalled();

    await eventBus.flushOnCommit();
    expect(enqueueUserDataExport).toHaveBeenCalledWith(
      expect.objectContaining({
        userPublicId: 'user_public',
        userInternalId: userRecord.id,
      }),
    );
    expect(result.status).toBe(USER_DATA_EXPORT_STATUSES.PENDING);
  });

  it('requestExport returns existing pending export when concurrent insert hits unique index', async () => {
    const existingPending = {
      public_id: 'exp_existing',
      status: USER_DATA_EXPORT_STATUSES.PENDING,
      expires_at: new Date(),
      created_at: new Date(),
    };
    exportRepository.create.mockRejectedValue({ code: '23505' });
    exportRepository.findPendingOrProcessingByUserId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingPending);

    const result = await service.requestExport(asUserScope('user_public'));

    expect(result.export_id).toBe('exp_existing');
    expect(result.status).toBe(USER_DATA_EXPORT_STATUSES.PENDING);
  });

  // sec-U6: 24h was too generous — an exfiltrated session token can mint
  // the URL once, then walk away and use it within a full day. Drop to 15 min
  // so a stolen token has a narrow exploit window between mint and use.
  it('getExportStatus uses 15min presigned download expiry for completed exports (sec-U6)', async () => {
    expect(USER_DATA_EXPORT_PRESIGNED_DOWNLOAD_EXPIRY_SECONDS).toBe(900);
    const expiresAt = new Date(Date.now() + 60_000);
    exportRepository.findByPublicIdAndUserId.mockResolvedValue({
      public_id: 'exp_dl',
      status: USER_DATA_EXPORT_STATUSES.COMPLETED,
      s3_key: 'user-data-export/user/exp_dl.json.gz',
      expires_at: expiresAt,
      completed_at: new Date(),
      failed_at: null,
      error_code: null,
      created_at: new Date(),
    });
    objectStorage.createPresignedDownloadUrl.mockResolvedValue('https://example.com/download');

    await service.getExportStatus(asUserScope('user_public'), 'exp_dl');

    expect(objectStorage.createPresignedDownloadUrl).toHaveBeenCalledWith({
      key: 'user-data-export/user/exp_dl.json.gz',
      expiresInSeconds: USER_DATA_EXPORT_PRESIGNED_DOWNLOAD_EXPIRY_SECONDS,
    });
  });

  it('isExportJobCancelled returns true when export row is missing', async () => {
    workerExportRepository.findByPublicIdAndUserId.mockResolvedValue(null);

    const cancelled = await service.isExportJobCancelled({
      exportPublicId: 'exp_missing',
      userInternalId: 1,
      userPublicId: 'user_public',
      databaseHandle: {} as never,
    });

    expect(cancelled).toBe(true);
  });

  it('isExportJobCancelled returns true when user is soft-deleted', async () => {
    workerExportRepository.findByPublicIdAndUserId.mockResolvedValue({
      public_id: 'exp_1',
      s3_key: 'user-data-export/user/exp_1.json.gz',
    });
    userService.findUserRecordByPublicId.mockResolvedValue({
      ...userRecord,
      deleted_at: new Date(),
    });

    const cancelled = await service.isExportJobCancelled({
      exportPublicId: 'exp_1',
      userInternalId: 1,
      userPublicId: 'user_public',
      databaseHandle: {} as never,
    });

    expect(cancelled).toBe(true);
  });

  it('completeExportJob skips S3 when export row was removed', async () => {
    exportRepository.findByPublicIdAndUserId.mockResolvedValue(null);

    await expect(
      service.completeExportJob({
        exportPublicId: 'exp_gone',
        userInternalId: 1,
        userPublicId: 'user_public',
        body: Buffer.from('x'),
      }),
    ).rejects.toBeInstanceOf(UserDataExportCancelledError);

    expect(objectStorage.putObject).not.toHaveBeenCalled();
  });

  it('completeExportJob deletes S3 artifact when cancelled after upload on worker path', async () => {
    const s3Key = 'user-data-export/user/exp_cancelled.json.gz';
    exportRepository.findByPublicIdAndUserId
      .mockResolvedValueOnce({
        public_id: 'exp_cancelled',
        s3_key: s3Key,
      })
      .mockResolvedValueOnce({
        public_id: 'exp_cancelled',
        s3_key: s3Key,
      })
      .mockResolvedValueOnce(null);

    await expect(
      service.completeExportJob({
        exportPublicId: 'exp_cancelled',
        userInternalId: 1,
        userPublicId: 'user_public',
        body: Buffer.from('gzip-body'),
      }),
    ).rejects.toBeInstanceOf(UserDataExportCancelledError);

    expect(objectStorage.putObject).toHaveBeenCalledWith(expect.objectContaining({ key: s3Key }));
    expect(objectStorage.deleteObject).toHaveBeenCalledWith(s3Key);
  });

  it('completeExportJob deletes S3 artifact when updateStatus returns null after upload', async () => {
    const s3Key = 'user-data-export/user/exp_stale.json.gz';
    exportRepository.findByPublicIdAndUserId.mockResolvedValue({
      public_id: 'exp_stale',
      s3_key: s3Key,
    });
    exportRepository.updateStatus.mockResolvedValue(null);

    await expect(
      service.completeExportJob({
        exportPublicId: 'exp_stale',
        userInternalId: 1,
        userPublicId: 'user_public',
        body: Buffer.from('gzip-body'),
      }),
    ).rejects.toBeInstanceOf(UserDataExportCancelledError);

    expect(objectStorage.putObject).toHaveBeenCalledWith(expect.objectContaining({ key: s3Key }));
    expect(objectStorage.deleteObject).toHaveBeenCalledWith(s3Key);
  });

  it('completeExportJob does not delete S3 artifact on successful completion', async () => {
    const s3Key = 'user-data-export/user/exp_ok.json.gz';
    exportRepository.findByPublicIdAndUserId.mockResolvedValue({
      public_id: 'exp_ok',
      s3_key: s3Key,
    });
    exportRepository.updateStatus.mockResolvedValue({
      public_id: 'exp_ok',
      status: USER_DATA_EXPORT_STATUSES.COMPLETED,
    });

    await service.completeExportJob({
      exportPublicId: 'exp_ok',
      userInternalId: 1,
      userPublicId: 'user_public',
      body: Buffer.from('gzip-body'),
    });

    expect(objectStorage.putObject).toHaveBeenCalledWith(expect.objectContaining({ key: s3Key }));
    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
  });

  it('deleteAllExportsForUser removes S3 objects and database rows', async () => {
    // sec-r4-R2: keyset-paginated; single batch returning fewer than the
    // batch-size cap should end the loop after one pass.
    exportRepository.findS3KeysByUserIdAfter
      .mockResolvedValueOnce([{ id: 1, s3_key: 'user-data-export/user/exp_1.json.gz' }])
      .mockResolvedValueOnce([]);
    exportRepository.deleteAllByUserId.mockResolvedValue(1);

    await service.deleteAllExportsForUser(1, 'user_public');

    expect(objectStorage.deleteObject).toHaveBeenCalledWith('user-data-export/user/exp_1.json.gz');
    expect(exportRepository.deleteAllByUserId).toHaveBeenCalledWith(1);
  });

  // sec-r4-R2: with a long export history the loop must walk every page and
  // never invoke S3 deletes for null s3_keys.
  it('deleteAllExportsForUser pages through batches and skips rows with no s3_key', async () => {
    // First batch returns exactly batch-size — but use a small fixture; we
    // simulate the "more pages" path by returning a full chunk first.
    const firstBatch = Array.from({ length: 500 }, (_, index) => ({
      id: index + 1,
      s3_key: `user-data-export/user/exp_${index + 1}.json.gz`,
    }));
    const secondBatch = [
      { id: 501, s3_key: 'user-data-export/user/exp_501.json.gz' },
      { id: 502, s3_key: null }, // rows with null s3_key must be skipped
    ];
    // vi.clearAllMocks() in beforeEach only clears call history — the
    // mockResolvedValueOnce queue from the previous test (which left an unused
    // `[]` because its single-batch run broke early) carries over. Reset the
    // implementation queue on this mock specifically before queuing our own.
    exportRepository.findS3KeysByUserIdAfter.mockReset();
    exportRepository.findS3KeysByUserIdAfter
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce(secondBatch);
    exportRepository.deleteAllByUserId.mockResolvedValue(501);

    await service.deleteAllExportsForUser(1, 'user_public');

    // 500 from the first batch + 1 from the second (null s3_key filtered out).
    expect(objectStorage.deleteObject).toHaveBeenCalledTimes(501);
    // First page asks from afterId=0; second page asks from afterId=500 (last id of first batch).
    expect(exportRepository.findS3KeysByUserIdAfter).toHaveBeenNthCalledWith(1, 1, 0, 500);
    expect(exportRepository.findS3KeysByUserIdAfter).toHaveBeenNthCalledWith(2, 1, 500, 500);
    expect(exportRepository.deleteAllByUserId).toHaveBeenCalledWith(1);
  });
});

describe('capExportCategory', () => {
  it('returns rows untouched and records no truncation when under the cap', () => {
    const truncated: string[] = [];
    const rows = Array.from({ length: GDPR_EXPORT_MAX_ROWS_PER_TABLE }, (_, index) => index);

    const result = capExportCategory(rows, 'sessions', truncated);

    expect(result).toHaveLength(GDPR_EXPORT_MAX_ROWS_PER_TABLE);
    expect(truncated).toEqual([]);
  });

  it('slices to the cap and records the category when the cap is exceeded', () => {
    const truncated: string[] = [];
    const rows = Array.from({ length: GDPR_EXPORT_MAX_ROWS_PER_TABLE + 5 }, (_, index) => index);

    const result = capExportCategory(rows, 'audit_activity', truncated);

    expect(result).toHaveLength(GDPR_EXPORT_MAX_ROWS_PER_TABLE);
    expect(truncated).toEqual(['audit_activity']);
  });
});
