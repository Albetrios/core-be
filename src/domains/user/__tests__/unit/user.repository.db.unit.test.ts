import { describe, it, expect, beforeEach } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { UserRepository } from '@/domains/user/user.repository.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

describe('UserRepository (database)', () => {
  const repository = new UserRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('finds, updates, lists, suspends, and soft-deletes users', async () => {
    const user = await createTestUser({ email: 'repo-user@example.com' });

    const byEmail = await repository.findByEmail('repo-user@example.com');
    expect(byEmail?.public_id).toBe(user.public_id);

    const byPublicId = await repository.findByPublicId(user.public_id);
    expect(byPublicId?.id).toBe(user.id);

    const byId = await repository.findById(user.id);
    expect(byId?.email).toBe('repo-user@example.com');

    const updated = await repository.update(user.public_id, { first_name: 'Updated' });
    expect(updated?.first_name).toBe('Updated');

    await repository.updatePassword(user.public_id, 'new-hash');
    const withPassword = await repository.findByPublicId(user.public_id);
    expect(withPassword?.password_hash).toBe('new-hash');

    await repository.updateEmailVerified(user.public_id);
    const verified = await repository.findByPublicId(user.public_id);
    expect(verified?.is_email_verified).toBe(true);

    await repository.markOnboardingComplete(user.public_id);
    const onboarded = await repository.findByPublicId(user.public_id);
    expect(onboarded?.onboarding_completed_at).not.toBeNull();
    // Idempotent: a second call preserves the original timestamp.
    const firstStamp = onboarded?.onboarding_completed_at;
    await repository.markOnboardingComplete(user.public_id);
    const reonboarded = await repository.findByPublicId(user.public_id);
    expect(reonboarded?.onboarding_completed_at).toEqual(firstStamp);

    const listed = await repository.findMany({ limit: 20, search: 'repo-user' });
    expect(listed.items.some((row) => row.public_id === user.public_id)).toBe(true);
    expect(listed.total).toBeNull();

    const listedWithTotal = await repository.findMany({
      limit: 20,
      search: 'repo-user',
      include_total: true,
    });
    expect(listedWithTotal.total).toBeGreaterThanOrEqual(1);

    const suspended = await repository.suspend(user.public_id);
    expect(suspended?.status).toBe('SUSPENDED');

    const unsuspended = await repository.unsuspend(user.public_id);
    expect(unsuspended?.status).toBe('ACTIVE');

    await repository.updateMfaEnabled(user.public_id, true);
    const withMfa = await repository.findByPublicId(user.public_id);
    expect(withMfa?.is_mfa_enabled).toBe(true);

    await repository.updateLoginAttempt(user.public_id, 3, new Date(Date.now() + 60_000));
    const withLock = await repository.findByPublicId(user.public_id);
    expect(withLock?.failed_login_count).toBe(3);

    const adminUpdated = await repository.adminUpdate(user.public_id, { status: 'SUSPENDED' });
    expect(adminUpdated?.status).toBe('SUSPENDED');

    // Soft-delete is a two-phase contract: deletion must be marked started before the row can be
    // soft-deleted (mirrors UserService.softDeleteUserWithOffboarding).
    await repository.markDeletionStarted(user.public_id);
    await repository.softDelete(user.public_id);
    const afterDelete = await repository.findByPublicId(user.public_id);
    expect(afterDelete).toBeNull();
  });

  it('softDelete is a no-op without markDeletionStarted (two-phase guard blocks the delete)', async () => {
    // The soft-delete UPDATE guards on `deletion_started_at IS NOT NULL`. Skipping the mark phase
    // must match 0 rows — returns null and leaves the row live — so a stray soft-delete can never
    // bypass the offboarding sequence that markDeletionStarted gates.
    const user = await createTestUser({ email: 'no-mark-softdelete@example.com' });

    const result = await repository.softDelete(user.public_id);
    expect(result).toBeNull();

    const stillLive = await repository.findByPublicId(user.public_id);
    expect(stillLive?.public_id).toBe(user.public_id);
    expect(stillLive?.deleted_at).toBeNull();
  });

  it('insertOAuthUser inserts oauth user with the supplied public_id', async () => {
    const publicId = generatePublicId('user');
    const oauthUser = await repository.insertOAuthUser(publicId, {
      email: 'oauth-user@example.com',
      first_name: 'OAuth',
      is_email_verified: true,
    });
    expect(oauthUser.public_id).toBe(publicId);
    expect(oauthUser.email).toBe('oauth-user@example.com');
    expect(oauthUser.is_email_verified).toBe(true);
  });

  it('incrementFailedLoginAttempt counts every concurrent failure (no lost updates)', async () => {
    const user = await createTestUser({ email: 'concurrent-failed-login@example.com' });
    const attempts = 8;
    const maxAttempts = 10;

    // Fire all failures at once. A read-modify-write would let several collapse into one
    // (two reads of N both write N+1); the atomic `count + 1` must land all of them.
    await Promise.all(
      Array.from({ length: attempts }, () =>
        repository.incrementFailedLoginAttempt(user.public_id, { maxAttempts, lockoutMinutes: 30 }),
      ),
    );

    const after = await repository.findByPublicId(user.public_id);
    expect(after?.failed_login_count).toBe(attempts);
    // Below the threshold, no lock is applied.
    expect(after?.account_locked_until).toBeNull();
  });

  it('incrementFailedLoginAttempt applies the lockout once the threshold is reached', async () => {
    const user = await createTestUser({ email: 'lockout-threshold@example.com' });
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await repository.incrementFailedLoginAttempt(user.public_id, {
        maxAttempts,
        lockoutMinutes: 30,
      });
    }

    const after = await repository.findByPublicId(user.public_id);
    expect(after?.failed_login_count).toBe(maxAttempts);
    expect(after?.account_locked_until).not.toBeNull();
    expect(new Date(after?.account_locked_until as unknown as string).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  // audit #13: admin search is now case-INSENSITIVE (was `like` — "john" missed "John") and
  // matches against the concatenated display name, targeting the trigram GIN indexes.
  it('admin search is case-insensitive and matches the display name (audit #13)', async () => {
    const user = await createTestUser({
      email: 'case-search-target@example.com',
      firstName: 'Johnathan',
      lastName: 'Quibblesworth',
    });

    const byFirstNameLower = await repository.findMany({ limit: 20, search: 'johnathan' });
    expect(byFirstNameLower.items.some((row) => row.public_id === user.public_id)).toBe(true);

    const byDisplayName = await repository.findMany({ limit: 20, search: 'johnathan quibbles' });
    expect(byDisplayName.items.some((row) => row.public_id === user.public_id)).toBe(true);

    const byEmailUpper = await repository.findMany({ limit: 20, search: 'CASE-SEARCH-TARGET' });
    expect(byEmailUpper.items.some((row) => row.public_id === user.public_id)).toBe(true);
  });

  // sec-r5: removing a PASSWORD auth-method must actually kill the credential so login stops
  // authenticating. Only the DECISION to call clearPasswordHash was tested (mocked); the SQL
  // (`password_hash = NULL`, guarded by `isNull(deleted_at)`, RETURNING) never ran.
  it('clearPasswordHash nulls the stored credential and persists it', async () => {
    const user = await createTestUser({ email: 'clear-hash@example.com' });
    await repository.updatePassword(user.public_id, 'live-hash');
    expect((await repository.findByPublicId(user.public_id))?.password_hash).toBe('live-hash');

    const cleared = await repository.clearPasswordHash(user.public_id);
    expect(cleared?.password_hash).toBeNull();
    // Re-read proves it persisted (not just the RETURNING row).
    expect((await repository.findByPublicId(user.public_id))?.password_hash).toBeNull();
  });

  it('clearPasswordHash returns null for an unknown user id', async () => {
    const result = await repository.clearPasswordHash(generatePublicId('user'));
    expect(result).toBeNull();
  });

  // Admin list status filter — no test anywhere passed `status`; a dropped predicate would return
  // the whole table for every filtered admin query.
  it('findMany filters the admin list by status', async () => {
    const active = await createTestUser({ email: 'active-filter@example.com' });
    const toSuspend = await createTestUser({ email: 'suspended-filter@example.com' });
    await repository.suspend(toSuspend.public_id);

    const suspendedOnly = await repository.findMany({ limit: 20, status: 'SUSPENDED' });
    const ids = suspendedOnly.items.map((row) => row.public_id);
    expect(ids).toContain(toSuspend.public_id);
    expect(ids).not.toContain(active.public_id);
  });

  // Keyset pagination traversal — every prior findMany test used a single matching row, so
  // has_more was only ever false and the opaque cursor round-trip never ran. An off-by-one on the
  // limit+1 sentinel or a cursor-encoding bug would drop or duplicate users across admin pages.
  it('findMany paginates by keyset: has_more + a cursor yielding a disjoint next page', async () => {
    const created = [];
    for (let index = 0; index < 3; index += 1) {
      created.push(await createTestUser({ email: `page-user-${index}@example.com` }));
    }

    const firstPage = await repository.findMany({ limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.has_more).toBe(true);
    expect(firstPage.next_cursor).toBeTruthy();

    const nextPage = await repository.findMany({ limit: 2, after: firstPage.next_cursor! });
    const firstPageIds = new Set(firstPage.items.map((row) => row.public_id));
    // Disjoint — no user appears on both pages.
    expect(nextPage.items.every((row) => !firstPageIds.has(row.public_id))).toBe(true);
    expect(nextPage.items.length).toBeGreaterThan(0);
    expect(created).toHaveLength(3);
  });
});
