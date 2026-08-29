/**
 * Organization-settings bulk seeder — inserts one `tenancy.organization_settings` singleton row
 * per organization in the registry (PK = `organization_id`).
 *
 * Idempotency: the primary key is `organization_id`, so every insert uses `.onConflictDoNothing()`;
 * a re-run with the same registry is a no-op.
 */
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { organization_settings } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.schema.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkOrganizationSettings } from './organization-settings.faker.js';

/**
 * Seeds one settings row per registry organization.
 *
 * @remarks
 * Algorithm: for each organization, insert a faker-built settings row keyed by `organization_id`
 * with `.onConflictDoNothing()`, attributing `created_by_user_id` to the organization owner. Side effects:
 * inserts into `tenancy.organization_settings`. Failure modes: warns and returns early when no
 * organizations exist; otherwise propagates DB errors.
 */
export async function seedOrganizationSettingsBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn(
      'seed.bulk.organization-settings: empty organization pool; run the tenancy seeder first',
    );
    return;
  }

  const database = getRequestDatabase();
  for (const organization of organizations) {
    const profile = generateBulkOrganizationSettings(context.faker);
    await database
      .insert(organization_settings)
      .values({
        organization_id: organization.id,
        is_email_notifications_enabled: profile.is_email_notifications_enabled,
        default_locale: profile.default_locale,
        security_policy: profile.security_policy,
        created_by_user_id: organization.ownerUserId,
      })
      .onConflictDoNothing();
  }
  context.logger.info(
    { organizations: organizations.length },
    'seed.bulk.organization-settings: settings seeded',
  );
}
