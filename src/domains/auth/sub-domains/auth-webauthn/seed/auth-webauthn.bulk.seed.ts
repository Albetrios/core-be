/**
 * Auth-webauthn bulk seeder — registers one passkey (`auth.webauthn_credentials`) for a subset
 * of users in the registry.
 *
 * Idempotency: the per-user `credential_id` is a deterministic SHA-256 marker and the table has a
 * partial unique index on `credential_id WHERE revoked_at IS NULL`, so re-runs are absorbed by
 * `.onConflictDoNothing()` and only not-yet-seeded users receive a credential.
 */
import { createHash } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { webauthn_credentials } from '@/domains/auth/sub-domains/auth-webauthn/webauthn-credential.schema.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkWebauthn } from './auth-webauthn.faker.js';

/** Register a passkey for roughly one in every `WEBAUTHN_USER_RATIO` users. */
const WEBAUTHN_USER_RATIO = 3;

/** Deterministic credential id for a given user (idempotency marker). */
function credentialId(userPublicId: string): string {
  return `seed-cred-${createHash('sha256').update(userPublicId).digest('hex').slice(0, 32)}`;
}

/**
 * Seeds passkeys for a deterministic subset of registry users.
 *
 * @remarks
 * Algorithm: select every `WEBAUTHN_USER_RATIO`-th user, skip any whose deterministic
 * `credential_id` already exists, then insert a faker-built credential. Side effects: inserts
 * into `auth.webauthn_credentials`. Failure modes: warns and returns early when the user pool is
 * empty; otherwise propagates DB errors.
 */
export async function seedAuthWebauthnBulk(context: SeedContext): Promise<void> {
  const users = context.registry.users;
  if (users.length === 0) {
    context.logger.warn('seed.bulk.auth-webauthn: empty user pool; run the user seeder first');
    return;
  }

  const database = getRequestDatabase();
  const candidates = users.filter((_user, index) => index % WEBAUTHN_USER_RATIO === 0);
  const candidateCredentialIds = candidates.map((user) => credentialId(user.public_id));
  const existingRows = await database
    .select({ credential_id: webauthn_credentials.credential_id })
    .from(webauthn_credentials)
    .where(inArray(webauthn_credentials.credential_id, candidateCredentialIds));
  const existingCredentialIds = new Set(existingRows.map((row) => row.credential_id));

  let inserted = 0;
  for (const user of candidates) {
    const credential = credentialId(user.public_id);
    if (existingCredentialIds.has(credential)) continue;
    const profile = generateBulkWebauthn(context.faker);
    await database
      .insert(webauthn_credentials)
      .values({
        public_id: generatePublicId('webauthnCredential'),
        user_id: user.id,
        credential_id: credential,
        public_key: profile.public_key,
        counter: profile.counter,
        device_type: profile.device_type,
        backed_up: profile.backed_up,
        transports: profile.transports,
      })
      .onConflictDoNothing();
    inserted += 1;
  }
  context.logger.info(
    { users: users.length, inserted },
    'seed.bulk.auth-webauthn: credentials seeded',
  );
}
