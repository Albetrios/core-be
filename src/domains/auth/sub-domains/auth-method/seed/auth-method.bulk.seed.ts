/**
 * Auth-method bulk seeder — inserts one verified, primary `auth.auth_methods` login credential
 * (EMAIL_CODE or OAUTH) per user in the registry.
 *
 * Idempotency: count-and-resume — only users that have no seeded auth method receive one, so a
 * re-run with the same registry is a no-op.
 */
import { inArray } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { auth_methods } from '@/domains/auth/sub-domains/auth-method/auth-method.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkAuthMethod } from './auth-method.faker.js';

/**
 * Seeds one auth-method row per registry user that does not already have one.
 *
 * @remarks
 * Algorithm: select the set of `user_id`s that already own a seeded auth method, then insert a
 * faker-built verified primary credential for each remaining user. Side effects: inserts into
 * `auth.auth_methods`. Failure modes: warns and returns early when the user pool is empty;
 * otherwise propagates DB errors.
 */
export async function seedAuthMethodsBulk(context: SeedContext): Promise<void> {
  const users = context.registry.users;
  if (users.length === 0) {
    context.logger.warn('seed.bulk.auth-method: empty user pool; run the user seeder first');
    return;
  }

  const database = getRequestDatabase();
  const userIds = users.map((user) => user.id);
  const existing = await database
    .select({ user_id: auth_methods.user_id })
    .from(auth_methods)
    .where(inArray(auth_methods.user_id, userIds));
  const seededUserIds = new Set(existing.map((row) => row.user_id));

  let inserted = 0;
  for (const user of users) {
    if (seededUserIds.has(user.id)) continue;
    const profile = generateBulkAuthMethod(context.faker);
    await database.insert(auth_methods).values({
      public_id: generatePublicId('authMethod'),
      user_id: user.id,
      method_type: profile.method_type,
      provider: profile.provider,
      provider_user_id: profile.provider_user_id,
      is_primary: true,
      verified_at: new Date(),
      created_by_user_id: user.id,
    });
    inserted += 1;
  }
  context.logger.info({ users: users.length, inserted }, 'seed.bulk.auth-method: methods seeded');
}
