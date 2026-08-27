/**
 * User-data-export bulk seeder — inserts `auth.user_data_exports` rows for a subset of registry
 * users with mixed terminal statuses (completed/failed). When `counts.edgeCases` is set, one
 * additional user gets a deliberate `pending` export to exercise the in-flight path.
 *
 * Idempotency: count-and-resume — only users that have no seeded export row receive one, so a
 * re-run with the same registry is a no-op. The `idx_user_data_exports_user_pending` partial
 * unique index allows at most one pending/processing row per user, so the edge-case pending row
 * is only created for a user that has no export yet.
 */
import { inArray } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { user_data_exports } from '@/domains/user/sub-domains/user-data-export/user-data-export.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkDataExport } from './user-data-export.faker.js';

/** Seed an export for roughly one in every `EXPORT_USER_RATIO` users. */
const EXPORT_USER_RATIO = 4;

/**
 * Seeds data-export rows for a deterministic subset of registry users and, in edge-case mode,
 * one pending export.
 *
 * @remarks
 * Algorithm: select the set of `user_id`s that already own a seeded export; pick every
 * `EXPORT_USER_RATIO`-th remaining user for a terminal export; reserve one not-yet-seeded user
 * for a `pending` export when `edgeCases` is enabled. Side effects: inserts into
 * `auth.user_data_exports`. Failure modes: warns and returns early when the user pool is empty;
 * otherwise propagates DB errors.
 */
export async function seedUserDataExportsBulk(context: SeedContext): Promise<void> {
  const users = context.registry.users;
  if (users.length === 0) {
    context.logger.warn('seed.bulk.user-data-export: empty user pool; run the user seeder first');
    return;
  }

  const database = getRequestDatabase();
  const userIds = users.map((user) => user.id);
  const existing = await database
    .select({ user_id: user_data_exports.user_id })
    .from(user_data_exports)
    .where(inArray(user_data_exports.user_id, userIds));
  const seededUserIds = new Set(existing.map((row) => row.user_id));

  const candidates = users.filter((_user, index) => index % EXPORT_USER_RATIO === 0);
  let inserted = 0;
  for (const user of candidates) {
    if (seededUserIds.has(user.id)) continue;
    seededUserIds.add(user.id);
    const profile = generateBulkDataExport(context.faker);
    await database
      .insert(user_data_exports)
      .values({
        public_id: generatePublicId('userDataExport'),
        user_id: user.id,
        status: profile.status,
        s3_key: profile.s3_key,
        expires_at: profile.expires_at,
        completed_at: profile.completed_at,
        failed_at: profile.failed_at,
        error_code: profile.error_code,
      })
      .onConflictDoNothing();
    inserted += 1;
  }

  if (context.counts.edgeCases) {
    const pendingUser = users.find((user) => !seededUserIds.has(user.id));
    if (pendingUser) {
      await database
        .insert(user_data_exports)
        .values({
          public_id: generatePublicId('userDataExport'),
          user_id: pendingUser.id,
          status: 'pending',
        })
        .onConflictDoNothing();
      inserted += 1;
    }
  }

  context.logger.info(
    { users: users.length, inserted },
    'seed.bulk.user-data-export: exports seeded',
  );
}
