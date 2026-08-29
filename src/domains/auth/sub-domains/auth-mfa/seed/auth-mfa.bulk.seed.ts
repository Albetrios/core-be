/**
 * Auth-mfa bulk seeder — enrolls a verified primary TOTP `auth.mfa_methods` factor plus a small
 * set of hashed `auth.mfa_recovery_codes` for a subset of users in the registry.
 *
 * Idempotency: MFA methods are count-and-resume by `user_id` (only users with no seeded method
 * are enrolled); recovery codes use a deterministic per-(user, slot) `code_hash` and the unique
 * `(user_id, code_hash)` index, so re-runs are absorbed by `.onConflictDoNothing()`.
 */
import { createHash } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { mfa_methods } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa-method.schema.js';
import { mfa_recovery_codes } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa-recovery-code.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkMfaMethod } from './auth-mfa.faker.js';

/** Enroll MFA for roughly one in every `MFA_USER_RATIO` users. */
const MFA_USER_RATIO = 3;
/** Number of recovery codes to provision per enrolled user. */
const RECOVERY_CODES_PER_USER = 3;

/** Deterministic 64-char recovery-code hash for a given user + slot (idempotency marker). */
function recoveryCodeHash(userPublicId: string, slot: number): string {
  return createHash('sha256').update(`seed-recovery:${userPublicId}:${slot}`).digest('hex');
}

/**
 * Seeds TOTP MFA factors and recovery codes for a deterministic subset of registry users.
 *
 * @remarks
 * Algorithm: select every `MFA_USER_RATIO`-th user, skip any already enrolled, enroll a verified
 * primary TOTP method, then insert {@link RECOVERY_CODES_PER_USER} deterministic recovery-code
 * hashes per enrolled user. Side effects: inserts into `auth.mfa_methods` and
 * `auth.mfa_recovery_codes`. Failure modes: warns and returns early when the user pool is empty;
 * otherwise propagates DB errors.
 */
export async function seedAuthMfaBulk(context: SeedContext): Promise<void> {
  const users = context.registry.users;
  if (users.length === 0) {
    context.logger.warn('seed.bulk.auth-mfa: empty user pool; run the user seeder first');
    return;
  }

  const database = getRequestDatabase();
  const candidates = users.filter((_user, index) => index % MFA_USER_RATIO === 0);
  const candidateIds = candidates.map((user) => user.id);
  const existing = await database
    .select({ user_id: mfa_methods.user_id })
    .from(mfa_methods)
    .where(inArray(mfa_methods.user_id, candidateIds));
  const enrolledUserIds = new Set(existing.map((row) => row.user_id));

  let enrolled = 0;
  for (const user of candidates) {
    if (enrolledUserIds.has(user.id)) continue;
    const profile = generateBulkMfaMethod(context.faker);
    await database
      .insert(mfa_methods)
      .values({
        public_id: generatePublicId('authMethod'),
        user_id: user.id,
        method_type: profile.method_type,
        encrypted_secret: profile.encrypted_secret,
        is_verified: true,
        is_primary: true,
        verified_at: new Date(),
        created_by_user_id: user.id,
      })
      .onConflictDoNothing();

    for (let slot = 0; slot < RECOVERY_CODES_PER_USER; slot += 1) {
      await database
        .insert(mfa_recovery_codes)
        .values({
          user_id: user.id,
          code_hash: recoveryCodeHash(user.public_id, slot),
        })
        .onConflictDoNothing();
    }
    enrolled += 1;
  }
  context.logger.info({ users: users.length, enrolled }, 'seed.bulk.auth-mfa: MFA factors seeded');
}
