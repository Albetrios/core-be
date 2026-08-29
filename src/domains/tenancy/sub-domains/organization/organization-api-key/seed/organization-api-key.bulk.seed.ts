/**
 * Organization-api-key bulk seeder — provisions `counts.apiKeysPerOrg` `tenancy.api_keys` rows
 * per organization in the registry. Keys are generated and hashed exactly like
 * {@link OrganizationApiKeyService}: a raw `ak_<hex>` secret of
 * `ORGANIZATION_API_KEY_RAW_SECRET_BYTE_LENGTH` bytes, persisted only as its SHA-256 `key_hash`
 * plus a non-secret `key_prefix` (first `ORGANIZATION_API_KEY_PREFIX_DISPLAY_LENGTH` chars). The
 * raw secret is discarded — seeded keys cannot be used to authenticate, matching production where
 * the secret is shown once. When `counts.edgeCases` is set, the highest-index key per organization is
 * created `REVOKED` + soft-deleted.
 *
 * Idempotency: count-and-resume per organization keyed by a deterministic `name`
 * (`Bulk API Key <index>`); only indices beyond those already present are created, so a re-run
 * with the same counts is a no-op.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { api_keys } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.schema.js';
import {
  ORGANIZATION_API_KEY_PREFIX_DISPLAY_LENGTH,
  ORGANIZATION_API_KEY_RAW_SECRET_BYTE_LENGTH,
} from '@/shared/constants/limits.constants.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkApiKeyScopes } from './organization-api-key.faker.js';

const BULK_API_KEY_NAME_PREFIX = 'Bulk API Key ';
const BULK_API_KEY_NAME_PATTERN = `${BULK_API_KEY_NAME_PREFIX}%`;

/** Generates a raw `ak_<hex>` secret identical to the API-key service's `generateApiKey`. */
function generateRawApiKey(): string {
  return `ak_${randomBytes(ORGANIZATION_API_KEY_RAW_SECRET_BYTE_LENGTH).toString('hex')}`;
}

/** SHA-256 hex hash of the raw key, matching the API-key service's `hashApiKey`. */
function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/**
 * Seeds API keys per registry organization, topping up to `counts.apiKeysPerOrg`.
 *
 * @remarks
 * Algorithm: per organization, count existing seeded keys (by `name LIKE 'Bulk API Key %'`) and
 * create only the missing higher indices; in edge-case mode the last index is `REVOKED` +
 * soft-deleted. Side effects: inserts into `tenancy.api_keys`. Failure modes: warns and returns
 * early when no organizations exist or the configured count is zero; otherwise propagates DB
 * errors.
 */
export async function seedOrganizationApiKeysBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  const target = context.counts.apiKeysPerOrg;
  if (organizations.length === 0) {
    context.logger.warn(
      'seed.bulk.organization-api-key: empty organization pool; run the tenancy seeder first',
    );
    return;
  }
  if (target <= 0) {
    context.logger.info('seed.bulk.organization-api-key: apiKeysPerOrg is 0; nothing to seed');
    return;
  }

  const database = getRequestDatabase();
  let inserted = 0;
  for (const organization of organizations) {
    const existing = await database
      .select({ id: api_keys.id })
      .from(api_keys)
      .where(
        and(
          eq(api_keys.organization_id, organization.id),
          like(api_keys.name, BULK_API_KEY_NAME_PATTERN),
        ),
      );

    for (let index = existing.length; index < target; index += 1) {
      const rawKey = generateRawApiKey();
      const keyHash = hashApiKey(rawKey);
      const keyPrefix = rawKey.slice(0, ORGANIZATION_API_KEY_PREFIX_DISPLAY_LENGTH);
      const isRevokedEdgeCase = context.counts.edgeCases && index === target - 1;
      await database.insert(api_keys).values({
        public_id: generatePublicId('organizationApiKey'),
        organization_id: organization.id,
        name: `${BULK_API_KEY_NAME_PREFIX}${index}`,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        scopes: generateBulkApiKeyScopes(context.faker),
        status: isRevokedEdgeCase ? 'REVOKED' : 'ACTIVE',
        deleted_at: isRevokedEdgeCase ? new Date() : null,
        created_by_user_id: organization.ownerUserId,
      });
      inserted += 1;
    }
  }
  context.logger.info(
    { organizations: organizations.length, inserted },
    'seed.bulk.organization-api-key: API keys seeded',
  );
}
