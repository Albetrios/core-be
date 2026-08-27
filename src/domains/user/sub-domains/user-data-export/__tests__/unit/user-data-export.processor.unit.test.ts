import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runUserDataExportJob } from '@/domains/user/sub-domains/user-data-export/workers/user-data-export.processor.js';
import { UserDataExportCancelledError } from '@/domains/user/sub-domains/user-data-export/user-data-export.types.js';

const fakeDatabaseHandle = { __fake: true } as const;

vi.mock(
  '@/infrastructure/database/contexts/principal-database.context.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      withPrincipalDatabaseContext: async (
        _scope: unknown,
        callback: (databaseHandle: unknown) => Promise<unknown>,
      ) => callback(fakeDatabaseHandle),
    };
  },
);

const { loggerInfoMock, loggerErrorMock } = vi.hoisted(() => ({
  loggerInfoMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));
vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: loggerInfoMock, warn: vi.fn(), error: loggerErrorMock },
}));

function createServiceMock() {
  return {
    isExportJobCancelled: vi.fn(),
    markProcessing: vi.fn(),
    buildExportPayload: vi.fn(),
    completeExportJob: vi.fn(),
    failExportJob: vi.fn(),
  };
}

const jobData = {
  exportPublicId: 'exp_public_id_001',
  userPublicId: 'usr_public_id_001',
  userInternalId: 42,
};

describe('user-data-export.processor', () => {
  beforeEach(() => {
    loggerInfoMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('marks export as PROCESSING, builds payload, uploads to S3, marks COMPLETED', async () => {
    const service = createServiceMock();
    service.isExportJobCancelled.mockResolvedValue(false);
    service.markProcessing.mockResolvedValue(undefined);
    service.buildExportPayload.mockResolvedValue({ user: { id: jobData.userPublicId } });
    service.completeExportJob.mockResolvedValue(undefined);

    await runUserDataExportJob(jobData, service as never);

    expect(service.isExportJobCancelled).toHaveBeenCalledTimes(2);
    expect(service.isExportJobCancelled).toHaveBeenCalledWith(
      expect.objectContaining({
        exportPublicId: jobData.exportPublicId,
        userInternalId: jobData.userInternalId,
        userPublicId: jobData.userPublicId,
        databaseHandle: fakeDatabaseHandle,
      }),
    );
    expect(service.markProcessing).toHaveBeenCalledWith(
      jobData.exportPublicId,
      jobData.userInternalId,
      fakeDatabaseHandle,
      jobData.userPublicId,
    );
    expect(service.buildExportPayload).toHaveBeenCalledWith(jobData.userPublicId);
    expect(service.completeExportJob).toHaveBeenCalledOnce();
    const completeArguments = service.completeExportJob.mock.calls[0]?.[0] as {
      exportPublicId: string;
      userInternalId: number;
      userPublicId: string;
      body: Buffer;
    };
    expect(completeArguments.exportPublicId).toBe(jobData.exportPublicId);
    expect(completeArguments.userInternalId).toBe(jobData.userInternalId);
    expect(completeArguments.userPublicId).toBe(jobData.userPublicId);
    expect(Buffer.isBuffer(completeArguments.body)).toBe(true);
    expect(service.completeExportJob.mock.calls[0]?.[1]).toBeUndefined();
    expect(service.failExportJob).not.toHaveBeenCalled();
  });

  it('exits without retry when export status is CANCELLED before start', async () => {
    const service = createServiceMock();
    service.isExportJobCancelled.mockResolvedValueOnce(true);

    await expect(runUserDataExportJob(jobData, service as never)).resolves.toBeUndefined();

    expect(service.markProcessing).not.toHaveBeenCalled();
    expect(service.buildExportPayload).not.toHaveBeenCalled();
    expect(service.completeExportJob).not.toHaveBeenCalled();
    expect(service.failExportJob).not.toHaveBeenCalled();
  });

  it('exits gracefully when export status moves to CANCELLED mid-flight (after markProcessing)', async () => {
    const service = createServiceMock();
    service.isExportJobCancelled.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    service.markProcessing.mockResolvedValue(undefined);

    await expect(runUserDataExportJob(jobData, service as never)).resolves.toBeUndefined();

    expect(service.markProcessing).toHaveBeenCalledOnce();
    expect(service.buildExportPayload).not.toHaveBeenCalled();
    expect(service.completeExportJob).not.toHaveBeenCalled();
    expect(service.failExportJob).not.toHaveBeenCalled();
  });

  it('treats UserDataExportCancelledError as graceful exit without marking failed', async () => {
    const service = createServiceMock();
    service.isExportJobCancelled.mockResolvedValue(false);
    service.markProcessing.mockRejectedValue(new UserDataExportCancelledError());

    await expect(runUserDataExportJob(jobData, service as never)).resolves.toBeUndefined();

    expect(service.failExportJob).not.toHaveBeenCalled();
  });

  it('marks FAILED and rethrows on unexpected error', async () => {
    const service = createServiceMock();
    service.isExportJobCancelled.mockResolvedValue(false);
    service.markProcessing.mockResolvedValue(undefined);
    const failure = new Error('boom');
    service.buildExportPayload.mockRejectedValue(failure);
    service.failExportJob.mockResolvedValue(undefined);

    await expect(runUserDataExportJob(jobData, service as never)).rejects.toBe(failure);

    expect(service.failExportJob).toHaveBeenCalledWith(
      jobData.exportPublicId,
      jobData.userInternalId,
      'export_failed',
      fakeDatabaseHandle,
    );
  });
});
