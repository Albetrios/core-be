/**
 * Auth-session bulk seeder — inserts a few `auth.sessions` rows per user in the registry. When
 * `counts.edgeCases` is set, the last session per user is created already-expired (past
 * `created_at`/`expires_at`) to exercise the retention/cleanup path.
 *
 * Idempotency: count-and-resume — the per-(user, slot) `token_hash` is a deterministic SHA-256
 * marker and `token_hash` is unique, so re-runs only top up to the target session count and any
 * re-attempt of an existing slot is absorbed by `.onConflictDoNothing()`.
 */
import { createHash } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { sessions } from '@/domains/auth/sub-domains/auth-session/auth-session.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkSession } from './auth-session.faker.js';

/** Target number of sessions to maintain per user. */
const SESSIONS_PER_USER = 2;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Deterministic 64-char session token hash for a given user + slot (idempotency marker). */
function sessionTokenHash(userPublicId: string, slot: number): string {
  return createHash('sha256').update(`seed-session:${userPublicId}:${slot}`).digest('hex');
}

/**
 * Seeds sessions per registry user, topping up to {@link SESSIONS_PER_USER}.
 *
 * @remarks
 * Algorithm: count existing seeded sessions per user (by deterministic `token_hash` set), then
 * insert the missing slots; in edge-case mode the highest slot is back-dated and expired. Side
 * effects: inserts into `auth.sessions`. Failure modes: warns and returns early when the user
 * pool is empty; otherwise propagates DB errors.
 */
export async function seedAuthSessionsBulk(context: SeedContext): Promise<void> {
  const users = context.registry.users;
  if (users.length === 0) {
    context.logger.warn('seed.bulk.auth-session: empty user pool; run the user seeder first');
    return;
  }

  const database = getRequestDatabase();
  const allHashes = users.flatMap((user) =>
    Array.from({ length: SESSIONS_PER_USER }, (_, slot) => sessionTokenHash(user.public_id, slot)),
  );
  const existingRows = await database
    .select({ token_hash: sessions.token_hash })
    .from(sessions)
    .where(inArray(sessions.token_hash, allHashes));
  const existingHashes = new Set(existingRows.map((row) => row.token_hash));

  const now = Date.now();
  let inserted = 0;
  for (const user of users) {
    for (let slot = 0; slot < SESSIONS_PER_USER; slot += 1) {
      const tokenHash = sessionTokenHash(user.public_id, slot);
      if (existingHashes.has(tokenHash)) continue;
      const profile = generateBulkSession(context.faker);
      const isExpiredEdgeCase = context.counts.edgeCases && slot === SESSIONS_PER_USER - 1;
      const createdAt = isExpiredEdgeCase ? new Date(now - 30 * ONE_DAY_MS) : new Date(now);
      const expiresAt = isExpiredEdgeCase
        ? new Date(now - 23 * ONE_DAY_MS)
        : new Date(now + 7 * ONE_DAY_MS);
      await database
        .insert(sessions)
        .values({
          public_id: generatePublicId('authSession'),
          user_id: user.id,
          token_hash: tokenHash,
          ip_address: profile.ip_address,
          user_agent: profile.user_agent,
          last_active_at: createdAt,
          expires_at: expiresAt,
          created_at: createdAt,
        })
        .onConflictDoNothing();
      inserted += 1;
    }
  }
  context.logger.info({ users: users.length, inserted }, 'seed.bulk.auth-session: sessions seeded');
}
