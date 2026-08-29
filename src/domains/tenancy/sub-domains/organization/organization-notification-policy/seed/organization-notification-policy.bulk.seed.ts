/**
 * Organization-notification-policy bulk seeder — inserts one default `tenancy.organization_
 * notification_policies` row per organization in the registry for a fixed
 * `(notification_type, channel)` pair (`security.alert` / `EMAIL`).
 *
 * Idempotency: the row is keyed by the deterministic natural key and the
 * `idx_org_notif_policy_unique(organization_id, notification_type, channel)` unique index, so
 * every insert uses `.onConflictDoNothing()` and a re-run with the same registry is a no-op.
 */
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { organization_notification_policies } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/organization-notification-policy.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkNotificationPolicy } from './organization-notification-policy.faker.js';

/** Fixed `(type, channel)` pair seeded per organization so the natural-key unique index gates re-runs. */
const SEED_NOTIFICATION_TYPE = 'security.alert';
const SEED_CHANNEL = 'EMAIL';

/**
 * Seeds one notification policy per registry organization.
 *
 * @remarks
 * Algorithm: for each organization, insert a faker-built policy for the fixed `(type, channel)`
 * pair with `.onConflictDoNothing()` against the natural-key unique index, attributing
 * `created_by_user_id` to the organization owner. Side effects: inserts into
 * `tenancy.organization_notification_policies`. Failure modes: warns and returns early when no
 * organizations exist; otherwise propagates DB errors.
 */
export async function seedOrganizationNotificationPoliciesBulk(
  context: SeedContext,
): Promise<void> {
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn(
      'seed.bulk.organization-notification-policy: empty organization pool; run the tenancy seeder first',
    );
    return;
  }

  const database = getRequestDatabase();
  for (const organization of organizations) {
    const profile = generateBulkNotificationPolicy(context.faker);
    await database
      .insert(organization_notification_policies)
      .values({
        public_id: generatePublicId('organizationNotificationPolicy'),
        organization_id: organization.id,
        notification_type: SEED_NOTIFICATION_TYPE,
        channel: SEED_CHANNEL,
        default_enabled: profile.default_enabled,
        is_mandatory: profile.is_mandatory,
        created_by_user_id: organization.ownerUserId,
      })
      .onConflictDoNothing();
  }
  context.logger.info(
    { organizations: organizations.length },
    'seed.bulk.organization-notification-policy: policies seeded',
  );
}
