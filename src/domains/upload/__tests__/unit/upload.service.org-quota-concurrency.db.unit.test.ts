import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { resetEnvCacheForTests } from '@/shared/config/env.config.js';
import { ValidationError } from '@/shared/errors/index.js';
import { UploadRepository } from '@/domains/upload/upload.repository.js';
import { UploadService } from '@/domains/upload/upload.service.js';
import { UPLOAD_PERMISSIONS } from '@/domains/upload/upload.permissions.js';
import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

const ORG_CAP = 3;
const REQUESTS_PER_USER = 4;

/**
 * audit-#7 regression: concurrent organization uploads from DIFFERENT members of the same organization
 * must not burst past `UPLOAD_MAX_PENDING_PER_ORGANIZATION`. Previously the organization count was checked
 * under only a per-user lock, so N members could each pass the same organization count and overshoot the
 * cap by N. The organization-scoped advisory lock (taken before the user lock) now serializes them.
 */
describe('UploadService organization pending-quota concurrency (database)', () => {
  const originalOrgCap = process.env.UPLOAD_MAX_PENDING_PER_ORGANIZATION;
  const originalUserCap = process.env.UPLOAD_MAX_PENDING_PER_USER;
  const originalBucket = process.env.S3_BUCKET;
  const originalUsePresignedPost = process.env.UPLOAD_USE_PRESIGNED_POST;

  beforeEach(async () => {
    await cleanupDatabase();
    process.env.UPLOAD_MAX_PENDING_PER_ORGANIZATION = String(ORG_CAP);
    // Keep the per-user cap high so ONLY the organization cap can bind in this test.
    process.env.UPLOAD_MAX_PENDING_PER_USER = '100';
    process.env.S3_BUCKET = process.env.S3_BUCKET ?? 'test-bucket';
    process.env.UPLOAD_USE_PRESIGNED_POST = 'false';
    resetEnvCacheForTests();
  });

  afterAll(() => {
    restore('UPLOAD_MAX_PENDING_PER_ORGANIZATION', originalOrgCap);
    restore('UPLOAD_MAX_PENDING_PER_USER', originalUserCap);
    restore('S3_BUCKET', originalBucket);
    restore('UPLOAD_USE_PRESIGNED_POST', originalUsePresignedPost);
    resetEnvCacheForTests();
  });

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  it('mints at most UPLOAD_MAX_PENDING_PER_ORGANIZATION slots across concurrent members', async () => {
    const owner = await createTestUser({ email: 'org-quota-owner@example.com' });
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const memberA = await createTestUser({ email: 'org-quota-a@example.com' });
    const memberB = await createTestUser({ email: 'org-quota-b@example.com' });
    const usersByPublicId = new Map([
      [memberA.public_id, memberA],
      [memberB.public_id, memberB],
    ]);

    const repository = new UploadRepository();
    const objectStorage = createObjectStoragePortMock();
    const userService = {
      requireUserRecordByPublicId: async (publicId: string) => usersByPublicId.get(publicId),
    } as unknown as UserService;
    const organizationService = {
      requireOrganizationByPublicId: async () => organization,
    } as unknown as OrganizationService;
    const authorizationService = {
      resolveUserOrganizationPermissions: vi
        .fn()
        .mockResolvedValue([UPLOAD_PERMISSIONS.UPLOAD_MANAGE]),
    } as unknown as AuthorizationService;
    const service = new UploadService(
      repository,
      userService,
      organizationService,
      objectStorage,
      authorizationService,
    );

    const launchFor = (memberPublicId: string) =>
      Array.from({ length: REQUESTS_PER_USER }, () =>
        service.createUpload(
          {
            purpose: 'organization-file',
            for: 'organization',
            organization_id: organization.public_id,
            content_type: 'image/png',
            file_name: 'doc.png',
            file_size: 1024,
          },
          memberPublicId,
        ),
      );

    const results = await Promise.allSettled([
      ...launchFor(memberA.public_id),
      ...launchFor(memberB.public_id),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    // Strict organization cap: exactly ORG_CAP succeed regardless of which member won each slot.
    expect(fulfilled.length).toBe(ORG_CAP);
    expect(rejected.length).toBe(REQUESTS_PER_USER * 2 - ORG_CAP);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(ValidationError);
    }

    const organizationPendingCount = await withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ userPublicId: owner.public_id }),
      () => repository.countPendingByOrganizationId(organization.id),
    );
    expect(organizationPendingCount).toBe(ORG_CAP);
    expect(objectStorage.createPresignedUploadUrl).toHaveBeenCalledTimes(ORG_CAP);
  });
});
