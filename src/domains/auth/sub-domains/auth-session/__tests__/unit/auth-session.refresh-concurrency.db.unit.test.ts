import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { AuthSessionRepository } from '@/domains/auth/sub-domains/auth-session/auth-session.repository.js';
import { sessions } from '@/domains/auth/sub-domains/auth-session/auth-session.schema.js';
import {
  createSessionDatabaseScope,
  withSessionDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

/**
 * audit-#2: two concurrent legitimate refreshes presenting the same refresh secret must both
 * succeed. The loser previously saw the already-rotated hash on the compare-and-swap and was
 * misclassified as stolen-token reuse, revoking the whole session family (a remotely triggerable
 * account-wide logout via double-click / two tabs / proxy retry). The repository CAS now accepts
 * the immediately-previous hash within a short grace window.
 */
describe('AuthSessionRepository refresh concurrency grace (database — audit-#2)', () => {
  const repository = new AuthSessionRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  async function seedSession(userId: number, refreshHash: string) {
    const publicId = generatePublicId('authSession');
    await database.insert(sessions).values({
      public_id: publicId,
      user_id: userId,
      token_hash: `tok-${publicId}`,
      refresh_token_hash: refreshHash,
      ip_address: '127.0.0.1',
      expires_at: new Date(Date.now() + 86_400_000),
    });
    return publicId;
  }

  it('lets two simultaneous refreshes with the same secret both rotate (no family revocation)', async () => {
    const user = await createTestUser({ email: 'refresh-race@example.com' });
    const presentedHash = 'shared-refresh-hash';
    const publicId = await seedSession(user.id, presentedHash);

    const [a, b] = await Promise.all([
      withSessionDatabaseContext(createSessionDatabaseScope('public_id', publicId), () =>
        repository.rotateSessionCredentials(publicId, presentedHash, 'tok-a', 'refresh-a'),
      ),
      withSessionDatabaseContext(createSessionDatabaseScope('public_id', publicId), () =>
        repository.rotateSessionCredentials(publicId, presentedHash, 'tok-b', 'refresh-b'),
      ),
    ]);

    // Both rotations returned a row — neither was rejected (which would trigger reuse detection).
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const [row] = await database
      .select({
        refresh_token_hash: sessions.refresh_token_hash,
        previous_refresh_token_hash: sessions.previous_refresh_token_hash,
        is_revoked: sessions.is_revoked,
      })
      .from(sessions)
      .where(eq(sessions.public_id, publicId));
    // The two new hashes end up as current + previous; the session is NOT revoked.
    expect(['refresh-a', 'refresh-b']).toContain(row!.refresh_token_hash);
    expect(['refresh-a', 'refresh-b']).toContain(row!.previous_refresh_token_hash);
    expect(row!.is_revoked).toBe(false);
  });

  it('rejects (null) a replay of the previous secret AFTER the grace window so reuse detection fires', async () => {
    const user = await createTestUser({ email: 'refresh-replay@example.com' });
    const presentedHash = 'original-refresh-hash';
    const publicId = await seedSession(user.id, presentedHash);

    // First rotation: original → A (original now in the previous slot, rotated = now).
    const first = await withSessionDatabaseContext(
      createSessionDatabaseScope('public_id', publicId),
      () => repository.rotateSessionCredentials(publicId, presentedHash, 'tok-a', 'refresh-a'),
    );
    expect(first).not.toBeNull();

    // Age the rotation beyond the grace window so the previous-hash branch can no longer match.
    await database
      .update(sessions)
      .set({ refresh_token_rotated_at: new Date(Date.now() - 60_000) })
      .where(eq(sessions.public_id, publicId));

    const replay = await withSessionDatabaseContext(
      createSessionDatabaseScope('public_id', publicId),
      () => repository.rotateSessionCredentials(publicId, presentedHash, 'tok-x', 'refresh-x'),
    );
    // Neither current (refresh-a) nor previous-within-grace matches → null → the service revokes.
    expect(replay).toBeNull();
  });
});
