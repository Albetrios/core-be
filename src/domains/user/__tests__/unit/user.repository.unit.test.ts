import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserRepository } from '@/domains/user/user.repository.js';

const mockReturning = vi.fn().mockResolvedValue([]);
const mockOffset = vi.fn().mockResolvedValue([]);
const mockLimit = vi.fn().mockResolvedValue([]);
const mockExecute = vi.fn().mockResolvedValue([]);
const mockOrderBy = vi.fn(() => ({ limit: mockLimit, offset: mockOffset }));
const mockWhere = vi.fn(() => ({
  limit: mockLimit,
  returning: mockReturning,
  orderBy: mockOrderBy,
  offset: mockOffset,
}));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockSet = vi.fn(() => ({ where: mockWhere }));
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
        execute: mockExecute,
      }),
    };
  },
);

describe('UserRepository', () => {
  const repository = new UserRepository();

  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockReset();
    mockLimit.mockReset();
    mockOffset.mockReset();
    mockExecute.mockReset();
  });

  it('findByPublicId returns null when missing', async () => {
    mockLimit.mockResolvedValue([]);
    expect(await repository.findByPublicId('missing')).toBeNull();
  });

  it('findByEmail resolves via the SECURITY DEFINER resolver (null when missing, bigint coerced)', async () => {
    mockExecute.mockResolvedValueOnce([]);
    expect(await repository.findByEmail('missing@example.com')).toBeNull();
    expect(mockExecute).toHaveBeenCalledTimes(1);

    mockExecute.mockResolvedValueOnce([{ id: '7', public_id: 'usr_pub', email: 'a@example.com' }]);
    const resolved = await repository.findByEmail('a@example.com');
    expect(resolved).toMatchObject({ id: 7, public_id: 'usr_pub' });
  });

  it('findById resolves via the SECURITY DEFINER resolver (null when missing, bigint coerced)', async () => {
    mockExecute.mockResolvedValueOnce([]);
    expect(await repository.findById(999)).toBeNull();

    mockExecute.mockResolvedValueOnce([{ id: '12', public_id: 'usr_pub' }]);
    const resolved = await repository.findById(12);
    expect(resolved).toMatchObject({ id: 12, public_id: 'usr_pub' });
  });

  it('insertOAuthUser inserts with the supplied public_id and returns the row', async () => {
    const created = { id: 3, public_id: 'usr_oauth', email: 'oauth@example.com' };
    mockReturning.mockResolvedValueOnce([created]);
    const result = await repository.insertOAuthUser('usr_oauth', {
      email: 'oauth@example.com',
      is_email_verified: true,
    });
    expect(result).toEqual(created);
    expect(mockInsert).toHaveBeenCalled();
  });

  it('updatePassword returns null when user missing', async () => {
    mockReturning.mockResolvedValue([]);
    expect(await repository.updatePassword('missing', 'hash')).toBeNull();
  });

  it('updateEmailVerified returns null when user missing', async () => {
    mockReturning.mockResolvedValue([]);
    expect(await repository.updateEmailVerified('missing')).toBeNull();
  });

  it('update returns null when user missing', async () => {
    mockReturning.mockResolvedValue([]);
    expect(await repository.update('missing', { first_name: 'A' })).toBeNull();
  });

  it('adminUpdate returns null when user missing', async () => {
    mockReturning.mockResolvedValue([]);
    expect(await repository.adminUpdate('missing', { status: 'SUSPENDED' })).toBeNull();
  });

  it('suspend and unsuspend return null when user missing', async () => {
    mockReturning.mockResolvedValue([]);
    expect(await repository.suspend('missing')).toBeNull();
    expect(await repository.unsuspend('missing')).toBeNull();
  });

  it('softDelete returns null when user missing', async () => {
    mockReturning.mockResolvedValue([]);
    expect(await repository.softDelete('missing')).toBeNull();
  });

  it('updateLoginAttempt and updateMfaEnabled return null when user missing', async () => {
    mockReturning.mockResolvedValue([]);
    expect(await repository.updateLoginAttempt('missing', 1, null)).toBeNull();
    expect(await repository.updateMfaEnabled('missing', true)).toBeNull();
  });

  it('findMany returns empty keyset result when no rows match (count(*) only when include_total=true)', async () => {
    const rowsQueryThenable = Promise.resolve([]);
    const rowsLimit = vi.fn(() => rowsQueryThenable);
    const rowsOrderBy = vi.fn(() => ({ limit: rowsLimit }));
    const rowsWhere = vi.fn(() => ({ orderBy: rowsOrderBy }));
    const rowsFrom = vi.fn(() => ({ where: rowsWhere }));
    mockSelect.mockReturnValueOnce({ from: rowsFrom } as never);

    const result = await repository.findMany({ limit: 20, search: 'none' });

    expect(result.items).toEqual([]);
    expect(result.total).toBeNull();
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeNull();
  });
});
