/**
 * Webhook bulk seeder — creates `counts.webhooksPerOrg` enabled HTTPS endpoints for every
 * organization in the registry, each with a deterministic seed URL and an encrypted placeholder
 * signing secret. Returns nothing; the nested delivery-attempt seeder re-selects these rows by
 * the shared {@link BULK_WEBHOOK_URL_PATTERN} to attach delivery attempts.
 *
 * Idempotency: per organization, only webhook indices beyond those already present (matched by
 * the deterministic seed URL) are created — the `(organization_id, url)` unique index plus
 * count-and-resume make a re-run with the same counts a no-op.
 */
import { and, eq, like } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { encryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import { webhooks } from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';
import { generateBulkWebhook } from './webhook.faker.js';

/** Host suffix that brands every bulk-seeded webhook URL (used as the resume/select marker). */
const BULK_WEBHOOK_HOST_SUFFIX = '.webhooks.seed.local';
/** `LIKE` pattern matching all bulk-seeded webhook URLs (shared with the delivery-attempt seeder). */
export const BULK_WEBHOOK_URL_PATTERN = `https://bulk-seed-org-%${BULK_WEBHOOK_HOST_SUFFIX}/endpoint`;

/** Builds the deterministic, schema-valid (`^https://`) seed URL for one org's webhook index. */
function bulkWebhookUrl(organizationId: number, index: number): string {
  return `https://bulk-seed-org-${organizationId}-hook-${index}${BULK_WEBHOOK_HOST_SUFFIX}/endpoint`;
}

/** Seeds the webhook endpoints for a single organization, resuming from the existing count. */
async function seedWebhooksForOrganization(
  context: SeedContext,
  organization: SeededOrg,
): Promise<void> {
  const database = getRequestDatabase();
  const target = context.counts.webhooksPerOrg;

  const existing = await database
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(
      and(
        eq(webhooks.organization_id, organization.id),
        like(webhooks.url, BULK_WEBHOOK_URL_PATTERN),
      ),
    );

  for (let index = existing.length; index < target; index += 1) {
    const content = generateBulkWebhook(context.faker);
    await database
      .insert(webhooks)
      .values({
        public_id: generatePublicId('webhook'),
        organization_id: organization.id,
        url: bulkWebhookUrl(organization.id, index),
        encrypted_secret: encryptFieldSecret('seed-webhook-secret'),
        events: content.events,
        is_enabled: true,
        created_by_user_id: organization.ownerUserId,
        updated_by_user_id: organization.ownerUserId,
      })
      .onConflictDoNothing();
  }
}

/**
 * Seeds webhook endpoints for every organization in `context.registry.organizations`.
 *
 * @remarks
 * Parents read: `context.registry.organizations` (each {@link SeededOrg}; `ownerUserId` is the
 * created/updated-by attribution). Algorithm: per organization, count existing seed-URL rows and
 * insert only the remaining `webhooksPerOrg`. Side effects: inserts into `notify.webhooks`.
 * Failure modes: warns and returns early if the organization registry is empty; otherwise
 * propagates DB errors.
 */
export async function seedWebhooksBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn('seed.bulk.webhook: empty organization pool; run the tenancy seeder first');
    return;
  }

  for (const organization of organizations) {
    await seedWebhooksForOrganization(context, organization);
  }

  context.logger.info(
    { organizations: organizations.length, webhooksPerOrg: context.counts.webhooksPerOrg },
    'seed.bulk.webhook: webhooks seeded',
  );
}
