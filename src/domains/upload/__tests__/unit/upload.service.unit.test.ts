import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError, NotFoundError, ValidationError } from '@/shared/errors/index.js';
import { ExternalServiceError } from '@/infrastructure/outbound/index.js';
import { UploadService } from '@/domains/upload/upload.service.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { UploadRepository } from '@/domains/upload/upload.repository.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';

import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';
import type { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';

// UploadService now wraps repository work in the real principal wrapper, which
// opens a `database.transaction()` — passthrough so this stays a pure unit test.
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

vi.mock('@/shared/config/env.config.js', () => ({
  getEnv: vi.fn(() => ({
    S3_BUCKET: 'test-bucket',
    LOG_LEVEL: 'silent',
    UPLOAD_ALLOW_SVG: false,
    UPLOAD_MAX_PENDING_PER_USER: 100,
    UPLOAD_MAX_PENDING_PER_ORGANIZATION: 2_000,
  })),
  env: {
    S3_BUCKET: 'test-bucket',
    LOG_LEVEL: 'silent',
    UPLOAD_ALLOW_SVG: false,
    UPLOAD_MAX_PENDING_PER_USER: 100,
    UPLOAD_MAX_PENDING_PER_ORGANIZATION: 2_000,
  },
}));

const userPublicId = generatePublicId('user');
const uploadPublicId = generatePublicId('upload');
const user = { id: 1, public_id: userPublicId };
const uploadRow = {
  id: 2,
  public_id: uploadPublicId,
  user_id: 1,
  organization_id: null,
  file_name: 'avatar.png',
  file_key: 'avatars/user_public/key.png',
  mime_type: 'image/png',
  file_size: 1024,
  storage_provider: 's3',
  bucket: 'test-bucket',
  status: 'PENDING',
  created_at: new Date(),
  updated_at: new Date(),
  deleted_at: null,
};

describe('UploadService', () => {
  const repository = {
    create: vi.fn().mockResolvedValue(uploadRow),
    findByPublicId: vi.fn().mockResolvedValue(uploadRow),
    findByPublicIdForUser: vi.fn().mockResolvedValue(uploadRow),
    findActiveByUserIdAfter: vi.fn().mockResolvedValue([uploadRow]),
    findActiveByOrganizationIdAfter: vi.fn().mockResolvedValue([]),
    markStatus: vi.fn().mockResolvedValue(uploadRow),
    markStatusByPublicId: vi.fn().mockResolvedValue(uploadRow),
    markConfirmedByPublicId: vi.fn().mockResolvedValue(uploadRow),
    softDelete: vi.fn().mockResolvedValue(uploadRow),
    softDeleteByPublicId: vi.fn().mockResolvedValue(uploadRow),
    softDeleteAllByUserId: vi.fn().mockResolvedValue(1),
    softDeleteAllByOrganizationId: vi.fn().mockResolvedValue(2),
    countPendingByUserId: vi.fn().mockResolvedValue(0),
    countPendingByOrganizationId: vi.fn().mockResolvedValue(0),
    acquirePendingUploadQuotaLock: vi.fn().mockResolvedValue(undefined),
    // audit-#7: org-scoped pending-upload quota lock (no-op in unit tests).
    acquirePendingOrganizationQuotaLock: vi.fn().mockResolvedValue(undefined),
  } as unknown as UploadRepository;

  const userService = {
    requireUserRecordByPublicId: vi.fn().mockResolvedValue(user),
  } as unknown as UserService;

  const organizationService = {
    requireOrganizationByPublicId: vi.fn().mockResolvedValue({ id: 10, public_id: 'org_public' }),
    findOrganizationByInternalId: vi.fn().mockResolvedValue({ id: 10, public_id: 'org_public' }),
  } as unknown as OrganizationService;

  const objectStorage = createObjectStoragePortMock();
  const resolveUserOrganizationPermissions = vi.fn().mockResolvedValue(['upload:manage']);
  const authorizationService = {
    resolveUserOrganizationPermissions,
  } as unknown as AuthorizationService;
  const service = new UploadService(
    repository,
    userService,
    organizationService,
    objectStorage,
    authorizationService,
  );

  beforeEach(async () => {
    vi.clearAllMocks();
    resolveUserOrganizationPermissions.mockResolvedValue(['upload:manage']);
    const { getEnv } = await import('@/shared/config/env.config.js');
    vi.mocked(getEnv).mockReturnValue({
      S3_BUCKET: 'test-bucket',
      LOG_LEVEL: 'silent',
      UPLOAD_ALLOW_SVG: false,
      UPLOAD_MAX_PENDING_PER_USER: 100,
      UPLOAD_MAX_PENDING_PER_ORGANIZATION: 2_000,
    } as ReturnType<typeof getEnv>);
    vi.mocked(repository.findByPublicId).mockResolvedValue(uploadRow as never);
    vi.mocked(repository.softDeleteByPublicId).mockResolvedValue(uploadRow as never);
    vi.mocked(repository.countPendingByUserId).mockResolvedValue(0);
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(user as never);
  });

  it('createUpload returns presigned url for user avatar', async () => {
    const result = await service.createUpload(
      {
        purpose: 'avatar',
        for: 'user',
        content_type: 'image/png',
        file_name: 'avatar.png',
        file_size: 1024,
      },
      userPublicId,
    );
    expect(result.upload_url).toContain('https://');
    expect(repository.create).toHaveBeenCalled();
  });

  it('createUpload returns a presigned POST with content-length-range when enabled', async () => {
    const { getEnv } = await import('@/shared/config/env.config.js');
    // createUpload calls getEnv twice (once for the pending cap, once for the bucket/presign env).
    vi.mocked(getEnv).mockReturnValue({
      S3_BUCKET: 'test-bucket',
      LOG_LEVEL: 'silent',
      UPLOAD_ALLOW_SVG: false,
      UPLOAD_USE_PRESIGNED_POST: true,
      UPLOAD_MAX_PENDING_PER_USER: 100,
      UPLOAD_MAX_PENDING_PER_ORGANIZATION: 2_000,
    } as ReturnType<typeof getEnv>);
    vi.mocked(objectStorage.createPresignedUploadPost).mockResolvedValueOnce({
      url: 'https://s3.example/post',
      fields: { key: 'avatars/u/x.png', policy: 'p', 'Content-Type': 'image/png' },
    });

    const result = await service.createUpload(
      {
        purpose: 'avatar',
        for: 'user',
        content_type: 'image/png',
        file_name: 'avatar.png',
        file_size: 1024,
      },
      userPublicId,
    );

    expect(objectStorage.createPresignedUploadPost).toHaveBeenCalledWith(
      expect.objectContaining({ minContentLength: 1, maxContentLength: 2 * 1024 * 1024 }),
    );
    expect(objectStorage.createPresignedUploadUrl).not.toHaveBeenCalled();
    expect(result.upload_method).toBe('POST');
    expect(result.fields).toMatchObject({ 'Content-Type': 'image/png' });
  });

  it('createUpload rejects organization upload without manage permission', async () => {
    resolveUserOrganizationPermissions.mockResolvedValueOnce([]);

    await expect(
      service.createUpload(
        {
          purpose: 'organization-logo',
          for: 'organization',
          organization_id: 'org_public',
          content_type: 'image/png',
          file_name: 'logo.png',
          file_size: 2048,
        },
        userPublicId,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('getUpload returns serialized upload', async () => {
    const result = await service.getUpload(uploadPublicId, userPublicId);
    expect(result.id).toBe(uploadPublicId);
  });

  it('deleteUpload removes upload for user', async () => {
    await service.deleteUpload(uploadPublicId, userPublicId);
    expect(repository.softDeleteByPublicId).toHaveBeenCalled();
  });

  it('deleteUpload allows org managers to delete teammate-created organization uploads', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...uploadRow,
      user_id: 99,
      organization_id: 10,
    } as never);

    await service.deleteUpload(uploadPublicId, userPublicId);

    expect(objectStorage.deleteObject).toHaveBeenCalledWith(uploadRow.file_key);
    expect(repository.softDeleteByPublicId).toHaveBeenCalledWith(uploadPublicId);
  });

  it('deleteUpload hides personal uploads owned by another user', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...uploadRow,
      user_id: 99,
      organization_id: null,
    } as never);

    await expect(service.deleteUpload(uploadPublicId, userPublicId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
    expect(repository.softDeleteByPublicId).not.toHaveBeenCalled();
  });

  it('deleteUpload rejects org-scoped upload when caller lacks upload:manage', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...uploadRow,
      organization_id: 10,
    } as never);
    resolveUserOrganizationPermissions.mockResolvedValueOnce([]);

    await expect(service.deleteUpload(uploadPublicId, userPublicId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
    expect(repository.softDeleteByPublicId).not.toHaveBeenCalled();
  });

  it('deleteUpload 404s an org-scoped upload whose organization is undiscoverable (not 403 / not 500)', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValueOnce({
      ...uploadRow,
      organization_id: 10,
    } as never);
    // The organization row is gone (hard-deleted / undiscoverable). Access resolution must 404
    // BEFORE the permission check — never a 403 (which would imply the resource exists) and never
    // a 500 from dereferencing a null org. `Once` so this null does not leak to later tests
    // (`beforeEach` clears call history but does not re-stub `findOrganizationByInternalId`).
    vi.mocked(organizationService.findOrganizationByInternalId).mockResolvedValueOnce(
      null as never,
    );

    await expect(service.deleteUpload(uploadPublicId, userPublicId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(resolveUserOrganizationPermissions).not.toHaveBeenCalled();
  });

  it('sec-UP1: confirmUpload refuses a legacy in-place (non-pending-keyed) row and marks it FAILED', async () => {
    // A row whose file_key never went through the `pending/` indirection has finalKey === sourceKey,
    // so the presigned PUT URL the client used stays valid for its full TTL — an attacker could swap
    // a same-length / same-magic-byte payload AFTER confirm and the row would stay UPLOADED with
    // hostile content. Confirm must refuse (never run verify) and mark the row FAILED, forcing a
    // re-upload to a fresh pending key.
    vi.mocked(repository.findByPublicId).mockResolvedValueOnce({
      ...uploadRow,
      status: 'PENDING',
      file_key: 'avatars/user_public/legacy-in-place.png', // no `pending/` prefix
    } as never);

    await expect(service.confirmUpload(uploadPublicId, userPublicId)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(repository.markStatusByPublicId).toHaveBeenCalledWith(uploadPublicId, 'FAILED');
    // The security point: the object is NEVER verified/published from the client-writable key.
    expect(objectStorage.verifyUploadedObject).not.toHaveBeenCalled();
  });

  it('createUpload succeeds for organization logo with permission', async () => {
    const result = await service.createUpload(
      {
        purpose: 'organization-logo',
        for: 'organization',
        organization_id: 'org_public',
        content_type: 'image/png',
        file_name: 'logo.png',
        file_size: 2048,
      },
      userPublicId,
    );
    expect(result.upload_url).toContain('https://');
  });

  it('getUpload throws when upload is missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(service.getUpload(uploadPublicId, userPublicId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('tombstoneAllByUserId soft-deletes user uploads', async () => {
    vi.mocked(repository.findActiveByUserIdAfter).mockResolvedValue([uploadRow] as never);
    vi.mocked(repository.softDeleteAllByUserId).mockResolvedValue(1);
    const count = await service.tombstoneAllByUserId(1);
    expect(count).toBe(1);
  });

  it('tombstoneAllByOrganizationId soft-deletes organization uploads', async () => {
    vi.mocked(repository.findActiveByOrganizationIdAfter).mockResolvedValueOnce([] as never);
    vi.mocked(repository.softDeleteAllByOrganizationId).mockResolvedValue(2);
    const count = await service.tombstoneAllByOrganizationId(10);
    expect(count).toBe(2);
  });

  it('tombstoneAllByOrganizationId removes S3 objects in bounded batches before the DB tombstone (sec-UP8)', async () => {
    vi.mocked(repository.findActiveByOrganizationIdAfter)
      .mockResolvedValueOnce([
        { id: 1, file_key: 'organization-files/org/aaa.pdf' },
        { id: 2, file_key: 'organization-files/org/bbb.pdf' },
      ] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(objectStorage.deleteObject).mockResolvedValue(true);
    vi.mocked(repository.softDeleteAllByOrganizationId).mockResolvedValue(2);

    const count = await service.tombstoneAllByOrganizationId(10);

    expect(count).toBe(2);
    expect(objectStorage.deleteObject).toHaveBeenCalledTimes(2);
    expect(objectStorage.deleteObject).toHaveBeenCalledWith('organization-files/org/aaa.pdf');
    expect(objectStorage.deleteObject).toHaveBeenCalledWith('organization-files/org/bbb.pdf');
  });

  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

  it('confirmUpload marks UPLOADED when the object matches declared type, size, and magic bytes', async () => {
    // sec-UP1: confirm now requires pending-key indirection — legacy in-place
    // rows are refused. Use a pending-prefixed key so the happy path runs.
    const finalKey = uploadRow.file_key;
    const pendingKey = `pending/${finalKey}`;
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...uploadRow,
      file_key: pendingKey,
      status: 'PENDING',
    } as never);
    vi.mocked(objectStorage.verifyUploadedObject).mockResolvedValueOnce({
      contentType: 'image/png',
      contentLength: 1024,
    });
    vi.mocked(objectStorage.getObjectFirstBytes).mockResolvedValueOnce({
      body: PNG_MAGIC,
      contentType: 'image/png',
    });
    vi.mocked(objectStorage.copyObject).mockResolvedValueOnce(undefined);
    vi.mocked(objectStorage.deleteObject).mockResolvedValueOnce(true);
    vi.mocked(repository.markConfirmedByPublicId).mockResolvedValue({
      ...uploadRow,
      status: 'UPLOADED',
    } as never);

    const result = await service.confirmUpload(uploadPublicId, userPublicId);

    expect(objectStorage.verifyUploadedObject).toHaveBeenCalledWith(pendingKey, {
      contentType: 'image/png',
      contentLength: 1024,
    });
    // Row is repointed at the immutable final key (pending key is then deleted).
    expect(repository.markConfirmedByPublicId).toHaveBeenCalledWith(uploadPublicId, finalKey);
    expect(result.status).toBe('UPLOADED');
  });

  it('confirmUpload publishes the pending object to an immutable final key and deletes the pending key', async () => {
    // The client uploaded to a `pending/<finalKey>` object via its presigned URL. Confirm must
    // copy the verified bytes to the final key (which the client holds no URL for), repoint the
    // row, and remove the pending object — so the served object cannot be overwritten afterwards.
    const finalKey = 'avatars/user_public/key.png';
    const pendingKey = `pending/${finalKey}`;
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...uploadRow,
      file_key: pendingKey,
      status: 'PENDING',
    } as never);
    vi.mocked(objectStorage.verifyUploadedObject).mockResolvedValueOnce({
      contentType: 'image/png',
      contentLength: 1024,
    });
    vi.mocked(objectStorage.getObjectFirstBytes).mockResolvedValueOnce({
      body: PNG_MAGIC,
      contentType: 'image/png',
      eTag: '"verified-etag"',
    });
    vi.mocked(repository.markConfirmedByPublicId).mockResolvedValue({
      ...uploadRow,
      file_key: finalKey,
      status: 'UPLOADED',
    } as never);

    const result = await service.confirmUpload(uploadPublicId, userPublicId);

    // Verified against the pending object, then server-side copied to the final key (no re-upload).
    expect(objectStorage.verifyUploadedObject).toHaveBeenCalledWith(pendingKey, expect.anything());
    // sec-re-10: COPY pins the source ETag captured at HEAD so a replayed
    // PUT between verify and copy fails the COPY with PreconditionFailed.
    expect(objectStorage.copyObject).toHaveBeenCalledWith({
      sourceKey: pendingKey,
      destinationKey: finalKey,
      contentType: 'image/png',
      sourceETag: '"verified-etag"',
    });
    // No transforming put for a non-SVG; the row is repointed to the final key and pending removed.
    expect(objectStorage.putObject).not.toHaveBeenCalled();
    expect(repository.markConfirmedByPublicId).toHaveBeenCalledWith(uploadPublicId, finalKey);
    expect(objectStorage.deleteObject).toHaveBeenCalledWith(pendingKey);
    expect(result.status).toBe('UPLOADED');
  });

  it('sec-re-10: confirmUpload omits sourceETag when the HEAD response carries no ETag (legacy / unversioned mocks)', async () => {
    // Defensive: pre-fix call sites returned no ETag. The fix preserves the
    // legacy unprotected COPY when the HEAD response has no ETag — the
    // alternative (refusing to copy) would gate publishes on a header the
    // platform may not always supply (e.g. some MinIO test setups).
    const finalKey = 'avatars/user_public/key2.png';
    const pendingKey = `pending/${finalKey}`;
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...uploadRow,
      file_key: pendingKey,
      status: 'PENDING',
    } as never);
    vi.mocked(objectStorage.verifyUploadedObject).mockResolvedValueOnce({
      contentType: 'image/png',
      contentLength: 1024,
    });
    vi.mocked(objectStorage.getObjectFirstBytes).mockResolvedValueOnce({
      body: PNG_MAGIC,
      contentType: 'image/png',
      // No eTag → legacy unprotected path.
    });
    vi.mocked(repository.markConfirmedByPublicId).mockResolvedValue({
      ...uploadRow,
      file_key: finalKey,
      status: 'UPLOADED',
    } as never);

    await service.confirmUpload(uploadPublicId, userPublicId);

    expect(objectStorage.copyObject).toHaveBeenCalledWith({
      sourceKey: pendingKey,
      destinationKey: finalKey,
      contentType: 'image/png',
      // Note: no `sourceETag` key in the payload.
    });
  });

  it('createUpload presigns a pending-namespaced key, never the final servable key', async () => {
    await service.createUpload(
      {
        purpose: 'avatar',
        for: 'user',
        content_type: 'image/png',
        file_name: 'avatar.png',
        file_size: 1024,
      },
      userPublicId,
    );
    const presignArgs = vi.mocked(objectStorage.createPresignedUploadUrl).mock.calls[0]?.[0];
    expect(presignArgs?.key).toMatch(/^pending\/avatars\//);
    // The row stores the pending key so the pending-sweep worker can reclaim abandoned uploads.
    const createArgs = vi.mocked(repository.create).mock.calls[0]?.[0];
    expect(createArgs?.file_key).toMatch(/^pending\/avatars\//);
  });

  it('createUpload returns the final attach key while presigning the pending object', async () => {
    const result = await service.createUpload(
      {
        purpose: 'avatar',
        for: 'user',
        content_type: 'image/png',
        file_name: 'avatar.png',
        file_size: 1024,
      },
      userPublicId,
    );

    const presignArgs = vi.mocked(objectStorage.createPresignedUploadUrl).mock.calls[0]?.[0];
    const createArgs = vi.mocked(repository.create).mock.calls[0]?.[0];
    expect(result.key).toMatch(/^avatars\//);
    expect(result.key).not.toMatch(/^pending\//);
    expect(presignArgs?.key).toBe(`pending/${result.key}`);
    expect(createArgs?.file_key).toBe(`pending/${result.key}`);
  });

  // The avatar/logo purposes have dedicated key builders (covered above + in the key-builder units).
  // The generic *-file purposes fall through the else-branch — `${keyPrefix}/${ownerSegment}/${uuid}`
  // — whose owner segment the attach-ownership check later relies on. Pin the shape for both.
  it('createUpload builds a user-files/{userPublicId}/ key for the user-file purpose', async () => {
    const result = await service.createUpload(
      {
        purpose: 'user-file',
        for: 'user',
        content_type: 'image/png',
        file_name: 'doc.png',
        file_size: 1024,
      },
      userPublicId,
    );

    expect(result.key).toMatch(new RegExp(`^user-files/${userPublicId}/[0-9a-f-]{36}\\.png$`));
    expect(result.key).not.toMatch(/^pending\//);
    const presignArgs = vi.mocked(objectStorage.createPresignedUploadUrl).mock.calls[0]?.[0];
    expect(presignArgs?.key).toBe(`pending/${result.key}`);
  });

  it('createUpload builds an organization-files/{organizationPublicId}/ key for the organization-file purpose', async () => {
    const result = await service.createUpload(
      {
        purpose: 'organization-file',
        for: 'organization',
        organization_id: 'org_public',
        content_type: 'image/png',
        file_name: 'doc.png',
        file_size: 1024,
      },
      userPublicId,
    );

    expect(result.key).toMatch(/^organization-files\/org_public\/[0-9a-f-]{36}\.png$/);
    expect(result.key).not.toMatch(/^pending\//);
  });

  it('confirmUpload allows org managers to confirm teammate-created organization uploads', async () => {
    // sec-UP1: must be pending-keyed.
    const finalKey = uploadRow.file_key;
    const pendingKey = `pending/${finalKey}`;
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...uploadRow,
      file_key: pendingKey,
      user_id: 99,
      organization_id: 10,
      status: 'PENDING',
    } as never);
    vi.mocked(objectStorage.verifyUploadedObject).mockResolvedValueOnce({
      contentType: 'image/png',
      contentLength: 1024,
    });
    vi.mocked(objectStorage.getObjectFirstBytes).mockResolvedValueOnce({
      body: PNG_MAGIC,
      contentType: 'image/png',
    });
    vi.mocked(objectStorage.copyObject).mockResolvedValueOnce(undefined);
    vi.mocked(objectStorage.deleteObject).mockResolvedValueOnce(true);
    vi.mocked(repository.markConfirmedByPublicId).mockResolvedValue({
      ...uploadRow,
      user_id: 99,
      organization_id: 10,
      status: 'UPLOADED',
    } as never);

    const result = await service.confirmUpload(uploadPublicId, userPublicId);

    expect(result.status).toBe('UPLOADED');
    expect(repository.markConfirmedByPublicId).toHaveBeenCalledWith(uploadPublicId, finalKey);
  });

  it('confirmUpload marks FAILED when magic bytes do not match the declared type (spoofed content)', async () => {
    // sec-UP1: pending-keyed so we reach the magic-byte check rather than the legacy refusal.
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...uploadRow,
      file_key: `pending/${uploadRow.file_key}`,
      status: 'PENDING',
    } as never);
    vi.mocked(objectStorage.verifyUploadedObject).mockResolvedValueOnce({
      contentType: 'image/png',
      contentLength: 1024,
    });
    // HEAD says image/png, but the stored bytes are HTML — a stored-XSS / content-spoof attempt.
    vi.mocked(objectStorage.getObjectFirstBytes).mockResolvedValueOnce({
      body: Buffer.from('<html><script>alert(1)</script></html>'),
      contentType: 'image/png',
    });

    await expect(service.confirmUpload(uploadPublicId, userPublicId)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(repository.markStatusByPublicId).toHaveBeenCalledWith(uploadPublicId, 'FAILED');
  });

  it('confirmUpload marks FAILED and throws when object size does not match', async () => {
    // sec-UP1: pending-keyed so we exercise the size-mismatch path, not the legacy refusal.
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...uploadRow,
      file_key: `pending/${uploadRow.file_key}`,
      status: 'PENDING',
    } as never);
    vi.mocked(objectStorage.verifyUploadedObject).mockResolvedValueOnce({
      contentType: 'image/png',
      contentLength: 9999,
    });

    await expect(service.confirmUpload(uploadPublicId, userPublicId)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(repository.markStatusByPublicId).toHaveBeenCalledWith(uploadPublicId, 'FAILED');
  });

  it('UPLOAD-03: confirmUpload rethrows a transient storage error WITHOUT marking FAILED', async () => {
    // sec-UP1: pending-keyed so we reach the verify step rather than the legacy refusal.
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...uploadRow,
      file_key: `pending/${uploadRow.file_key}`,
      status: 'PENDING',
    } as never);
    // A transient S3 blip surfaces as ExternalServiceError (503), not a verification miss.
    vi.mocked(objectStorage.verifyUploadedObject).mockRejectedValueOnce(
      new ExternalServiceError({ integration: 's3', category: 'timeout' }),
    );

    await expect(service.confirmUpload(uploadPublicId, userPublicId)).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
    // The upload must stay PENDING for retry — never permanently FAILED on a blip.
    expect(repository.markStatusByPublicId).not.toHaveBeenCalledWith(uploadPublicId, 'FAILED');
  });

  it('confirmUpload sanitizes a stored SVG before marking UPLOADED', async () => {
    // sec-UP1: pending-keyed; the SVG is sanitized in transit from the pending
    // key to the final key (no in-place mutation of the writable pending key).
    const finalKey = 'avatars/user_public/key.svg';
    const pendingKey = `pending/${finalKey}`;
    const svgRow = {
      ...uploadRow,
      file_name: 'logo.svg',
      file_key: pendingKey,
      mime_type: 'image/svg+xml',
      file_size: 80,
      status: 'PENDING',
    };
    vi.mocked(repository.findByPublicId).mockResolvedValue(svgRow as never);
    vi.mocked(repository.markConfirmedByPublicId).mockResolvedValue({
      ...svgRow,
      file_key: finalKey,
      status: 'UPLOADED',
    } as never);
    vi.mocked(objectStorage.verifyUploadedObject).mockResolvedValueOnce({
      contentType: 'image/svg+xml',
      contentLength: 80,
    });
    const hostileSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><circle r="5"/></svg>',
      'utf8',
    );
    vi.mocked(objectStorage.getObject).mockResolvedValueOnce({
      body: hostileSvg,
      contentType: 'image/svg+xml',
    });
    vi.mocked(objectStorage.deleteObject).mockResolvedValueOnce(true);

    const result = await service.confirmUpload(uploadPublicId, userPublicId);

    expect(objectStorage.getObject).toHaveBeenCalledWith(pendingKey);
    expect(objectStorage.putObject).toHaveBeenCalledTimes(1);
    const putArgs = vi.mocked(objectStorage.putObject).mock.calls[0]?.[0];
    expect(putArgs?.key).toBe(finalKey);
    expect(putArgs?.contentType).toBe('image/svg+xml');
    // Assert the body is a Buffer instead of optional-chaining into it: `putArgs?.body`
    // short-circuits to undefined, and the cast cannot stop `.toString()` throwing a bare
    // TypeError that hides which expectation actually failed. This is the SVG-sanitization
    // test — if the upload never happened it must say so, not die on a null dereference.
    const uploadedBody = putArgs?.body;
    expect(Buffer.isBuffer(uploadedBody)).toBe(true);
    const rewritten = (uploadedBody as Buffer).toString('utf8');
    expect(rewritten).not.toMatch(/<script/i);
    expect(rewritten).not.toMatch(/\bon\w+\s*=/i);
    expect(result.status).toBe('UPLOADED');
  });

  it('confirmUpload marks FAILED when an SVG sanitizes to empty content (hostile/zero-byte)', async () => {
    // sec-UP1: pending-keyed so we exercise the sanitizer-empty path.
    const svgRow = {
      ...uploadRow,
      file_key: 'pending/avatars/user_public/empty.svg',
      mime_type: 'image/svg+xml',
      file_size: 12,
      status: 'PENDING',
    };
    vi.mocked(repository.findByPublicId).mockResolvedValue(svgRow as never);
    vi.mocked(objectStorage.verifyUploadedObject).mockResolvedValueOnce({
      contentType: 'image/svg+xml',
      contentLength: 12,
    });
    vi.mocked(objectStorage.getObject).mockResolvedValueOnce({
      body: Buffer.from('<script>alert(1)</script>', 'utf8'),
      contentType: 'image/svg+xml',
    });

    await expect(service.confirmUpload(uploadPublicId, userPublicId)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(repository.markStatusByPublicId).toHaveBeenCalledWith(uploadPublicId, 'FAILED');
    expect(objectStorage.putObject).not.toHaveBeenCalled();
  });

  it('confirmUpload is idempotent for already-UPLOADED rows', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...uploadRow,
      status: 'UPLOADED',
    } as never);

    const result = await service.confirmUpload(uploadPublicId, userPublicId);
    expect(result.status).toBe('UPLOADED');
    expect(objectStorage.verifyUploadedObject).not.toHaveBeenCalled();
    expect(repository.markStatusByPublicId).not.toHaveBeenCalled();
  });

  it('confirmUpload rejects when the upload is not pending', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...uploadRow,
      status: 'FAILED',
    } as never);

    await expect(service.confirmUpload(uploadPublicId, userPublicId)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(objectStorage.verifyUploadedObject).not.toHaveBeenCalled();
  });

  it('confirmUpload throws NotFound when the upload is missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(service.confirmUpload(uploadPublicId, userPublicId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('createUpload rejects when the user is at the PENDING upload cap', async () => {
    vi.mocked(repository.countPendingByUserId).mockResolvedValueOnce(100);

    await expect(
      service.createUpload(
        {
          purpose: 'avatar',
          for: 'user',
          content_type: 'image/png',
          file_name: 'avatar.png',
          file_size: 1024,
        },
        userPublicId,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    // Reservation takes the per-user advisory lock before counting, and never inserts
    // a row or mints a presigned URL once the cap is reached.
    expect(repository.acquirePendingUploadQuotaLock).toHaveBeenCalledWith(user.id);
    expect(repository.countPendingByUserId).toHaveBeenCalledWith(user.id);
    expect(repository.create).not.toHaveBeenCalled();
    expect(objectStorage.createPresignedUploadUrl).not.toHaveBeenCalled();
    expect(objectStorage.createPresignedUploadPost).not.toHaveBeenCalled();
  });

  it('createUpload reserves the pending slot before minting the presigned URL', async () => {
    const callOrder: string[] = [];
    vi.mocked(repository.acquirePendingUploadQuotaLock).mockImplementationOnce(async () => {
      callOrder.push('lock');
    });
    vi.mocked(repository.create).mockImplementationOnce(async () => {
      callOrder.push('create');
      return uploadRow as never;
    });
    vi.mocked(objectStorage.createPresignedUploadUrl).mockImplementationOnce(async () => {
      callOrder.push('presign');
      return 'https://presigned.example/upload';
    });

    await service.createUpload(
      {
        purpose: 'avatar',
        for: 'user',
        content_type: 'image/png',
        file_name: 'avatar.png',
        file_size: 1024,
      },
      userPublicId,
    );

    expect(callOrder).toEqual(['lock', 'create', 'presign']);
  });

  it('createUpload allows when pending count is just below the cap', async () => {
    vi.mocked(repository.countPendingByUserId).mockResolvedValueOnce(99);

    const result = await service.createUpload(
      {
        purpose: 'avatar',
        for: 'user',
        content_type: 'image/png',
        file_name: 'avatar.png',
        file_size: 1024,
      },
      userPublicId,
    );

    expect(result.upload_url).toContain('https://');
    expect(repository.create).toHaveBeenCalled();
  });

  it('createUpload throws when S3 bucket is not configured', async () => {
    const { getEnv } = await import('@/shared/config/env.config.js');
    vi.mocked(getEnv).mockReturnValue({
      S3_BUCKET: undefined,
      LOG_LEVEL: 'silent',
      UPLOAD_ALLOW_SVG: false,
      UPLOAD_MAX_PENDING_PER_USER: 100,
      UPLOAD_MAX_PENDING_PER_ORGANIZATION: 2_000,
    } as ReturnType<typeof getEnv>);
    await expect(
      service.createUpload(
        {
          purpose: 'avatar',
          for: 'user',
          content_type: 'image/png',
          file_name: 'avatar.png',
          file_size: 1024,
        },
        userPublicId,
      ),
    ).rejects.toThrow('S3_BUCKET is not configured');
  });
});
