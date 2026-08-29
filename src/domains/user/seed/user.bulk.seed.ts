/**
 * User bulk seeder — fills a deterministic pool of users sized to cover every organization's
 * owner + members, and records them in the {@link SeedContext} registry for downstream domains.
 *
 * Idempotency: bulk users use deterministic emails (`bulk-user-<index>@seed.local`); the seeder
 * only creates indices beyond those already present, so a re-run with the same counts is a no-op.
 */
import { like } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { users } from '@/domains/user/user.schema.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkUser } from './user.faker.js';
import { seedUser } from './user.seed.js';

const BULK_EMAIL_PREFIX = 'bulk-user-';
const BULK_EMAIL_SUFFIX = '@seed.local';
const BULK_EMAIL_PATTERN = `${BULK_EMAIL_PREFIX}%${BULK_EMAIL_SUFFIX}`;

/** Pool size: one owner + members across all organizations (average of the per-organization range). */
function poolSize(context: SeedContext): number {
  const { organizations, usersPerOrg } = context.counts;
  const averagePerOrg = Math.max(1, Math.round((usersPerOrg.min + usersPerOrg.max) / 2));
  return organizations * averagePerOrg;
}

/**
 * Seeds the user pool and appends every bulk user to `context.registry.users`.
 *
 * @remarks
 * Algorithm: count existing bulk users, insert only the missing higher indices, then re-select
 * the full pool into the registry. Side effects: inserts into `auth.users`. Failure modes:
 * propagates DB errors.
 */
export async function seedUsersBulk(context: SeedContext): Promise<void> {
  const database = getRequestDatabase();
  const target = poolSize(context);

  const existing = await database
    .select({ id: users.id })
    .from(users)
    .where(like(users.email, BULK_EMAIL_PATTERN));

  for (let index = existing.length; index < target; index += 1) {
    const profile = generateBulkUser(context.faker);
    await seedUser({
      email: `${BULK_EMAIL_PREFIX}${index}${BULK_EMAIL_SUFFIX}`,
      first_name: profile.first_name,
      last_name: profile.last_name,
      job_title: profile.job_title,
    });
  }

  const pool = await database
    .select({ id: users.id, public_id: users.public_id })
    .from(users)
    .where(like(users.email, BULK_EMAIL_PATTERN));
  for (const row of pool) {
    context.registry.addUser({ id: row.id, public_id: row.public_id });
  }
  context.logger.info({ users: pool.length }, 'seed.bulk.user: pool ready');
}
