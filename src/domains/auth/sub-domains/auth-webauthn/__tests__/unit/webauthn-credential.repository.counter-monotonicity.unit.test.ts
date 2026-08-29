import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * sec-D11: WebAuthn signature-counter monotonicity guard at the repository
 * layer (defense in depth on top of the `@simplewebauthn/server` library
 * verifier). The spec marks a static or decreasing counter as a possibly-cloned
 * authenticator signal; the library checks the in-memory value at verify time,
 * but a concurrent verify can pass that check and race the UPDATE — letting the
 * second write roll the stored counter backward. The repository pins
 * monotonicity into the SQL WHERE clause so the regression can never land,
 * regardless of caller ordering, while still allowing zero-counter
 * authenticators (Apple Passkeys / Windows Hello) the no-op `0 → 0` write.
 *
 * The repository uses `getRequestDatabase()` and the WebAuthn schema is FORCE
 * RLS keyed on `app.current_user_public_id`, so a real-DB exercise of `updateCounter`
 * would need the full user-context plumbing. This suite instead spies on the
 * Drizzle operators imported by the repository and asserts the monotonicity
 * operator (`lt` vs `eq`) is chosen based on the new counter value.
 */

const { ltSpy, eqSpy, isNullSpy, andSpy } = vi.hoisted(() => ({
  ltSpy: vi.fn((column: unknown, value: unknown) => ({ __op: 'lt', column, value })),
  eqSpy: vi.fn((column: unknown, value: unknown) => ({ __op: 'eq', column, value })),
  isNullSpy: vi.fn((column: unknown) => ({ __op: 'isNull', column })),
  andSpy: vi.fn((...conditions: unknown[]) => ({ __op: 'and', conditions })),
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    lt: ltSpy,
    eq: eqSpy,
    isNull: isNullSpy,
    and: andSpy,
  };
});

const updateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue(undefined),
};

vi.mock(
  '@/infrastructure/database/contexts/database-context-runtime.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      getRequestDatabase: () => ({
        update: () => updateChain,
      }),
    };
  },
);

vi.mock('@/shared/utils/infrastructure/database-timestamp.util.js', () => ({
  databaseNowTimestamp: { __databaseNow: true },
}));

import { WebauthnCredentialRepository } from '@/domains/auth/sub-domains/auth-webauthn/webauthn-credential.repository.js';

describe('WebauthnCredentialRepository.updateCounter — monotonicity guard (sec-D11)', () => {
  const repository = new WebauthnCredentialRepository();

  beforeEach(() => {
    vi.clearAllMocks();
    updateChain.set.mockClear().mockReturnThis();
    updateChain.where.mockClear().mockResolvedValue(undefined);
  });

  it('SETs counter and last_used_at, and builds exactly one WHERE clause', async () => {
    await repository.updateCounter('cred_abc', 7);

    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ counter: 7 }));
    expect(updateChain.where).toHaveBeenCalledTimes(1);
  });

  it('uses Drizzle `lt(counter, newCounter)` when newCounter > 0 (strict-increase)', async () => {
    await repository.updateCounter('cred_strict', 42);

    // The strict-increase branch must use `lt(counter, 42)` — `lt(stored, new)`
    // means UPDATE only succeeds when stored < new, so the new write is always
    // monotonically greater. `eq(counter, 0)` (the zero-only branch) must NOT
    // fire here.
    expect(ltSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'counter' }), 42);
    expect(eqSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'counter' }),
      expect.anything(),
    );
  });

  it('uses Drizzle `eq(counter, 0)` when newCounter === 0 (zero-counter authenticator)', async () => {
    await repository.updateCounter('cred_zero', 0);

    // Zero-counter authenticators (Apple / Windows Hello) pin counter at 0
    // forever. The guard must use equality, not strict-increase, so the valid
    // `0 → 0` no-op write is not rejected (which would block every subsequent
    // login from those authenticators).
    expect(eqSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'counter' }), 0);
    // The strict-increase operator must NOT fire on the counter column when
    // newCounter is 0; lt(counter, 0) would always be false and refuse every
    // verify for zero-counter authenticators.
    expect(ltSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'counter' }),
      expect.anything(),
    );
  });
});
