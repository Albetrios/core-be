import { randomUUID } from 'node:crypto';
import type { ObjectStoragePort } from '@/infrastructure/storage/object-storage.port.js';
import { ExternalServiceError } from '@/infrastructure/outbound/index.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { getEnv } from '@/shared/config/env.config.js';
import {
  ConfigurationError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/shared/errors/index.js';
import type { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import {
  UPLOAD_PURPOSE_CONFIG,
  UPLOAD_PURPOSES,
  PRESIGNED_URL_EXPIRY_SECONDS,
  UPLOAD_OFFBOARDING_DELETE_BATCH_SIZE,
  UPLOAD_OFFBOARDING_DELETE_CONCURRENCY,
  UPLOAD_STATUS,
  UPLOAD_TARGETS,
  buildOrganizationLogoKeyPrefix,
  buildPendingObjectKey,
  buildUserAvatarKeyPrefix,
  stripPendingObjectKeyPrefix,
} from './upload.constants.js';
import { getCanonicalExtensionForContentType } from './utils/upload-content-type.util.js';
import { isSvgContentType, sanitizeSvgBuffer } from './utils/upload-svg.util.js';
import {
  isMagicByteVerifiable,
  verifyFileMagicBytes,
} from '@/shared/utils/validation/file-magic.util.js';
import { UPLOAD_PERMISSIONS } from './upload.permissions.js';
import type { CreateUploadInput, UploadCreateOutput, UploadDetailOutput } from './upload.types.js';
import type { UploadRepository, UploadRow } from './upload.repository.js';
import { serializeUploadCreate, serializeUploadDetail } from './upload.serializer.js';
import { validateUploadPublicIdParam } from './upload.validator.js';
import {
  resolveVerifiedOrganizationPrincipalScope,
  resolveVerifiedUserPrincipalScope,
} from '@/shared/utils/identity/verified-principal-scope.util.js';
import { withPrincipalDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';

/** Inputs for {@link UploadService}'s private atomic PENDING-slot reservation. */
interface ReservePendingUploadSlotParams {
  userInternalId: number;
  userPublicId: string;
  organizationInternalId: number | null;
  organizationPublicId: string | null;
  fileName: string;
  fileKey: string;
  contentType: string;
  fileSize: number;
  bucket: string;
}

/**
 * Owns the upload lifecycle behind the public upload routes and the
 * cross-domain offboarding hooks.
 *
 * @remarks
 * - **Algorithm:** {@link UploadService.createUpload} resolves owner/organization
 *   context, computes the S3 key from {@link UPLOAD_PURPOSE_CONFIG} + a canonical
 *   extension, then atomically reserves the PENDING row inside
 *   {@link withPrincipalDatabaseContext (user scope)} (a per-user advisory lock guards the
 *   pending-count check + insert in one transaction so the quota holds under
 *   concurrency and the owner-access RLS policy authorizes the write) and only
 *   AFTER the slot is committed requests a presigned URL (PUT or POST per
 *   `UPLOAD_USE_PRESIGNED_POST`) from the storage adapter — concurrent callers
 *   can never mint presigned slots beyond the quota.
 *   {@link UploadService.confirmUpload} HEADs the object, compares
 *   content-type/length against the declared values, and transitions
 *   `PENDING` → `UPLOADED` (idempotent for already-confirmed rows) or
 *   `FAILED` on mismatch. {@link UploadService.deleteUpload} performs a
 *   best-effort S3 delete then soft-deletes the row.
 * - **Failure modes:** quota exceeded → `ValidationError`; missing org
 *   permission → `ForbiddenError`; unknown public id or owner mismatch →
 *   `NotFoundError`; S3 verification failure → row moved to `FAILED` and a
 *   `ValidationError` raised so the caller does not attach an unverified
 *   object; missing `S3_BUCKET` → `ConfigurationError`. A presign failure that
 *   occurs AFTER a slot is reserved propagates to the caller and leaves the
 *   PENDING row in place; it is never confirmed, so the pending-sweep worker
 *   reclaims it once it ages past the sweep cutoff.
 * - **Side effects:** issues presigned S3 URLs, HEADs/DELETEs S3 objects,
 *   inserts/updates `upload.uploads`, and emits no in-process events.
 *   Storage access is abstracted behind {@link ObjectStoragePort} so tests
 *   can substitute an in-memory adapter.
 * - **Notes:** offboarding hooks
 *   ({@link UploadService.tombstoneAllByUserId} /
 *   {@link UploadService.tombstoneAllByOrganizationId}) only soft-delete rows;
 *   user offboarding additionally attempts per-object S3 deletes, while
 *   organization tombstones defer object removal to the retention worker.
 *   `assertKeyConfirmed` is the gate cross-domain consumers (avatar/logo
 *   attach) call before linking an upload — it never authorizes ownership,
 *   which the caller enforces by key prefix.
 */
export class UploadService {
  constructor(
    private readonly repository: UploadRepository,
    private readonly userService: UserService,
    private readonly organizationService: OrganizationService,
    private readonly objectStorage: ObjectStoragePort,
    private readonly authorizationService: AuthorizationService,
  ) {}

  async createUpload(input: CreateUploadInput, userPublicId: string): Promise<UploadCreateOutput> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);

    const organizationInternalId = await this.resolveUploadOrganizationInternalId(
      input,
      userPublicId,
    );
    const config = UPLOAD_PURPOSE_CONFIG[input.purpose];
    const extension = getCanonicalExtensionForContentType(input.content_type);
    const ownerSegment =
      input.for === UPLOAD_TARGETS.ORGANIZATION ? input.organization_id! : userPublicId;
    let key: string;
    if (input.purpose === UPLOAD_PURPOSES.AVATAR) {
      key = `${buildUserAvatarKeyPrefix(userPublicId)}${randomUUID()}${extension}`;
    } else if (input.purpose === UPLOAD_PURPOSES.ORGANIZATION_LOGO) {
      key = `${buildOrganizationLogoKeyPrefix(input.organization_id!)}${randomUUID()}${extension}`;
    } else {
      key = `${config.keyPrefix}/${ownerSegment}/${randomUUID()}${extension}`;
    }

    const environment = getEnv();
    const bucket = environment.S3_BUCKET;
    if (!bucket) {
      throw new ConfigurationError('S3_BUCKET is not configured');
    }

    // The client uploads to a `pending/<finalKey>` object via its presigned URL. On confirm the
    // verified bytes are published to `finalKey` (which the client never holds a URL for), so the
    // served object cannot be overwritten through the still-valid presigned upload URL.
    const pendingKey = buildPendingObjectKey(key);

    // Reserve the PENDING row BEFORE presigning so the per-user quota is enforced atomically
    // against concurrent requests (advisory lock + count + insert in one transaction). The
    // presigned URL is minted only after a slot is committed — concurrent callers can never
    // over-provision presigned slots beyond the quota.
    const row = await this.reservePendingUploadSlot({
      userInternalId: user.id,
      userPublicId,
      organizationInternalId,
      organizationPublicId:
        input.for === UPLOAD_TARGETS.ORGANIZATION ? (input.organization_id ?? null) : null,
      fileName: input.file_name,
      fileKey: pendingKey,
      contentType: input.content_type,
      fileSize: input.file_size,
      bucket,
    });

    let uploadUrl: string;
    let uploadMethod: 'PUT' | 'POST';
    let fields: Record<string, string> | undefined;

    if (environment.UPLOAD_USE_PRESIGNED_POST) {
      // S3 enforces the content-length-range at upload time, rejecting empty/oversized bodies.
      const post = await this.objectStorage.createPresignedUploadPost({
        key: pendingKey,
        contentType: input.content_type,
        minContentLength: 1,
        maxContentLength: config.maxSize,
        expiresInSeconds: PRESIGNED_URL_EXPIRY_SECONDS,
        metadata: {
          purpose: input.purpose,
          'declared-type': input.content_type,
          owner: userPublicId,
        },
      });
      uploadUrl = post.url;
      fields = post.fields;
      uploadMethod = 'POST';
    } else {
      uploadUrl = await this.objectStorage.createPresignedUploadUrl({
        key: pendingKey,
        contentType: input.content_type,
        contentLength: input.file_size,
        expiresInSeconds: PRESIGNED_URL_EXPIRY_SECONDS,
      });
      uploadMethod = 'PUT';
    }

    const expiresAt = new Date(Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000);

    return serializeUploadCreate({
      id: row.public_id,
      upload_url: uploadUrl,
      key,
      expires_at: expiresAt,
      upload_method: uploadMethod,
      ...(fields !== undefined ? { fields } : {}),
    });
  }

  /**
   * Atomically reserves a PENDING upload row while enforcing the per-user (and, for org
   * uploads, the per-org) quota.
   *
   * Runs the advisory lock, pending-count check, and insert inside a single RLS database
   * transaction so concurrent create-upload requests are serialized: a request can only
   * insert when the committed pending count is still below the cap. The advisory lock
   * releases at COMMIT, after which the next waiter sees the freshly committed row. Stops
   * storage/bandwidth cost abuse from a flood of presign requests that previously all
   * passed a non-atomic count and then over-inserted.
   *
   * @remarks
   * - **sec-r7/M4:** the RLS context MUST match the row being inserted. An org-scoped
   *   upload (`organization_id` set) only satisfies the `uploads_tenant_isolation`
   *   `WITH CHECK` under `withPrincipalDatabaseContext` (`app.current_organization_public_id`);
   *   under `withPrincipalDatabaseContext (user scope)` the INSERT is rejected by RLS as the production
   *   `core_be_app` role (FORCE RLS) — every org-logo / org-file upload would 500.
   *   User-scoped uploads (`organization_id` NULL, e.g. avatars) run under
   *   `withPrincipalDatabaseContext (user scope)` so the `uploads_owner_access` policy applies. The org cap
   *   is the primary abuse guard for org uploads (sec-UP4); the per-user cap is enforced
   *   against the user's pending rows visible in the active context.
   */
  private async reservePendingUploadSlot(
    params: ReservePendingUploadSlotParams,
  ): Promise<UploadRow> {
    const {
      userInternalId,
      userPublicId,
      organizationInternalId,
      organizationPublicId,
      fileName,
      fileKey,
      contentType,
      fileSize,
      bucket,
    } = params;
    const environment = getEnv();
    const pendingCap = environment.UPLOAD_MAX_PENDING_PER_USER;
    const orgPendingCap = environment.UPLOAD_MAX_PENDING_PER_ORGANIZATION;
    // Org-scoped uploads must run under organization RLS context so the tenant-isolation
    // WITH CHECK passes; user-scoped uploads run under user context for owner-access.
    const runReservation = async (): Promise<UploadRow> => {
      // audit-#7: take the ORG-scoped advisory lock BEFORE the per-user lock (a globally
      // consistent org-then-user order, deadlock-free) so concurrent reservations from
      // DIFFERENT members of the same org serialize on the org cap. Previously the org count
      // was checked while holding only the per-user lock, so N members could each pass the
      // same org count and overshoot UPLOAD_MAX_PENDING_PER_ORGANIZATION by N.
      if (organizationInternalId !== null) {
        await this.repository.acquirePendingOrganizationQuotaLock(organizationInternalId);
      }
      await this.repository.acquirePendingUploadQuotaLock(userInternalId);
      // sec-UP4: enforce the org-level cap BEFORE the per-user cap so a single
      // org with many members cannot pile PENDING uploads across user accounts
      // and exhaust storage. The org-scoped lock above now makes this count + insert
      // atomic across members (not just within a single user).
      if (organizationInternalId !== null) {
        const orgPendingCount =
          await this.repository.countPendingByOrganizationId(organizationInternalId);
        if (orgPendingCount >= orgPendingCap) {
          throw new ValidationError(
            'errors:uploadPendingQuotaExceeded',
            { limit: orgPendingCap, pending: orgPendingCount },
            undefined,
            [
              {
                field: 'file_size',
                messageKey: 'errors:uploadPendingQuotaExceeded',
                messageParams: { limit: orgPendingCap, pending: orgPendingCount },
              },
            ],
          );
        }
      }
      const pendingCount = await this.repository.countPendingByUserId(userInternalId);
      if (pendingCount >= pendingCap) {
        throw new ValidationError(
          'errors:uploadPendingQuotaExceeded',
          { limit: pendingCap, pending: pendingCount },
          undefined,
          [
            {
              field: 'file_size',
              messageKey: 'errors:uploadPendingQuotaExceeded',
              messageParams: { limit: pendingCap, pending: pendingCount },
            },
          ],
        );
      }
      return this.repository.create({
        user_id: userInternalId,
        organization_id: organizationInternalId,
        file_name: fileName,
        file_key: fileKey,
        mime_type: contentType,
        file_size: fileSize,
        storage_provider: 's3',
        bucket,
        status: 'PENDING',
        created_by_user_id: userInternalId,
      });
    };

    if (organizationInternalId !== null && organizationPublicId !== null) {
      return withPrincipalDatabaseContext(
        resolveVerifiedOrganizationPrincipalScope(organizationPublicId),
        runReservation,
      );
    }
    return withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(userPublicId),
      runReservation,
    );
  }

  private async resolveUploadOrganizationInternalId(
    input: CreateUploadInput,
    userPublicId: string,
  ): Promise<number | null> {
    if (input.for === UPLOAD_TARGETS.ORGANIZATION && input.organization_id) {
      const permissions = await this.authorizationService.resolveUserOrganizationPermissions(
        userPublicId,
        input.organization_id,
      );
      if (!permissions.includes(UPLOAD_PERMISSIONS.UPLOAD_MANAGE)) {
        throw new ForbiddenError('errors:insufficientUploadPermissions');
      }
      /**
       * `requireOrganizationByPublicId` reads `tenancy.organizations` which is FORCE RLS.
       * Under `DATABASE_RLS_SCOPED_CONTEXTS=true` the call needs either an active
       * organization context or `app.current_user_public_id` + the `organizations_user_discovery`
       * policy. The latter is appropriate here because we have just authorized the user.
       */
      const organization = await withPrincipalDatabaseContext(
        resolveVerifiedUserPrincipalScope(userPublicId),
        () => this.organizationService.requireOrganizationByPublicId(input.organization_id!),
      );
      return organization.id;
    }
    return null;
  }

  /**
   * Gate for cross-domain consumers (avatar/logo attach): the upload row for this storage key
   * must exist and be in UPLOADED status — i.e. it went through confirmUpload. Ownership is
   * enforced by the caller via the key prefix, so this only asserts the finalization state.
   */
  async assertKeyConfirmed(fileKey: string): Promise<void> {
    const row = await this.repository.findByFileKey(fileKey);
    if (!row) {
      throw new ValidationError('errors:validation.uploadNotConfirmed', undefined, {
        key: ['No upload exists for this key'],
      });
    }
    if (row.status !== UPLOAD_STATUS.UPLOADED) {
      throw new ValidationError('errors:validation.uploadNotConfirmed', undefined, {
        key: ['Upload has not been confirmed'],
      });
    }
  }

  /**
   * Stronger variant of {@link assertKeyConfirmed} that also binds the row to a
   * specific owner (sec-UP5). Callers must supply either `userInternalId`
   * (user-scoped uploads like avatars) or `organizationInternalId` (org-scoped
   * uploads like logos / org files). Mismatch yields a ValidationError with the
   * same key as a missing/un-confirmed row, so callers do not leak whether the
   * row exists.
   *
   * Use this in any code path that doesn't enforce ownership via key-prefix
   * derivation from auth — particularly admin or worker contexts where RLS is
   * bypassed. The existing `assertKeyConfirmed` remains for the legacy
   * prefix-derived call sites, but new callers should prefer this overload.
   */
  async assertKeyConfirmedForOwner(options: {
    fileKey: string;
    userInternalId?: number;
    organizationInternalId?: number;
  }): Promise<void> {
    const { fileKey, userInternalId, organizationInternalId } = options;
    if (userInternalId === undefined && organizationInternalId === undefined) {
      throw new ValidationError('errors:validation.uploadNotConfirmed', undefined, {
        key: ['assertKeyConfirmedForOwner requires user or organization owner'],
      });
    }
    const row = await this.repository.findByFileKey(fileKey);
    const notConfirmed = (): ValidationError =>
      new ValidationError('errors:validation.uploadNotConfirmed', undefined, {
        key: ['Upload has not been confirmed'],
      });
    if (!row || row.status !== UPLOAD_STATUS.UPLOADED) throw notConfirmed();
    if (userInternalId !== undefined && row.user_id !== userInternalId) {
      throw notConfirmed();
    }
    if (organizationInternalId !== undefined && row.organization_id !== organizationInternalId) {
      throw notConfirmed();
    }
  }

  private async assertUserCanAccessOrgScopedUpload(
    row: UploadRow,
    userPublicId: string,
  ): Promise<void> {
    if (row.organization_id === null) {
      return;
    }

    const organization = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(userPublicId),
      () => this.organizationService.findOrganizationByInternalId(row.organization_id!),
    );
    if (!organization) {
      throw new NotFoundError('Upload');
    }

    const permissions = await this.authorizationService.resolveUserOrganizationPermissions(
      userPublicId,
      organization.public_id,
    );
    if (!permissions.includes(UPLOAD_PERMISSIONS.UPLOAD_MANAGE)) {
      throw new ForbiddenError('errors:insufficientUploadPermissions');
    }
  }

  private async loadUploadForUserAction(input: {
    public_id: string;
    userPublicId: string;
    userInternalId: number;
  }): Promise<UploadRow> {
    const { public_id, userPublicId, userInternalId } = input;
    const row = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(userPublicId),
      () => this.repository.findByPublicId(public_id),
    );
    if (!row) throw new NotFoundError('Upload');

    if (row.organization_id === null) {
      if (row.user_id !== userInternalId) {
        throw new NotFoundError('Upload');
      }
      return row;
    }

    await this.assertUserCanAccessOrgScopedUpload(row, userPublicId);
    return row;
  }

  async getUpload(public_id: string, userPublicId: string): Promise<UploadDetailOutput> {
    const validatedPublicId = validateUploadPublicIdParam(public_id);
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    const row = await this.loadUploadForUserAction({
      public_id: validatedPublicId,
      userPublicId,
      userInternalId: user.id,
    });

    return this.toUploadDetail(row, userPublicId);
  }

  /**
   * Verifies the uploaded object against its declared content type/length and, when valid,
   * publishes the bytes from the pending key to the immutable final key.
   *
   * @remarks
   * - **Algorithm:** HEAD the object; require it to exist, match the declared length, and (when S3
   *   echoes one) match the declared content type; on success publish/sanitize to `finalKey`.
   * - **Failure modes:** rethrows a transient {@link ExternalServiceError} (surfaces as 503; the
   *   row stays PENDING for retry); any other verification failure resolves to `false` so the
   *   caller marks the row FAILED.
   * - **Side effects:** one storage HEAD; on success the publish/sanitize copy plus structured logs.
   */
  private async verifyAndPublishUploadedObject(options: {
    sourceKey: string;
    finalKey: string;
    mimeType: string;
    fileSize: number;
    publicId: string;
  }): Promise<boolean> {
    const { sourceKey, finalKey, mimeType, fileSize, publicId } = options;
    try {
      const metadata = await this.objectStorage.verifyUploadedObject(sourceKey, {
        contentType: mimeType,
        contentLength: fileSize,
      });
      const objectExists = metadata.contentLength !== undefined;
      const lengthMatches = metadata.contentLength === fileSize;
      // S3 may not echo a content type; only fail on type when one is reported.
      const typeMatches = metadata.contentType === undefined || metadata.contentType === mimeType;
      if (!(objectExists && lengthMatches && typeMatches)) {
        return false;
      }
      return await this.publishConfirmedObject(sourceKey, finalKey, mimeType);
    } catch (error) {
      // audit-#5: a transient storage failure (timeout / throttle / circuit-open / IAM) must NOT
      // mark a valid upload FAILED. Re-throw it (surfaces as 503) so the client can retry confirm;
      // the row stays PENDING and the sweeper / a retry reconciles it. Only genuine verification
      // failures (not-found, type/size mismatch, magic-byte rejection) fall through to FAILED.
      if (error instanceof ExternalServiceError) {
        logger.warn(
          { id: publicId, fileKey: sourceKey, error },
          'upload.confirm.transientStorageError',
        );
        throw error;
      }
      logger.warn({ id: publicId, fileKey: sourceKey, error }, 'upload.confirm.verifyFailed');
      return false;
    }
  }

  /**
   * Server-side finalization: HEAD the uploaded object and compare its content type/length
   * against the values declared at create time. On success the row moves PENDING → UPLOADED;
   * on mismatch/missing it moves to FAILED and a validation error is surfaced. SVG objects are
   * sanitized in place (scripts/event handlers stripped) before being marked UPLOADED so the
   * served bytes can never execute as stored XSS. Consumers must require UPLOADED before
   * attaching the object. Idempotent for already-UPLOADED rows.
   */
  async confirmUpload(public_id: string, userPublicId: string): Promise<UploadDetailOutput> {
    const validatedPublicId = validateUploadPublicIdParam(public_id);
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    const row = await this.loadUploadForUserAction({
      public_id: validatedPublicId,
      userPublicId,
      userInternalId: user.id,
    });

    if (row.status === UPLOAD_STATUS.UPLOADED) {
      return this.toUploadDetail(row, userPublicId);
    }
    if (row.status !== UPLOAD_STATUS.PENDING) {
      throw new ValidationError('errors:uploadNotPending', undefined, {
        status: ['Upload is not awaiting confirmation'],
      });
    }

    // The bytes live at the (still client-writable) pending key; the verified bytes are published
    // to `finalKey`. For rows created before pending-keying (rolling deploy) source === final and
    // the verify/sanitize happens in place exactly as before.
    const sourceKey = row.file_key;
    const finalKey = stripPendingObjectKeyPrefix(sourceKey);
    const pendingKeyed = finalKey !== sourceKey;
    // sec-UP1: refuse to confirm a row that never went through the
    // pending-key indirection. Without it, finalKey === sourceKey and the
    // presigned PUT URL the client used remains valid for the full TTL —
    // an attacker can swap a same-length, same-magic-byte payload after
    // confirm and the row stays UPLOADED with hostile content. Roll-out
    // legacy rows are at end-of-life; refuse and require re-upload via
    // a fresh pending key.
    if (!pendingKeyed) {
      const failedRow = await withPrincipalDatabaseContext(
        resolveVerifiedUserPrincipalScope(userPublicId),
        () => this.repository.markStatusByPublicId(validatedPublicId, UPLOAD_STATUS.FAILED),
      );
      if (!failedRow) throw new NotFoundError('Upload');
      logger.warn(
        { id: validatedPublicId, fileKey: sourceKey },
        'upload.confirm.legacyInPlaceRefused',
      );
      throw new ValidationError('errors:uploadVerificationFailed', undefined, {
        file: ['Upload predates pending-key flow; re-upload to a fresh key'],
      });
    }

    const verified = await this.verifyAndPublishUploadedObject({
      sourceKey,
      finalKey,
      mimeType: row.mime_type,
      fileSize: row.file_size,
      publicId: validatedPublicId,
    });

    if (!verified) {
      const failedRow = await withPrincipalDatabaseContext(
        resolveVerifiedUserPrincipalScope(userPublicId),
        () => this.repository.markStatusByPublicId(validatedPublicId, UPLOAD_STATUS.FAILED),
      );
      if (!failedRow) throw new NotFoundError('Upload');
      throw new ValidationError('errors:uploadVerificationFailed', undefined, {
        file: ['Uploaded object could not be verified against its declared type and size'],
      });
    }

    // Repoint the row at the immutable final key in the same update that marks it UPLOADED, so a
    // servable row never references the overwritable pending key.
    const updated = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(userPublicId),
      () => this.repository.markConfirmedByPublicId(validatedPublicId, finalKey),
    );
    if (!updated) throw new NotFoundError('Upload');

    // Best-effort: drop the now-published pending object so it is not billed or swept.
    if (pendingKeyed) {
      const pendingObjectDeleted = await this.objectStorage.deleteObject(sourceKey);
      if (!pendingObjectDeleted) {
        logger.warn(
          { id: validatedPublicId, pendingKey: sourceKey },
          'upload.confirm.pendingObjectDeleteFailed',
        );
      }
    }

    return this.toUploadDetail(updated, userPublicId);
  }

  /**
   * Publishes the verified pending object to its immutable `finalKey`. SVGs are sanitized in
   * transit (and rejected when hostile/empty); magic-byte-verifiable types have their leading bytes
   * checked against the declared content-type, then the object is server-side copied to `finalKey`.
   * When `finalKey === sourceKey` (legacy in-place row) nothing is copied. Returns false when
   * magic-byte verification fails so the caller marks the row FAILED.
   */
  private async publishConfirmedObject(
    sourceKey: string,
    finalKey: string,
    contentType: string,
  ): Promise<boolean> {
    // SVGs are active content: an uploaded <svg onload=…> served with an image/svg+xml type would
    // execute as stored XSS. Neutralise the bytes before publishing them to the servable key.
    if (isSvgContentType(contentType)) {
      await this.publishSanitizedSvg(sourceKey, finalKey, contentType);
      return true;
    }
    // HEAD only echoes the client-declared content-type, which is trivially spoofable (e.g. an
    // HTML/script payload uploaded as image/png). Verify the actual leading bytes before the object
    // becomes servable. Ranged GET (first 32 bytes) avoids buffering the full upload.
    if (isMagicByteVerifiable(contentType)) {
      const header = await this.objectStorage.getObjectFirstBytes(sourceKey, 32);
      if (!(header && verifyFileMagicBytes(header.body, contentType))) {
        return false;
      }
      if (finalKey !== sourceKey) {
        // sec-re-10: pin the COPY to the exact object bytes we just verified.
        // The presigned PUT/POST that minted `pending/<key>` remains replayable
        // for the lifetime of the upload URL (~15 min), so an authenticated
        // client could race a second PUT between this HEAD and the copy and
        // have the COPY pick up hostile bytes. `CopySourceIfMatch` makes S3
        // reject that race with `PreconditionFailed` so the publish fails
        // fast and we never serve unverified bytes from `finalKey`.
        await this.objectStorage.copyObject({
          sourceKey,
          destinationKey: finalKey,
          contentType,
          ...(header.eTag ? { sourceETag: header.eTag } : {}),
        });
      }
      return true;
    }
    if (finalKey !== sourceKey) {
      await this.objectStorage.copyObject({ sourceKey, destinationKey: finalKey, contentType });
    }
    return true;
  }

  /**
   * Fetches the pending SVG, strips XSS vectors (scripts, event handlers, hostile filters) via
   * {@link sanitizeSvgBuffer}, and writes the sanitized bytes to `finalKey`. Always writes when
   * `finalKey` differs from the source (the publish step); for a legacy in-place row (same key) it
   * writes only when sanitization changed the bytes. Throws when sanitization yields an empty
   * document so the caller fails verification for hostile or zero-byte SVGs.
   */
  private async publishSanitizedSvg(
    sourceKey: string,
    finalKey: string,
    contentType: string,
  ): Promise<void> {
    const object = await this.objectStorage.getObject(sourceKey);
    const sanitized = sanitizeSvgBuffer(object.body);
    if (finalKey !== sourceKey || !sanitized.equals(object.body)) {
      await this.objectStorage.putObject({ key: finalKey, body: sanitized, contentType });
    }
  }

  private async toUploadDetail(row: UploadRow, userPublicId?: string): Promise<UploadDetailOutput> {
    let organizationPublicId: string | null = null;
    if (row.organization_id !== null) {
      /**
       * `findOrganizationByInternalId` hits `tenancy.organizations` (FORCE RLS). When
       * we have a user public id, wrap so the `organizations_user_discovery` policy
       * is satisfied; otherwise fall back to the bare call (works under legacy mode
       * and for callers that already pin an organization context).
       */
      const organization =
        userPublicId !== undefined && userPublicId.length > 0
          ? await withPrincipalDatabaseContext(
              resolveVerifiedUserPrincipalScope(userPublicId),
              () => this.organizationService.findOrganizationByInternalId(row.organization_id!),
            )
          : await this.organizationService.findOrganizationByInternalId(row.organization_id);
      organizationPublicId = organization?.public_id ?? null;
    }
    return serializeUploadDetail(row, organizationPublicId);
  }

  async deleteUpload(public_id: string, userPublicId: string): Promise<void> {
    const validatedPublicId = validateUploadPublicIdParam(public_id);
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    const row = await this.loadUploadForUserAction({
      public_id: validatedPublicId,
      userPublicId,
      userInternalId: user.id,
    });

    // S3 delete runs outside the DB context.
    const objectDeleted = await this.objectStorage.deleteObject(row.file_key);
    if (!objectDeleted) {
      logger.warn(
        { id: validatedPublicId, fileKey: row.file_key },
        'upload.delete.s3ObjectDeleteFailed',
      );
    }

    const deleted = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(userPublicId),
      () => this.repository.softDeleteByPublicId(validatedPublicId),
    );
    if (!deleted) throw new NotFoundError('Upload');
  }

  /** Tombstones all active uploads for a user (offboarding) and removes S3 objects when possible. */
  async tombstoneAllByUserId(user_id: number): Promise<number> {
    // Stream the user's active uploads in bounded keyset batches and delete their S3 objects
    // with bounded concurrency. This prevents a user with a large upload footprint from
    // loading an unbounded result set into memory or serializing thousands of S3 round-trips
    // in the offboarding path. Rows are not mutated during iteration, so keyset-by-id pages
    // through the full set exactly once; the soft-delete at the end is the durable marker.
    let afterId = 0;
    for (;;) {
      const rows = await this.repository.findActiveByUserIdAfter(
        user_id,
        afterId,
        UPLOAD_OFFBOARDING_DELETE_BATCH_SIZE,
      );
      if (rows.length === 0) {
        break;
      }
      await this.deleteObjectsWithBoundedConcurrency({
        fileKeys: rows.map((row) => row.file_key),
        userId: user_id,
      });
      afterId = rows[rows.length - 1]!.id;
      if (rows.length < UPLOAD_OFFBOARDING_DELETE_BATCH_SIZE) {
        break;
      }
    }
    return this.repository.softDeleteAllByUserId(user_id);
  }

  /** Deletes S3 objects in fixed-size concurrent chunks; failures are logged, never thrown. */
  private async deleteObjectsWithBoundedConcurrency(options: {
    fileKeys: readonly string[];
    userId?: number;
    organizationId?: number;
  }): Promise<void> {
    const { fileKeys, userId, organizationId } = options;
    for (let index = 0; index < fileKeys.length; index += UPLOAD_OFFBOARDING_DELETE_CONCURRENCY) {
      const chunk = fileKeys.slice(index, index + UPLOAD_OFFBOARDING_DELETE_CONCURRENCY);
      await Promise.all(
        chunk.map(async (fileKey) => {
          const objectDeleted = await this.objectStorage.deleteObject(fileKey);
          if (!objectDeleted) {
            logger.warn(
              { userId, organizationId, fileKey },
              'upload.offboarding.s3ObjectDeleteFailed',
            );
          }
        }),
      );
    }
  }

  /**
   * Tombstones all active uploads for an organization (offboarding) and removes
   * S3 objects in the same bounded-concurrency pattern as
   * {@link UploadService.tombstoneAllByUserId}.
   *
   * @remarks
   * sec-UP8: the previous implementation only soft-deleted DB rows and relied
   * on `UPLOAD_TOMBSTONE_RETENTION_CRON` to eventually clean S3. The cron is
   * optional, so an operator who forgot to set it left org-deletion S3 objects
   * around indefinitely — a GDPR Article 17 violation and an unbounded
   * storage cost. Object removal now happens synchronously in the same
   * offboarding pass, matching the user-tombstone contract.
   *
   * Streams in bounded keyset batches so a tenant with a large upload
   * footprint does not load an unbounded result set into memory or
   * serialise thousands of S3 round-trips inline.
   */
  async tombstoneAllByOrganizationId(organization_id: number): Promise<number> {
    let afterId = 0;
    for (;;) {
      const rows = await this.repository.findActiveByOrganizationIdAfter(
        organization_id,
        afterId,
        UPLOAD_OFFBOARDING_DELETE_BATCH_SIZE,
      );
      if (rows.length === 0) {
        break;
      }
      await this.deleteObjectsWithBoundedConcurrency({
        fileKeys: rows.map((row) => row.file_key),
        organizationId: organization_id,
      });
      afterId = rows[rows.length - 1]!.id;
      if (rows.length < UPLOAD_OFFBOARDING_DELETE_BATCH_SIZE) {
        break;
      }
    }
    return this.repository.softDeleteAllByOrganizationId(organization_id);
  }
}
