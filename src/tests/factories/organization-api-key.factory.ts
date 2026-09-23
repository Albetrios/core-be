import { createHash, randomBytes } from 'node:crypto';
import { database } from '@/infrastructure/database/connection.js';
import { api_keys } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

export interface CreateApiKeyOptions {
  organizationId: number;
  name?: string;
  scopes?: string[];
  status?: string;
  createdByUserId?: number;
}

/**
 * Create a test organization API key owned by `organizationId` (tenancy.api_keys).
 */
export async function createTestApiKey(options: CreateApiKeyOptions) {
  const publicId = generatePublicId('organizationApiKey');
  const rawKey = randomBytes(24).toString('hex');
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const [apiKey] = await database
    .insert(api_keys)
    .values({
      public_id: publicId,
      organization_id: options.organizationId,
      name: options.name ?? 'Test API key',
      key_hash: keyHash,
      key_prefix: rawKey.slice(0, 8),
      scopes: options.scopes ?? [],
      status: options.status ?? 'ACTIVE',
      created_by_user_id: options.createdByUserId,
    })
    .returning();
  return apiKey!;
}
