/** Functional category of an upload — drives key prefix, max size, and allowed MIME types. */
export const UPLOAD_PURPOSES = {
  AVATAR: 'avatar',
  ORGANIZATION_LOGO: 'organization-logo',
  USER_FILE: 'user-file',
  ORGANIZATION_FILE: 'organization-file',
} as const;

/** Union of valid purpose codes from {@link UPLOAD_PURPOSES}. */
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[keyof typeof UPLOAD_PURPOSES];

/** Ownership scope for an upload: belongs to a `user` (private) or an `organization` (organization-scoped). */
export const UPLOAD_TARGETS = {
  USER: 'user',
  ORGANIZATION: 'organization',
} as const;

/** Union of valid target codes from {@link UPLOAD_TARGETS}. */
export type UploadTarget = (typeof UPLOAD_TARGETS)[keyof typeof UPLOAD_TARGETS];

/**
 * Upload lifecycle status. Matches the DB CHECK constraint
 * (`status IN ('PENDING','UPLOADED','FAILED')`). Consumers must require `UPLOADED`
 * before attaching an object (e.g. avatar/logo).
 */
export const UPLOAD_STATUS = {
  PENDING: 'PENDING',
  UPLOADED: 'UPLOADED',
  FAILED: 'FAILED',
} as const;

/** Union of valid status codes from {@link UPLOAD_STATUS}. */
export type UploadStatus = (typeof UPLOAD_STATUS)[keyof typeof UPLOAD_STATUS];

/**
 * For presigned URL uploads, files go directly to S3 and we never see bytes.
 * When file bytes are available (e.g. server-side upload, S3 Object Lambda),
 * use verifyFileMagicBytes() from @/shared/utils/validation/file-magic.util.js to validate
 * content matches declared content-type.
 */

export interface UploadPurposeConfig {
  allowedTypes: readonly string[];
  maxSize: number;
  keyPrefix: string;
}

/**
 * Per-purpose policy table consulted by the validator and presigned-URL
 * service: allowed MIME types, max byte size, and the S3 key prefix used
 * when constructing object keys.
 */
export const UPLOAD_PURPOSE_CONFIG: Record<UploadPurpose, UploadPurposeConfig> = {
  [UPLOAD_PURPOSES.AVATAR]: {
    allowedTypes: ['image/png', 'image/jpeg', 'image/webp'],
    maxSize: 2 * 1024 * 1024, // 2 MB
    keyPrefix: 'avatars',
  },
  [UPLOAD_PURPOSES.ORGANIZATION_LOGO]: {
    allowedTypes: ['image/png', 'image/jpeg', 'image/webp'],
    maxSize: 5 * 1024 * 1024, // 5 MB
    keyPrefix: 'organization-logos',
  },
  [UPLOAD_PURPOSES.USER_FILE]: {
    allowedTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
    maxSize: 10 * 1024 * 1024, // 10 MB
    keyPrefix: 'user-files',
  },
  [UPLOAD_PURPOSES.ORGANIZATION_FILE]: {
    allowedTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
    maxSize: 10 * 1024 * 1024, // 10 MB
    keyPrefix: 'organization-files',
  },
} as const;

/**
 * The required upload target (`for`) for each purpose (route-audit L3). The validator rejects a
 * mismatched `{ purpose, for }` BEFORE key construction so a request like
 * `{ purpose: organization-logo, for: user }` can't produce an `organization-logos/undefined/...`
 * key on a user-scoped row (the key prefix encodes scope, and the attach binding relies on it).
 */
export const UPLOAD_PURPOSE_REQUIRED_TARGET: Record<UploadPurpose, UploadTarget> = {
  [UPLOAD_PURPOSES.AVATAR]: UPLOAD_TARGETS.USER,
  [UPLOAD_PURPOSES.USER_FILE]: UPLOAD_TARGETS.USER,
  [UPLOAD_PURPOSES.ORGANIZATION_LOGO]: UPLOAD_TARGETS.ORGANIZATION,
  [UPLOAD_PURPOSES.ORGANIZATION_FILE]: UPLOAD_TARGETS.ORGANIZATION,
} as const;

/**
 * Postgres advisory-lock namespace (`classid`) used to serialize per-user PENDING
 * upload-quota reservations. Combined with the user's internal id as the `objid`
 * in the two-key `pg_advisory_xact_lock(classid, objid)` form so it occupies a
 * distinct lock space from single-key advisory locks (e.g. the migration runner)
 * and never collides with them. The value is the ASCII for `UPLD` and is otherwise
 * arbitrary — only its stability matters.
 */
