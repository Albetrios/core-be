import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserDataExportService } from '@/domains/user/sub-domains/user-data-export/user-data-export.service.js';
import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';
import {
  USER_DATA_EXPORT_STATUSES,
  UserDataExportCancelledError,
} from '@/domains/user/sub-domains/user-data-export/user-data-export.types.js';

// The service paths under test run inside the real principal wrapper, which
// opens a `database.transaction()` — passthrough so no Postgres is needed
// (CI's unit/contract lanes run without a database service).
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
    withAppDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

/**
 * `markProcessing` and the best-effort cleanup / observability branches.
 *
 * `markProcessing` is the worker's first write against an export and was entirely uncovered:
 * it decides whether to re-check for cancellation (worker path only) and treats a `null`
 * update as "the row went away while we were working" — the offboarding race. Getting either
 * branch wrong means a worker keeps bundling an export for a user who has since deleted their
 * account. The remaining cases pin the warn-logs that are the only signal an S3 artifact was
 * left behind.
 */
const { workerExportRepository } = vi.hoisted(() => ({
  workerExportRepository: {
    findByPublicIdAndUserId: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

const { loggerWarnMock, loggerInfoMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
}));

vi.mock('@/domains/user/sub-domains/user-data-export/queues/user-data-export.queue.js', () => ({
  enqueueUserDataExport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/domains/user/sub-domains/user-data-export/user-data-export.repository.js', () => ({
  createWorkerUserDataExportRepository: () => workerExportRepository,
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: loggerInfoMock, warn: loggerWarnMock, error: vi.fn(), debug: vi.fn() },
}));

const USER_RECORD = {
  id: 1,
  public_id: 'user_public',
  email: 'user@example.com',
  first_name: null,
  last_name: null,
  deleted_at: null,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
};

const EXPORT_PUBLIC_ID = 'ude_aaaaaaaaaaaaaaaaaaaaa';
const WORKER_HANDLE = { kind: 'worker' } as never;

describe('UserDataExportService — markProcessing and cleanup branches', () => {
  const userService = {
    findUserRecordByPublicId: vi.fn(),
    // Hot read paths resolve the id inside their own context (no second transaction).
    resolveInternalIdByPublicId: vi.fn().mockResolvedValue(1),
    requireUserRecordByPublicId: vi.fn(),
  };
  const exportRepository = {
    create: vi.fn(),
    findPendingOrProcessingByUserId: vi.fn().mockResolvedValue(null),
    findByPublicIdAndUserId: vi.fn(),
    listByUserId: vi.fn(),
    findS3KeysByUserIdAfter: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn(),
    deleteAllByUserId: vi.fn(),
  };
  const objectStorage = createObjectStoragePortMock();
  const service = new UserDataExportService(
    userService as never,
    exportRepository as never,
    objectStorage,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    userService.findUserRecordByPublicId.mockResolvedValue(USER_RECORD);
    userService.requireUserRecordByPublicId.mockResolvedValue(USER_RECORD);
    exportRepository.updateStatus.mockResolvedValue({ public_id: EXPORT_PUBLIC_ID });
    workerExportRepository.updateStatus.mockResolvedValue({ public_id: EXPORT_PUBLIC_ID });
    workerExportRepository.findByPublicIdAndUserId.mockResolvedValue({
      public_id: EXPORT_PUBLIC_ID,
      s3_key: 'exports/1/bundle.json.gz',
    });
  });

  // ─── markProcessing: request path ─────────────────────────────

  it('flips the row to PROCESSING on the request path', async () => {
    await service.markProcessing(EXPORT_PUBLIC_ID, 1);

    expect(exportRepository.updateStatus).toHaveBeenCalledWith(EXPORT_PUBLIC_ID, 1, {
      status: USER_DATA_EXPORT_STATUSES.PROCESSING,
    });
  });

  it('skips the cancellation re-check when no worker handle is supplied', async () => {
    await service.markProcessing(EXPORT_PUBLIC_ID, 1);

    // The cancellation probe reads the row through the worker repository; on the request path
    // it must not run at all.
    expect(workerExportRepository.findByPublicIdAndUserId).not.toHaveBeenCalled();
  });

  it('skips the cancellation re-check when a handle is supplied without a user public id', async () => {
    // Both arguments gate the probe — a handle alone is not enough context to resolve the user.
    await service.markProcessing(EXPORT_PUBLIC_ID, 1, WORKER_HANDLE);

    expect(workerExportRepository.findByPublicIdAndUserId).not.toHaveBeenCalled();
    expect(workerExportRepository.updateStatus).toHaveBeenCalledOnce();
  });

  // ─── markProcessing: worker path ──────────────────────────────

  it('re-checks cancellation and proceeds when the export is still live', async () => {
    await service.markProcessing(EXPORT_PUBLIC_ID, 1, WORKER_HANDLE, 'user_public');

    expect(workerExportRepository.findByPublicIdAndUserId).toHaveBeenCalledWith(
      EXPORT_PUBLIC_ID,
      1,
    );
    expect(workerExportRepository.updateStatus).toHaveBeenCalledWith(EXPORT_PUBLIC_ID, 1, {
      status: USER_DATA_EXPORT_STATUSES.PROCESSING,
    });
  });

  it('aborts without writing when the export row has been removed', async () => {
    workerExportRepository.findByPublicIdAndUserId.mockResolvedValue(null);

    await expect(
      service.markProcessing(EXPORT_PUBLIC_ID, 1, WORKER_HANDLE, 'user_public'),
    ).rejects.toBeInstanceOf(UserDataExportCancelledError);
    expect(workerExportRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('aborts without writing when the owning user was soft-deleted', async () => {
    userService.findUserRecordByPublicId.mockResolvedValue({
      ...USER_RECORD,
      deleted_at: new Date(),
    });

    await expect(
      service.markProcessing(EXPORT_PUBLIC_ID, 1, WORKER_HANDLE, 'user_public'),
    ).rejects.toBeInstanceOf(UserDataExportCancelledError);
    expect(workerExportRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('treats a null status update as a cancellation (row deleted mid-flight)', async () => {
    // The offboarding race: the row disappears between the probe and the write, so the
    // update matches nothing and the job must stop rather than carry on bundling.
    workerExportRepository.updateStatus.mockResolvedValue(null);

    await expect(
      service.markProcessing(EXPORT_PUBLIC_ID, 1, WORKER_HANDLE, 'user_public'),
    ).rejects.toBeInstanceOf(UserDataExportCancelledError);
  });

  it('treats a null status update as a cancellation on the request path too', async () => {
    exportRepository.updateStatus.mockResolvedValue(null);

    await expect(service.markProcessing(EXPORT_PUBLIC_ID, 1)).rejects.toBeInstanceOf(
      UserDataExportCancelledError,
    );
  });

  // ─── offboarding delete: logging branches ─────────────────────

  it('logs the offboarding delete count when rows were removed', async () => {
    exportRepository.deleteAllByUserId.mockResolvedValue(3);

    await service.deleteAllExportsForUser(1, 'user_public');

    expect(loggerInfoMock).toHaveBeenCalledWith(
      { userInternalId: 1, deletedCount: 3 },
      'user-data-export.offboarding.deleted',
    );
  });

  it('stays silent when offboarding found nothing to delete', async () => {
    exportRepository.deleteAllByUserId.mockResolvedValue(0);

    await service.deleteAllExportsForUser(1, 'user_public');

    expect(loggerInfoMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'user-data-export.offboarding.deleted',
    );
  });

  it('warns for each artifact object storage refused to delete during offboarding', async () => {
    // Failures are deliberately swallowed so the database delete still runs — the warn log is
    // the only trace that an S3 object was orphaned.
    exportRepository.findS3KeysByUserIdAfter.mockResolvedValueOnce([
      { id: 1, s3_key: 'exports/1/a.json.gz' },
    ]);
    exportRepository.deleteAllByUserId.mockResolvedValue(1);
    vi.mocked(objectStorage.deleteObject).mockResolvedValue(false);

    await service.deleteAllExportsForUser(1, 'user_public');

    expect(loggerWarnMock).toHaveBeenCalledWith(
      { userInternalId: 1, s3Key: 'exports/1/a.json.gz' },
      'user-data-export.offboarding.s3DeleteFailed',
    );
    // The database delete must still happen despite the storage failure.
    expect(exportRepository.deleteAllByUserId).toHaveBeenCalledWith(1);
  });

  it('does not warn when every artifact was deleted cleanly', async () => {
    exportRepository.findS3KeysByUserIdAfter.mockResolvedValueOnce([
      { id: 1, s3_key: 'exports/1/a.json.gz' },
    ]);
    exportRepository.deleteAllByUserId.mockResolvedValue(1);
    vi.mocked(objectStorage.deleteObject).mockResolvedValue(true);

    await service.deleteAllExportsForUser(1, 'user_public');

    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'user-data-export.offboarding.s3DeleteFailed',
    );
  });
});
