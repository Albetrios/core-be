import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { resetEnvCacheForTests } from '@/shared/config/env.config.js';
import { ValidationError } from '@/shared/errors/index.js';
import { UploadRepository } from '@/domains/upload/upload.repository.js';
import { UploadService } from '@/domains/upload/upload.service.js';
import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { withPrincipalDatabaseContext } from '@/infrastructure/database/contexts/principal-database.context.js';
import { resolveVerifiedUserPrincipalScope } from '@/shared/utils/identity/verified-principal-scope.util.js';

const PENDING_CAP = 3;
const CONCURRENT_REQUESTS = 8;

/**
 * Bug 37 regression: concurrent create-upload requests must not over-provision presigned
 * slots beyond the per-user PENDING quota. The reservation (advisory lock + count + insert)
 * runs in one transaction before presigning, so at most `UPLOAD_MAX_PENDING_PER_USER`
 * requests can succeed even when all fire at once.
 */
describe('UploadService pending-quota concurrency (database)', () => {
  const originalCap = process.env.UPLOAD_MAX_PENDING_PER_USER;
  const originalBucket = process.env.S3_BUCKET;
  const originalUsePresignedPost = process.env.UPLOAD_USE_PRESIGNED_POST;

  beforeEach(async () => {
    await cleanupDatabase();
    process.env.UPLOAD_MAX_PENDING_PER_USER = String(PENDING_CAP);
    process.env.S3_BUCKET = process.env.S3_BUCKET ?? 'test-bucket';
    // Pin the PUT presign path so the assertion below targets a single storage method.
    process.env.UPLOAD_USE_PRESIGNED_POST = 'false';
    resetEnvCacheForTests();
  });

  afterAll(() => {
    if (originalCap === undefined) delete process.env.UPLOAD_MAX_PENDING_PER_USER;
    else process.env.UPLOAD_MAX_PENDING_PER_USER = originalCap;
    if (originalBucket === undefined) delete process.env.S3_BUCKET;
    else process.env.S3_BUCKET = originalBucket;
    if (originalUsePresignedPost === undefined) delete process.env.UPLOAD_USE_PRESIGNED_POST;
    else process.env.UPLOAD_USE_PRESIGNED_POST = originalUsePresignedPost;
    resetEnvCacheForTests();
  });

  it('mints at most UPLOAD_MAX_PENDING_PER_USER presigned slots under concurrent createUpload', async () => {
    const user = await createTestUser({ email: 'upload-quota-race@example.com' });
    const repository = new UploadRepository();
    const objectStorage = createObjectStoragePortMock();
    const userService = {
      requireUserRecordByPublicId: async () => user,
    } as unknown as UserService;
    const organizationService = {} as unknown as OrganizationService;
    const service = new UploadService(
      repository,
      userService,
      organizationService,
      objectStorage,
      {} as ConstructorParameters<typeof UploadService>[4],
    );

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT_REQUESTS }, () =>
        service.createUpload(
          {
            purpose: 'avatar',
            for: 'user',
            content_type: 'image/png',
            file_name: 'avatar.png',
            file_size: 1024,
          },
          user.public_id,
        ),
      ),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    // No over-provisioning: exactly the cap succeeds, the rest are rejected with the quota error.
    expect(fulfilled.length).toBe(PENDING_CAP);
    expect(rejected.length).toBe(CONCURRENT_REQUESTS - PENDING_CAP);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(ValidationError);
    }

    // Exactly `PENDING_CAP` rows were persisted, and presigned URLs were minted only for them.
    const pendingCount = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(user.public_id),
      () => repository.countPendingByUserId(user.id),
    );
    expect(pendingCount).toBe(PENDING_CAP);
    expect(objectStorage.createPresignedUploadUrl).toHaveBeenCalledTimes(PENDING_CAP);
  });
});
