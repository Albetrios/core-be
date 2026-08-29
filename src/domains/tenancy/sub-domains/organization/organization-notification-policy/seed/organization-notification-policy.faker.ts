/**
 * Faker generators for the organization-notification-policy bulk seeder. Callers pass the
 * orchestrator's seeded `faker` so output is reproducible for a given `SEED`.
 */
import type { Faker } from '@faker-js/faker';

/** Generated delivery rule for one `tenancy.organization_notification_policies` row. */
export interface BulkNotificationPolicyProfile {
  /** Whether the `(type, channel)` pair is enabled by default for the organization. */
  default_enabled: boolean;
  /** Whether members cannot opt out of this pair. */
  is_mandatory: boolean;
}

/** Builds one fake notification-policy profile from the provided faker instance. */
export function generateBulkNotificationPolicy(faker: Faker): BulkNotificationPolicyProfile {
  return {
    default_enabled: faker.datatype.boolean({ probability: 0.85 }),
    is_mandatory: faker.datatype.boolean({ probability: 0.2 }),
  };
}
