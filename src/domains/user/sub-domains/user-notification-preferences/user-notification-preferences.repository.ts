import { eq, sql as drizzleSql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { DEFAULT_REPOSITORY_LIST_LIMIT } from '@/shared/constants/query-limits.constants.js';
import { capListWithWarning } from '@/shared/utils/infrastructure/list-cap.util.js';
import { user_notification_preferences } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.schema.js';

/**
 * Two-key `pg_advisory_xact_lock` classid (objid = `user_id`) that serializes concurrent
 * {@link UserNotificationPreferencesRepository.replaceAll} for one user. The replace is a
 * non-atomic delete-then-insert, so without this lock two simultaneous
 * `PUT /users/me/notification-preferences` for the same user both delete then re-insert the
 * same `(user_id, notification_type, channel)` tuples and the loser trips
 * `idx_user_notif_prefs_user_type_channel_unique` (Postgres `23505`) or a serialization
 * failure (`40001`) → HTTP 500. Distinct from every classid in
 * `RESOURCE_CAP_ADVISORY_LOCK_NAMESPACES` (resource-cap-lock.ts) so the lock domains never collide.
 */
const USER_NOTIFICATION_PREFERENCES_REPLACE_LOCK_NAMESPACE = 0x55_4e_50_46; // 'UNPF'

/** Insert payload accepted by {@link UserNotificationPreferencesRepository.replaceAll}. */
export type PreferenceRow = {
  notification_type: string;
  channel: string;
  organization_id: number | null;
  is_enabled: boolean;
};

/**
 * Drizzle data-access for `auth.user_notification_preferences`. Implements the replace-all cascade:
 * `replaceAll` deletes every row for the user and re-inserts the supplied list within the request's
 * (RLS-bound) database scope so the user can only mutate their own preferences. Concurrent replaces
 * for the same user are serialized by a per-user advisory lock so the delete-then-insert cannot race
 * the natural-key unique index (see {@link USER_NOTIFICATION_PREFERENCES_REPLACE_LOCK_NAMESPACE}).
 */
export class UserNotificationPreferencesRepository {
  async listByUserId(user_id: number) {
    // audit #36: bound this user-self-scoped read with limit+1 + capListWithWarning (the preference
    // matrix is small, but this enforces a hard ceiling and surfaces an alert if it is ever hit).
    const rows = await getRequestDatabase()
      .select()
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, user_id))
      .limit(DEFAULT_REPOSITORY_LIST_LIMIT + 1);
    return capListWithWarning({
      rows,
      limit: DEFAULT_REPOSITORY_LIST_LIMIT,
      resource: 'user.user_notification_preferences',
      context: { userId: user_id },
    });
  }

  async replaceAll(user_id: number, preferences: PreferenceRow[], created_by_user_id?: number) {
    const requestDatabase = getRequestDatabase();
    // Serialize concurrent replaces for this user. The delete-then-insert below is not atomic
    // against other writers, so two simultaneous PUTs for the same user would both delete then
    // re-insert the same (user_id, type, channel) tuples and the loser would hit the unique
    // index (23505) or a serialization failure (40001) → HTTP 500. This transaction-scoped
    // advisory lock (released at COMMIT/ROLLBACK of the surrounding withUserDatabaseContext
    // transaction) makes the replace strict per user.
    await requestDatabase.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(${USER_NOTIFICATION_PREFERENCES_REPLACE_LOCK_NAMESPACE}::int, ${user_id}::int)`,
    );
    await requestDatabase
      .delete(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, user_id));
    if (preferences.length === 0) return [];
    // audit-#11: collapse duplicate (notification_type, channel) tuples — last
    // occurrence wins — so the idx_user_notif_prefs_user_type_channel_unique index
    // cannot be tripped by a payload that repeats a tuple.
    const deduplicatedPreferences = Array.from(
      new Map(
        preferences.map((preference) => [
          `${preference.notification_type} ${preference.channel}`,
          preference,
        ]),
      ).values(),
    );
    const rows = await requestDatabase
      .insert(user_notification_preferences)
      .values(
        deduplicatedPreferences.map((preference) => ({
          user_id,
          organization_id: preference.organization_id ?? undefined,
          notification_type: preference.notification_type,
          channel: preference.channel,
          is_enabled: preference.is_enabled,
          created_by_user_id: created_by_user_id ?? undefined,
        })),
      )
      .returning();
    return rows;
  }
}
