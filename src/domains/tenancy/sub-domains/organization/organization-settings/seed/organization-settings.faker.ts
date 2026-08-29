/**
 * Faker generators for the organization-settings bulk seeder. Callers pass the orchestrator's
 * seeded `faker` so output is reproducible for a given `SEED`.
 */
import type { Faker } from '@faker-js/faker';

/** Generated content for one `tenancy.organization_settings` row. */
export interface BulkOrganizationSettingsProfile {
  /** Whether organization-wide email notifications are enabled. */
  is_email_notifications_enabled: boolean;
  /** Default UI locale; constrained to `en`/`es` by check constraint. */
  default_locale: string;
  /** Free-form security policy JSONB (MFA enforcement toggle). */
  security_policy: Record<string, unknown>;
}

const LOCALES = ['en', 'es'] as const;

/** Builds one fake organization-settings profile from the provided faker instance. */
export function generateBulkOrganizationSettings(faker: Faker): BulkOrganizationSettingsProfile {
  return {
    is_email_notifications_enabled: faker.datatype.boolean({ probability: 0.9 }),
    default_locale: faker.helpers.arrayElement(LOCALES),
    security_policy: { mfa_required: faker.datatype.boolean({ probability: 0.3 }) },
  };
}