export const UPLOAD_PENDING_QUOTA_ADVISORY_LOCK_NAMESPACE = 0x55_50_4c_44;

/**
 * Postgres advisory-lock namespace (`classid`) used to serialize per-ORGANIZATION PENDING
 * upload-quota reservations (audit-#7). Distinct from
 * {@link UPLOAD_PENDING_QUOTA_ADVISORY_LOCK_NAMESPACE} so the organization lock and the per-user lock
 * occupy separate lock spaces; combined with the organization's internal id as the `objid`.
 * The reservation path always takes the organization lock BEFORE the user lock (a globally consistent
 * order) so concurrent reservations from different members of the same organization serialize on the
 * organization cap without any deadlock risk. The value is the ASCII for `UPLO` and is otherwise
 * arbitrary — only its stability and distinctness matter.
 */
export const UPLOAD_PENDING_ORGANIZATION_QUOTA_ADVISORY_LOCK_NAMESPACE = 0x55_50_4c_4f;

/**
 * Page size for streaming a user's active uploads during offboarding. Bounds the
 * number of rows (and S3 keys) held in memory per iteration so an account with a
 * large upload footprint cannot materialize an unbounded result set.
 */
export const UPLOAD_OFFBOARDING_DELETE_BATCH_SIZE = 500;

/**
 * Maximum concurrent S3 object deletes performed per offboarding batch. Caps the
 * blocking window and outbound S3 pressure while still parallelizing deletes
 * instead of issuing them one-at-a-time.
 */
export const UPLOAD_OFFBOARDING_DELETE_CONCURRENCY = 10;

/**
 * Hard DTO-level ceiling on the declared `fileSize` claim — set to the highest
 * per-purpose cap currently configured in {@link UPLOAD_PURPOSE_CONFIG}.
 *
 * sec-r4-I4: the validator already rejects oversized declarations per purpose,
 * but the DTO accepted any positive int. A defense-in-depth max at the schema
 * layer (a) makes the OpenAPI contract reflect the true ceiling for clients
 * generating SDKs from the spec, and (b) catches absurd values (e.g. integer
 * overflow attempts) before the per-purpose policy check has even chosen a
 * config row. Must be kept in sync with the largest \`UPLOAD_PURPOSE_CONFIG\`
 * entry.
 */
export const UPLOAD_DTO_FILE_SIZE_MAX_BYTES = 10 * 1024 * 1024;

export { PRESIGNED_URL_EXPIRY_SECONDS } from '@/shared/constants/ttl.constants.js';

/**
 * Key-prefix namespace for the object a client uploads to via its presigned URL. On confirmation
 * the verified/sanitized bytes are published to the prefix-stripped final key (which the client
 * never holds a presigned URL for), so the served object cannot be overwritten through the still-
 * valid upload URL. Pending objects are reclaimed by the pending-sweep worker.
 */
export const UPLOAD_PENDING_KEY_PREFIX = 'pending/';

/** Wraps a final object key in the pending-upload namespace (`pending/<finalKey>`). */
export function buildPendingObjectKey(finalKey: string): string {
  return `${UPLOAD_PENDING_KEY_PREFIX}${finalKey}`;
}

/** Strips the `pending/` namespace from a pending key, returning the final key (idempotent if absent). */
export function stripPendingObjectKeyPrefix(key: string): string {
  return key.startsWith(UPLOAD_PENDING_KEY_PREFIX)
    ? key.slice(UPLOAD_PENDING_KEY_PREFIX.length)
    : key;
}

/** S3 key prefix for a user's avatar uploads (`avatars/{userPublicId}/...`). */
export function buildUserAvatarKeyPrefix(userPublicId: string): string {
  return `${UPLOAD_PURPOSE_CONFIG[UPLOAD_PURPOSES.AVATAR].keyPrefix}/${userPublicId}/`;
}

/** S3 key prefix for an organization's logo uploads (`organization-logos/{organizationPublicId}/...`). */
export function buildOrganizationLogoKeyPrefix(organizationPublicId: string): string {
  return `${UPLOAD_PURPOSE_CONFIG[UPLOAD_PURPOSES.ORGANIZATION_LOGO].keyPrefix}/${organizationPublicId}/`;
}
