/**
 * Faker generators for the upload bulk seeder. Callers pass the orchestrator's seeded
 * `faker` so output is reproducible for a given `SEED`. The object key is derived
 * deterministically by the bulk seeder (it embeds the owner segment + index for
 * count-and-resume idempotency), so it is not generated here.
 */
import type { Faker } from '@faker-js/faker';
import {
  UPLOAD_PURPOSE_CONFIG,
  UPLOAD_PURPOSES,
  UPLOAD_STATUS,
  type UploadPurpose,
  type UploadStatus,
} from '@/domains/upload/upload.constants.js';

/** Purposes that are owned by an organization (set `organization_id`). */
const ORGANIZATION_PURPOSES: readonly UploadPurpose[] = [
  UPLOAD_PURPOSES.ORGANIZATION_LOGO,
  UPLOAD_PURPOSES.ORGANIZATION_FILE,
];

/** Purposes that are owned by a user only (`organization_id` is NULL). */
const PERSONAL_PURPOSES: readonly UploadPurpose[] = [
  UPLOAD_PURPOSES.AVATAR,
  UPLOAD_PURPOSES.USER_FILE,
];

/** Lifecycle states a bulk upload can land in, mixed across the per-organization pool. */
const STATUSES: readonly UploadStatus[] = [
  UPLOAD_STATUS.PENDING,
  UPLOAD_STATUS.UPLOADED,
  UPLOAD_STATUS.FAILED,
];

/** A generated upload's metadata fields (object key is derived deterministically by the seeder). */
export interface BulkUploadProfile {
  /** Functional purpose, drives key prefix + allowed MIME types. */
  purpose: UploadPurpose;
  /** Whether this upload is organization-scoped (`organization_id` set) or personal (NULL organization). */
  isOrganizationScoped: boolean;
  /** Lifecycle status (`PENDING` / `UPLOADED` / `FAILED`). */
  status: UploadStatus;
  /** Generated display file name (with a content-appropriate extension). */
  file_name: string;
  /** Selected MIME type drawn from the purpose's allow-list. */
  mime_type: string;
  /** File size in bytes, bounded by the purpose's max size. */
  file_size: number;
}

/**
 * Builds one fake upload profile for the given slot. The slot index drives a deterministic
 * mix: organization-scoped vs personal alternates so every organization has both, and the status cycles
 * through `PENDING` / `UPLOADED` / `FAILED` so the per-organization pool always spans all states.
 */
export function generateBulkUpload(faker: Faker, slot: number): BulkUploadProfile {
  const isOrganizationScoped = slot % 2 === 0;
  const candidatePurposes = isOrganizationScoped ? ORGANIZATION_PURPOSES : PERSONAL_PURPOSES;
  const purpose = faker.helpers.arrayElement(candidatePurposes);
  const status = STATUSES[slot % STATUSES.length] as UploadStatus;

  const config = UPLOAD_PURPOSE_CONFIG[purpose];
  const mime_type = faker.helpers.arrayElement(config.allowedTypes);
  const file_size = faker.number.int({ min: 1024, max: config.maxSize });
  const extension = mimeTypeExtension(mime_type);
  const file_name = `${faker.system.commonFileName().replace(/\.[^.]+$/, '')}${extension}`;

  return { purpose, isOrganizationScoped, status, file_name, mime_type, file_size };
}

/** Maps a MIME type to a display extension for the generated file name (best-effort). */
function mimeTypeExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'application/pdf':
      return '.pdf';
    default:
      return '';
  }
}
