import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import { UploadService } from '@/domains/upload/upload.service.js';
import { UPLOAD_STATUS } from '@/domains/upload/upload.constants.js';
import type { UploadRepository, UploadRow } from '@/domains/upload/upload.repository.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';

vi.mock('@/shared/config/env.config.js', () => ({
  getEnv: vi.fn(() => ({ S3_BUCKET: 'test-bucket', LOG_LEVEL: 'silent' })),
  env: { S3_BUCKET: 'test-bucket', LOG_LEVEL: 'silent' },
}));

/**
 * Direct coverage for the cross-domain attach gate — the only thing standing between an
 * unconfirmed, FAILED, or *foreign* upload row and being attached as a user avatar or an
 * organization logo. Every caller (user.service `updateAvatar`, organization.service
 * `updateLogo`) stubs these two methods with `vi.fn()`, so before this file the gate itself
 * had no assertions anywhere in the suite.
 *
 * `findByFileKey` deliberately does NO owner scoping in SQL (upload.repository.ts:76), which
 * is exactly why `assertKeyConfirmedForOwner` re-checks `user_id` / `organization_id` in code
 * (sec-UP5). These cases pin that code-level check so it cannot be quietly dropped.
 */
describe('UploadService — assertKeyConfirmed / assertKeyConfirmedForOwner', () => {
  const USER_INTERNAL_ID = 1;
  const ORGANIZATION_INTERNAL_ID = 10;
  const FILE_KEY = 'avatars/user_public_abc/object.png';

  const findByFileKey = vi.fn();
  const repository = { findByFileKey } as unknown as UploadRepository;

  const service = new UploadService(
    repository,
    {} as unknown as UserService,
    {} as unknown as OrganizationService,
    createObjectStoragePortMock(),
    {} as unknown as AuthorizationService,
  );

  /** A row shaped like `upload.uploads`, defaulted to the confirmed/user-owned happy case. */
  function uploadRow(overrides: Partial<UploadRow> = {}): UploadRow {
    return {
      id: 2,
      public_id: 'upload_public_abc',
      user_id: USER_INTERNAL_ID,
      organization_id: null,
      file_name: 'avatar.png',
      file_key: FILE_KEY,
      mime_type: 'image/png',
      file_size: 1024,
      storage_provider: 's3',
      bucket: 'test-bucket',
      status: UPLOAD_STATUS.UPLOADED,
      metadata: {},
      uploaded_at: new Date(),
      deleted_at: null,
      created_at: new Date(),
      updated_at: new Date(),
      created_by_user_id: USER_INTERNAL_ID,
      ...overrides,
    } as UploadRow;
  }

  /** Runs `operation` once, returning the ValidationError it must have thrown. */
  async function captureRejection(operation: () => Promise<void>): Promise<ValidationError> {
    try {
      await operation();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      return error as ValidationError;
    }
    throw new Error('expected the call to reject with a ValidationError, but it resolved');
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('assertKeyConfirmed', () => {
    it('throws when no upload row exists for the key', async () => {
      findByFileKey.mockResolvedValue(null);

      await expect(service.assertKeyConfirmed(FILE_KEY)).rejects.toBeInstanceOf(ValidationError);
      expect(findByFileKey).toHaveBeenCalledWith(FILE_KEY);
    });

    it('throws when the row is still PENDING (client never confirmed)', async () => {
      findByFileKey.mockResolvedValue(uploadRow({ status: UPLOAD_STATUS.PENDING }));

      await expect(service.assertKeyConfirmed(FILE_KEY)).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws when the row is FAILED (confirm ran and rejected the object)', async () => {
      findByFileKey.mockResolvedValue(uploadRow({ status: UPLOAD_STATUS.FAILED }));

      await expect(service.assertKeyConfirmed(FILE_KEY)).rejects.toBeInstanceOf(ValidationError);
    });

    it('resolves for an UPLOADED row', async () => {
      findByFileKey.mockResolvedValue(uploadRow());

      await expect(service.assertKeyConfirmed(FILE_KEY)).resolves.toBeUndefined();
    });
  });

  describe('assertKeyConfirmedForOwner', () => {
    it('throws when neither owner id is supplied', async () => {
      // Guard against a caller that forgets to bind an owner: without it the function
      // would degrade into plain assertKeyConfirmed and silently lose the sec-UP5 check.
      await expect(
        service.assertKeyConfirmedForOwner({ fileKey: FILE_KEY }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(findByFileKey).not.toHaveBeenCalled();
    });

    it('throws when no upload row exists for the key', async () => {
      findByFileKey.mockResolvedValue(null);

      await expect(
        service.assertKeyConfirmedForOwner({
          fileKey: FILE_KEY,
          userInternalId: USER_INTERNAL_ID,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('throws when the row exists and is owned but is not UPLOADED', async () => {
      findByFileKey.mockResolvedValue(
        uploadRow({ status: UPLOAD_STATUS.PENDING, user_id: USER_INTERNAL_ID }),
      );

      await expect(
        service.assertKeyConfirmedForOwner({
          fileKey: FILE_KEY,
          userInternalId: USER_INTERNAL_ID,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    // sec-UP5 — the core cross-tenant case: a confirmed row belonging to somebody else.
    it('throws when user_id does not match the requesting owner (sec-UP5)', async () => {
      findByFileKey.mockResolvedValue(uploadRow({ user_id: USER_INTERNAL_ID + 1 }));

      await expect(
        service.assertKeyConfirmedForOwner({
          fileKey: FILE_KEY,
          userInternalId: USER_INTERNAL_ID,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    // An organization-scoped row still carries its uploader's `user_id`, so this also proves the
    // organization check is independent of the user check rather than a fallback for it.
    it('throws when organization_id does not match the requesting organization', async () => {
      findByFileKey.mockResolvedValue(uploadRow({ organization_id: ORGANIZATION_INTERNAL_ID + 1 }));

      await expect(
        service.assertKeyConfirmedForOwner({
          fileKey: FILE_KEY,
          organizationInternalId: ORGANIZATION_INTERNAL_ID,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('resolves for an UPLOADED row whose user_id matches', async () => {
      findByFileKey.mockResolvedValue(uploadRow({ user_id: USER_INTERNAL_ID }));

      await expect(
        service.assertKeyConfirmedForOwner({
          fileKey: FILE_KEY,
          userInternalId: USER_INTERNAL_ID,
        }),
      ).resolves.toBeUndefined();
    });

    it('resolves for an UPLOADED row whose organization_id matches', async () => {
      findByFileKey.mockResolvedValue(uploadRow({ organization_id: ORGANIZATION_INTERNAL_ID }));

      await expect(
        service.assertKeyConfirmedForOwner({
          fileKey: FILE_KEY,
          organizationInternalId: ORGANIZATION_INTERNAL_ID,
        }),
      ).resolves.toBeUndefined();
    });

    /**
     * The non-leak property the TSDoc claims (upload.service.ts:352): a mismatch must be
     * indistinguishable from a missing row, so a caller cannot probe whether some other
     * tenant's key exists. The four data-dependent refusals must therefore be byte-identical,
     * and the owner-missing guard — which is a programming error, not attacker-observable —
     * must at least share the same code/status/messageKey.
     */
    it('emits an indistinguishable payload for every refusal', async () => {
      // Sequential, not Promise.all — every case reprograms the same findByFileKey mock.
      const dataDependentRefusals: ValidationError[] = [];

      findByFileKey.mockResolvedValue(null);
      dataDependentRefusals.push(
        await captureRejection(() =>
          service.assertKeyConfirmedForOwner({
            fileKey: FILE_KEY,
            userInternalId: USER_INTERNAL_ID,
          }),
        ),
      );

      findByFileKey.mockResolvedValue(uploadRow({ status: UPLOAD_STATUS.PENDING }));
      dataDependentRefusals.push(
        await captureRejection(() =>
          service.assertKeyConfirmedForOwner({
            fileKey: FILE_KEY,
            userInternalId: USER_INTERNAL_ID,
          }),
        ),
      );

      findByFileKey.mockResolvedValue(uploadRow({ user_id: USER_INTERNAL_ID + 1 }));
      dataDependentRefusals.push(
        await captureRejection(() =>
          service.assertKeyConfirmedForOwner({
            fileKey: FILE_KEY,
            userInternalId: USER_INTERNAL_ID,
          }),
        ),
      );

      findByFileKey.mockResolvedValue(uploadRow({ organization_id: ORGANIZATION_INTERNAL_ID + 1 }));
      dataDependentRefusals.push(
        await captureRejection(() =>
          service.assertKeyConfirmedForOwner({
            fileKey: FILE_KEY,
            organizationInternalId: ORGANIZATION_INTERNAL_ID,
          }),
        ),
      );

      const fingerprints = dataDependentRefusals.map((error) =>
        JSON.stringify({
          code: error.code,
          statusCode: error.statusCode,
          messageKey: error.messageKey,
          message: error.message,
          details: error.details,
          errors: error.errors,
        }),
      );
      expect(fingerprints).toHaveLength(4);
      expect(new Set(fingerprints).size).toBe(1);

      // The owner-missing guard carries its own developer-facing detail string; it must still
      // be the same error class and public shape so it never becomes an oracle either.
      const ownerMissing = await captureRejection(() =>
        service.assertKeyConfirmedForOwner({ fileKey: FILE_KEY }),
      );
      expect({
        code: ownerMissing.code,
        statusCode: ownerMissing.statusCode,
        messageKey: ownerMissing.messageKey,
      }).toEqual({
        code: dataDependentRefusals[0]!.code,
        statusCode: dataDependentRefusals[0]!.statusCode,
        messageKey: dataDependentRefusals[0]!.messageKey,
      });
    });
  });
});
