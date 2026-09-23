import { database } from '@/infrastructure/database/connection.js';
import { getElevatedDatabase } from '@/tests/helpers/elevated-database.js';
import { webhooks } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { encryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';

export interface CreateWebhookOptions {
  organizationId: number;
  url?: string;
  events?: string[];
  isEnabled?: boolean;
  createdByUserId?: number;
}

/**
 * Create a test webhook in the database.
 */
export async function createTestWebhook(options: CreateWebhookOptions) {
  const publicId = generatePublicId('webhook');
  const [webhook] = await getElevatedDatabase()
    .insert(webhooks)
    .values({
      public_id: publicId,
      organization_id: options.organizationId,
      url: options.url ?? 'https://httpbin.org/post',
      // Store a properly-encrypted secret (as production does) — decryptFieldSecret is now
      // fail-closed and rejects unprefixed plaintext.
      encrypted_secret: encryptFieldSecret('test-secret'),
      events: options.events ?? ['webhook.test'],
      is_enabled: options.isEnabled ?? true,
      created_by_user_id: options.createdByUserId,
    })
    .returning();
  return webhook!;
}
