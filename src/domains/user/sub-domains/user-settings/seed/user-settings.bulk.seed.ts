/**
 * User-settings bulk seeder — inserts one `auth.user_settings` singleton row per user in the
 * registry (PK = `user_id`).
 *
 * Idempotency: the primary key is `user_id`, so every insert uses `.onConflictDoNothing()`; a
 * re-run with the same registry is a no-op.
 */
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { user_settings } from '@/domains/user/sub-domains/user-settings/user-settings.schema.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkUserSettings } from './user-settings.faker.js';

/**
 * Seeds one settings row per registry user.
 *
 * @remarks
 * Algorithm: for each user, insert a faker-built settings row keyed by `user_id` with
 * `.onConflictDoNothing()`. Side effects: inserts into `auth.user_settings`. Failure modes:
 * warns and returns early when the user pool is empty; otherwise propagates DB errors.
 */
export async function seedUserSettingsBulk(context: SeedContext): Promise<void> {
  const users = context.registry.users;
  if (users.length === 0) {
    context.logger.warn('seed.bulk.user-settings: empty user pool; run the user seeder first');
    return;
  }

  const database = getRequestDatabase();
  for (const user of users) {
    const profile = generateBulkUserSettings(context.faker);
    await database
      .insert(user_settings)
      .values({
        user_id: user.id,
        is_dark_mode_enabled: profile.is_dark_mode_enabled,
        is_notifications_enabled: profile.is_notifications_enabled,
        language: profile.language,
        preferred_locales: profile.preferred_locales,
      })
      .onConflictDoNothing();
  }
  context.logger.info({ users: users.length }, 'seed.bulk.user-settings: settings seeded');
}
