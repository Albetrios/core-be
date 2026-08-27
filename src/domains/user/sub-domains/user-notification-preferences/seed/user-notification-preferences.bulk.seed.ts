/**
 * User-notification-preferences bulk seeder — inserts one global (`organization_id IS NULL`)
 * `auth.user_notification_preferences` row per user in the registry.
 *
 * Idempotency: the table has no DB unique constraint (only a lookup index), so this seeder is
 * count-and-resume — it only inserts a row for users that have no seeded preference yet, making
 * a re-run with the same registry a no-op.
 */
import { inArray } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { user_notification_preferences } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.schema.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkNotificationPreference } from './user-notification-preferences.faker.js';

/**
 * Seeds one notification-preference row per registry user that does not already have one.
 *
 * @remarks
 * Algorithm: select the set of `user_id`s that already own a seeded preference, then insert a
 * single faker-built global preference for each remaining user. Side effects: inserts into
 * `auth.user_notification_preferences`. Failure modes: warns and returns early when the user
 * pool is empty; otherwise propagates DB errors.
 */
export async function seedUserNotificationPreferencesBulk(context: SeedContext): Promise<void> {
  const users = context.registry.users;
  if (users.length === 0) {
    context.logger.warn(
      'seed.bulk.user-notification-preferences: empty user pool; run the user seeder first',
    );
    return;
  }

  const database = getRequestDatabase();
  const userIds = users.map((user) => user.id);
  const existing = await database
    .select({ user_id: user_notification_preferences.user_id })
    .from(user_notification_preferences)
    .where(inArray(user_notification_preferences.user_id, userIds));
  const seededUserIds = new Set(existing.map((row) => row.user_id));

  let inserted = 0;
  for (const user of users) {
    if (seededUserIds.has(user.id)) continue;
    const profile = generateBulkNotificationPreference(context.faker);
    await database.insert(user_notification_preferences).values({
      user_id: user.id,
      organization_id: null,
      notification_type: profile.notification_type,
      channel: profile.channel,
      is_enabled: profile.is_enabled,
      created_by_user_id: user.id,
    });
    inserted += 1;
  }
  context.logger.info(
    { users: users.length, inserted },
    'seed.bulk.user-notification-preferences: preferences seeded',
  );
}
