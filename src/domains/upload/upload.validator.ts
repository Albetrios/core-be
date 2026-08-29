import path from 'node:path';
import { ValidationError } from '@/shared/errors/index.js';
import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import { createUploadDto, uploadPublicIdParamDto } from './upload.dto.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import {
  UPLOAD_PURPOSE_CONFIG,
  UPLOAD_PURPOSE_REQUIRED_TARGET,
  UPLOAD_TARGETS,
} from './upload.constants.js';
import {
  getAllowedContentTypesForPurpose,
  getAllowedExtensionsForContentType,
} from './utils/upload-content-type.util.js';
import type { CreateUploadInput } from './upload.types.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';

/**
 * Validates the request body for `POST /api/v1/uploads`: structure via
 * {@link createUploadDto}, then policy checks for `organization_id`
 * presence/absence per target, allowed content type for the purpose, declared
 * filename extension matching the content type, and size against
 * {@link UPLOAD_PURPOSE_CONFIG}. Throws {@link ValidationError} on any failure.
 */
export function validateCreateUpload(data: unknown): CreateUploadInput {
  const input = parseWithSchema(createUploadDto, data, 'errors:invalidUploadInput');
  const config = UPLOAD_PURPOSE_CONFIG[input.purpose];
  const allowedTypes = getAllowedContentTypesForPurpose(input.purpose);

  // route-audit L3: the purpose must match its required target BEFORE the organization-id checks and key
  // construction — otherwise e.g. { purpose: organization-logo, for: user } builds an
  // `organization-logos/undefined/...` key on a user-scoped row (namespace pollution + erodes the
  // "key prefix encodes scope" invariant the attach binding relies on).
  if (input.for !== UPLOAD_PURPOSE_REQUIRED_TARGET[input.purpose]) {
    throw new ValidationError('errors:uploadPurposeTargetMismatch', undefined, undefined, [
      { field: 'for', messageKey: 'errors:uploadPurposeTargetMismatch' },
    ]);
  }

  // Ownership validation
  if (input.for === UPLOAD_TARGETS.USER && input.organization_id) {
    throw new ValidationError('errors:uploadOrganizationIdNotAllowed', undefined, undefined, [
      { field: 'organization_id', messageKey: 'errors:uploadOrganizationIdNotAllowed' },
    ]);
  }
  if (input.for === UPLOAD_TARGETS.ORGANIZATION && !input.organization_id) {
    throw new ValidationError('errors:uploadOrganizationIdRequired', undefined, undefined, [
      { field: 'organization_id', messageKey: 'errors:uploadOrganizationIdRequired' },
    ]);
  }
  // sec-UP3: when present, organization_id must match the canonical public-id
  // shape before it flows into S3 keys / Redis cache keys / RLS context.
  // Enforced at the validator layer (not the DTO) so the OpenAPI contract
  // stays a generic string — existing clients still send the canonical 21-
  // char id; arbitrary 1-255-char strings are rejected with ValidationError
  // before any downstream side effect.
  if (input.organization_id !== undefined) {
    validatePublicIdParam(input.organization_id, 'organization_id');
  }

  // Content type validation
  if (!allowedTypes.includes(input.content_type)) {
    throw new ValidationError(
      'errors:uploadContentTypeNotAllowed',
      {
        contentType: input.content_type,
        purpose: input.purpose,
        allowed: allowedTypes.join(', '),
      },
      undefined,
      [
        {
          field: 'content_type',
          messageKey: 'errors:uploadContentTypeNotAllowed',
          messageParams: {
            contentType: input.content_type,
            purpose: input.purpose,
            allowed: allowedTypes.join(', '),
          },
        },
      ],
    );
  }

  // Filename safety — reject path separators, parent-directory segments, and control
  // characters. The storage key is server-generated (a UUID), so a hostile filename
  // cannot traverse storage today; this is defense-in-depth so the stored display
  // filename can never carry a path-traversal or control-character payload into a
  // downstream sink (logs, headers, a client renderer).
  const hasPathCharacters =
    input.file_name.includes('/') ||
    input.file_name.includes('\\') ||
    input.file_name.includes('..');
  const hasControlCharacters = Array.from(input.file_name).some((character) => {
    const codePoint = character.charCodeAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (hasPathCharacters || hasControlCharacters) {
    throw new ValidationError('errors:uploadFilenameUnsafe', undefined, undefined, [
      { field: 'file_name', messageKey: 'errors:uploadFilenameUnsafe' },
    ]);
  }

  // Filename extension validation — declared filename extension must match the declared
  // content type (when the filename includes an extension). Prevents misleading filenames
  // (e.g. evil.exe with contentType=image/png) from being stored against an allowed type.
  const allowedExtensions = getAllowedExtensionsForContentType(input.content_type);
  const declaredExtension = path.extname(input.file_name).toLowerCase();
  if (declaredExtension !== '' && !allowedExtensions.includes(declaredExtension)) {
    throw new ValidationError(
      'errors:uploadFilenameExtensionMismatch',
      {
        extension: declaredExtension,
        contentType: input.content_type,
        allowed: allowedExtensions.join(', '),
      },
      undefined,
      [
        {
          field: 'file_name',
          messageKey: 'errors:uploadFilenameExtensionMismatch',
          messageParams: {
            extension: declaredExtension,
            contentType: input.content_type,
            allowed: allowedExtensions.join(', '),
          },
        },
      ],
    );
  }

  // File size validation
  if (input.file_size > config.maxSize) {
    throw new ValidationError(
      'errors:uploadFileSizeExceeded',
      { fileSize: input.file_size, maxSize: config.maxSize, purpose: input.purpose },
      undefined,
      [
        {
          field: 'file_size',
          messageKey: 'errors:uploadFileSizeExceeded',
          messageParams: {
            fileSize: input.file_size,
            maxSize: config.maxSize,
            purpose: input.purpose,
          },
        },
      ],
    );
  }

  return omitUndefined(input);
}

/**
 * Validates the `:upload_id` URL param against {@link uploadPublicIdParamDto}
 * and the shared public-id format check; returns the normalized public id.
 */
export function validateUploadPublicIdParam(public_id: string): string {
  const parsed = parseWithSchema(uploadPublicIdParamDto, { upload_id: public_id });
  return validatePublicIdParam(parsed.upload_id, 'upload_id');
}
