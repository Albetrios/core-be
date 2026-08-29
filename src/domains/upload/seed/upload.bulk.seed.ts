/**
 * Upload bulk seeder — creates `context.counts.uploadsPerOrg` uploads for every organization
 * in the registry, mixed across lifecycle states (`PENDING` / `UPLOADED` / `FAILED`) and across
 * ownership scopes (organization-scoped rows set `organization_id`; personal rows leave it NULL with a
 * user owner). MIME types, file sizes, and object keys follow the production key shape via the
 * `upload.constants` helpers.
 *
 * Idempotency: every bulk object key is namespaced under a deterministic `bulk-seed/` marker
 * and embeds the owning organization's public id + slot index. The seeder counts existing
 * marker rows per organization and only inserts the missing higher slots, so a re-run with the
 * same counts is a no-op.
 */
import { like } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { uploads } from '@/domains/upload/upload.schema.js';
import {
  UPLOAD_PURPOSE_CONFIG,
  UPLOAD_STATUS,
  buildPendingObjectKey,
  type UploadPurpose,
} from '@/domains/upload/upload.constants.js';
import { getCanonicalExtensionForContentType } from '@/domains/upload/utils/upload-content-type.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { SeedContext, SeededOrg, SeededUser } from '@/scripts/seed/seed-contract.js';
import { generateBulkUpload } from './upload.faker.js';

/** Marker prefix that namespaces every bulk-seeded object key (used for idempotent counting). */
const BULK_KEY_PREFIX = 'bulk-seed/';
/** Deterministic storage bucket for seeded rows — seed uploads never touch S3. */
const SEED_BUCKET = 'seed-local-bucket';

/**
 * Builds the deterministic object key for a bulk upload slot, mirroring the production key shape
 * (`{keyPrefix}/{ownerSegment}/{id}{ext}`) under the `bulk-seed/` marker namespace.
 */
function buildBulkObjectKey(options: {
  purpose: UploadPurpose;
  organizationPublicId: string;
  ownerSegment: string;
  slot: number;
  mimeType: string;
}): string {
  const { purpose, organizationPublicId, ownerSegment, slot, mimeType } = options;
  const config = UPLOAD_PURPOSE_CONFIG[purpose];
  const extension = getCanonicalExtensionForContentType(mimeType);
  return `${BULK_KEY_PREFIX}${organizationPublicId}/${config.keyPrefix}/${ownerSegment}/${slot}${extension}`;
}

/**
 * Seeds the per-organization upload pool, inserting only the missing slots for each organization.
 *
 * @remarks
 * Algorithm: for each organization in the registry, count existing `bulk-seed/` rows scoped to
 * that org's owner key segment, then insert only the higher slot indices up to `uploadsPerOrg`.
 * `PENDING` rows are stored under the `pending/<finalKey>` namespace (as the service does) and
 * have no `uploaded_at`; `UPLOADED` rows carry an `uploaded_at`; `FAILED` rows have neither.
 * Side effects: inserts into `upload.uploads`. Failure modes: warns and returns early if the
 * organization registry is empty; otherwise propagates DB errors.
 */
export async function seedUploadsBulk(context: SeedContext): Promise<void> {
  const { uploadsPerOrg } = context.counts;
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn(
      'seed.bulk.upload: empty organization registry; run the tenancy seeder first',
    );
    return;
  }

  let inserted = 0;
  for (const organization of organizations) {
    inserted += await seedUploadsForOrganization({ context, organization, uploadsPerOrg });
  }

  context.logger.info(
    { organizations: organizations.length, inserted },
    'seed.bulk.upload: uploads seeded',
  );
}

/** Seeds the missing upload slots for a single organization; returns how many rows were inserted. */
async function seedUploadsForOrganization(options: {
  context: SeedContext;
  organization: SeededOrg;
  uploadsPerOrg: number;
}): Promise<number> {
  const { context, organization, uploadsPerOrg } = options;
  const database = getRequestDatabase();

  // Every bulk row (organization-scoped or personal, PENDING or not) embeds the organization public id right after
  // the marker prefix, so a single LIKE counts the whole per-organization pool. The leading `%` also matches
  // the `pending/<key>` namespace that PENDING rows are stored under.
  const organizationMarker = `%${BULK_KEY_PREFIX}${organization.public_id}/%`;
  const existing = await database
    .select({ id: uploads.id })
    .from(uploads)
    .where(like(uploads.file_key, organizationMarker));

  const owner = resolveOwner(context, organization);
  let insertedForOrg = 0;
  for (let slot = existing.length; slot < uploadsPerOrg; slot += 1) {
    const profile = generateBulkUpload(context.faker, slot);
    const ownerSegment = profile.isOrganizationScoped ? organization.public_id : owner.public_id;
    const finalKey = buildBulkObjectKey({
      purpose: profile.purpose,
      organizationPublicId: organization.public_id,
      ownerSegment,
      slot,
      mimeType: profile.mime_type,
    });
    // PENDING objects live under the `pending/<finalKey>` namespace, exactly like the service.
    const fileKey =
      profile.status === UPLOAD_STATUS.PENDING ? buildPendingObjectKey(finalKey) : finalKey;

    await database.insert(uploads).values({
      public_id: generatePublicId('upload'),
      user_id: owner.id,
      organization_id: profile.isOrganizationScoped ? organization.id : null,
      file_name: profile.file_name,
      file_key: fileKey,
      mime_type: profile.mime_type,
      file_size: profile.file_size,
      storage_provider: 's3',
      bucket: SEED_BUCKET,
      status: profile.status,
      uploaded_at: profile.status === UPLOAD_STATUS.UPLOADED ? new Date() : null,
      created_by_user_id: owner.id,
    });
    insertedForOrg += 1;
  }
  return insertedForOrg;
}

/**
 * Resolves the user that owns an organization's bulk uploads, preferring the registry user whose
 * internal id matches the organization owner and falling back to the first registry user.
 */
function resolveOwner(context: SeedContext, organization: SeededOrg): SeededUser {
  const users = context.registry.users;
  const ownerFromRegistry = users.find((user) => user.id === organization.ownerUserId);
  return ownerFromRegistry ?? (users[0] as SeededUser);
}
