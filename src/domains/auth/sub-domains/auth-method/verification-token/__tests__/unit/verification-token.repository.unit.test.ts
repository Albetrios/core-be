import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VerificationTokenRepository } from '@/domains/auth/sub-domains/auth-method/verification-token/verification-token.repository.js';

const mockReturning = vi.fn().mockResolvedValue([]);
const mockLimit = vi.fn().mockResolvedValue([]);
const mockWhereForSelect = vi.fn(() => ({ limit: mockLimit }));
const mockWhereForUpdate = vi.fn(() => ({ returning: mockReturning }));
const mockFrom = vi.fn(() => ({ where: mockWhereForSelect }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockSet = vi.fn(() => ({ where: mockWhereForUpdate }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));
const mockValues = vi.fn(() => ({ returning: mockReturning }));
const mockInsert = vi.fn(() => ({ values: mockValues }));

vi.mock(
  '@/infrastructure/database/contexts/database-context-runtime.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      getRequestDatabase: () => ({
        select: mockSelect,
        insert: mockInsert,
        update: mockUpdate,
      }),
    };
  },
);

describe('VerificationTokenRepository', () => {
  const repository = new VerificationTokenRepository();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockReset();
    mockReturning.mockReset();
  });

  it('create inserts verification token', async () => {
    const created = { id: 1, token_type: 'EMAIL_CODE' };
    mockReturning.mockResolvedValueOnce([created]);

    const result = await repository.create(
      'EMAIL_CODE',
      10,
      'user@example.com',
      'hash',
      new Date(Date.now() + 60_000),
    );

    expect(result).toEqual(created);
  });

  it('findValidByTokenHash returns row or null', async () => {
    const token = { id: 2, token_hash: 'hash' };
    mockLimit.mockResolvedValueOnce([token]);
    expect(await repository.findValidByTokenHash('hash')).toEqual(token);

    mockLimit.mockResolvedValueOnce([]);
    expect(await repository.findValidByTokenHash('missing')).toBeNull();
  });

  it('consumeIfValid returns consumed row or null', async () => {
    const consumed = { id: 3, token_type: 'PASSWORD_RESET' };
    mockReturning.mockResolvedValueOnce([consumed]);
    expect(await repository.consumeIfValid('hash', 'PASSWORD_RESET')).toEqual(consumed);

    mockReturning.mockResolvedValueOnce([]);
    expect(await repository.consumeIfValid('missing', 'PASSWORD_RESET')).toBeNull();
  });

  // audit #19: the unguarded `markUsed` was removed (dead code that bypassed the expiry/used-once
  // guards — a latent single-use-token double-consume). Consumers use the atomic `consumeIfValid`.

  it('invalidateAllForUser marks unused tokens used', async () => {
    mockWhereForUpdate.mockReturnValueOnce({ returning: vi.fn().mockResolvedValue([]) });
    await repository.invalidateAllForUser(10, 'EMAIL_CHANGE');
    expect(mockUpdate).toHaveBeenCalled();
  });
});
