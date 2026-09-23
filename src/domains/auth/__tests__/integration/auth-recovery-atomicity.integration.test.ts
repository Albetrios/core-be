import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectUnauthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUserWithPassword } from '@/tests/factories/user.factory.js';
import { database } from '@/infrastructure/database/connection.js';
import { users } from '@/domains/user/user.schema.js';
import { verification_tokens } from '@/domains/auth/sub-domains/auth-method/verification-token/verification-token.schema.js';
import { AuthSessionRepository } from '@/domains/auth/sub-domains/auth-session/auth-session.repository.js';

/**
 * Atomicity regression for password reset (the account-recovery path).
 *
 * `resetPassword` consumes the token, updates the password, invalidates outstanding tokens, and
 * revokes every existing session — all in one transaction. If the session revocation fails after
 * the password is updated, the whole unit of work must roll back; otherwise a compromised
 * account's existing (attacker) sessions would survive the reset with the password already
 * changed. This test injects a failure at the session-revoke step and asserts nothing committed.
 */
async function seedUserWithResetToken(password: string) {
  const { user } = await createTestUserWithPassword({ password });
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  await database.insert(verification_tokens).values({
    token_type: 'PASSWORD_RESET',
    token_hash: tokenHash,
    user_id: user.id,
    email: user.email,
    expires_at: new Date(Date.now() + 3_600_000),
  });
  return { user, rawToken, tokenHash };
}

async function readPasswordHash(userId: number): Promise<string | null> {
  const rows = await database
    .select({ password_hash: users.password_hash })
    .from(users)
    .where(eq(users.id, userId));
  return rows[0]?.password_hash ?? null;
}

async function readTokenUsedAt(tokenHash: string): Promise<Date | null> {
  const rows = await database
    .select({ used_at: verification_tokens.used_at })
    .from(verification_tokens)
    .where(eq(verification_tokens.token_hash, tokenHash));
  return rows[0]?.used_at ?? null;
}

describe('Auth recovery atomicity — password reset', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rolls the password change back when session revocation fails mid-reset (no partial apply)', async () => {
    const { user, rawToken, tokenHash } = await seedUserWithResetToken('OldPassword123!');
    const passwordHashBefore = await readPasswordHash(user.id);
    expect(passwordHashBefore).toBeTruthy();

    // Inject a failure at the final in-transaction step (DB session revocation).
    const revokeSpy = vi
      .spyOn(AuthSessionRepository.prototype, 'revokeAllByUserId')
      .mockRejectedValueOnce(new Error('injected session-revoke failure'));

    const response = await injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/password/reset'),
      payload: { token: rawToken, password: 'BrandNewPassword456!' },
    });

    // The request fails (the injected error surfaces as a 5xx) ...
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(revokeSpy).toHaveBeenCalledTimes(1);

    // ... and crucially the transaction rolled back: password unchanged, token NOT consumed.
    expect(await readPasswordHash(user.id)).toBe(passwordHashBefore);
    expect(await readTokenUsedAt(tokenHash)).toBeNull();
  });

  it('commits the full reset (password changed + token consumed) on the happy path', async () => {
    const { user, rawToken, tokenHash } = await seedUserWithResetToken('OldPassword123!');
    const passwordHashBefore = await readPasswordHash(user.id);

    const response = await injectUnauthenticated(app, {
      method: 'POST',
      url: testApiPath('/auth/password/reset'),
      payload: { token: rawToken, password: 'BrandNewPassword456!' },
    });

    expect(response.statusCode).toBe(200);
    expect(await readPasswordHash(user.id)).not.toBe(passwordHashBefore);
    expect(await readTokenUsedAt(tokenHash)).not.toBeNull();
    // Auto-login: the reset response logs the user straight in (access token + session cookie).
    const body = response.json() as { data: { access_token?: string } };
    expect(body.data.access_token).toBeTruthy();
    expect(response.headers['set-cookie']).toBeDefined();
    // The reset also marks the email verified — the reset token proves control of the address.
    const [reset] = await database
      .select({ is_email_verified: users.is_email_verified })
      .from(users)
      .where(eq(users.id, user.id));
    expect(reset!.is_email_verified).toBe(true);
  });
});
