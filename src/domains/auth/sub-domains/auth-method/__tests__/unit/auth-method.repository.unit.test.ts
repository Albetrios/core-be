import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthMethodRepository } from '@/domains/auth/sub-domains/auth-method/auth-method.repository.js';

const mockReturning = vi.fn().mockResolvedValue([]);
const mockLimit = vi.fn().mockResolvedValue([]);
const mockExecute = vi.fn().mockResolvedValue([]);
const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
const mockWhereForSelect = vi.fn(() => ({ limit: mockLimit, orderBy: mockOrderBy }));
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
    const databaseHandle = () => ({
      select: mockSelect,
      insert: mockInsert,
      update: mockUpdate,
      execute: mockExecute,
    });
    // SECURITY DEFINER resolver calls go through the context-free accessor: same mock handle.
    return {
      ...actual,
      getRequestDatabase: databaseHandle,
      getContextFreeDatabase: databaseHandle,
    };
  },
);

describe('AuthMethodRepository', () => {
  const repository = new AuthMethodRepository();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockReset();
    mockReturning.mockReset();
    mockExecute.mockReset();
    mockFrom.mockImplementation(() => ({ where: mockWhereForSelect }));
  });

  it('listByUserId returns active auth methods', async () => {
    const methods = [{ id: 1, method_type: 'PASSWORD' }];
    // audit #36: listByUserId now chains `.where().limit()` (limit+1 + capListWithWarning).
    mockLimit.mockResolvedValueOnce(methods);

    const result = await repository.listByUserId(10);

    expect(result).toEqual(methods);
  });

  it('listMfaByUserId returns MFA methods', async () => {
    const methods = [{ id: 2, method_type: 'MFA_TOTP' }];
    mockLimit.mockResolvedValueOnce(methods);

    const result = await repository.listMfaByUserId(10);

    expect(result).toEqual(methods);
  });

  it('findTotpByUserId returns first row or null', async () => {
    const totpMethod = { id: 3, method_type: 'MFA_TOTP' };
    mockLimit.mockResolvedValueOnce([totpMethod]);
    expect(await repository.findTotpByUserId(10)).toEqual(totpMethod);

    mockLimit.mockResolvedValueOnce([]);
    expect(await repository.findTotpByUserId(10)).toBeNull();
  });

  it('findByIdForUser returns null when method is absent', async () => {
    mockLimit.mockResolvedValueOnce([]);
    expect(await repository.findByIdForUser(99, 10)).toBeNull();
  });

  it('findByIdForUser returns row or null', async () => {
    const method = { id: 4, provider: 'google' };
    mockLimit.mockResolvedValueOnce([method]);
    expect(await repository.findByIdForUser(4, 10)).toEqual(method);

    mockLimit.mockResolvedValueOnce([]);
    expect(await repository.findByIdForUser(4, 10)).toBeNull();
  });

  it('findByProviderUserId resolves via the SECURITY DEFINER resolver and coerces bigint ids', async () => {
    mockExecute.mockResolvedValueOnce([]);
    expect(await repository.findByProviderUserId('google', 'gid')).toBeNull();
    expect(mockExecute).toHaveBeenCalledTimes(1);

    mockExecute.mockResolvedValueOnce([
      { id: '4', user_id: '10', user_public_id: 'usr_pub', provider: 'google' },
    ]);
    const resolved = await repository.findByProviderUserId('google', 'gid');
    expect(resolved).toMatchObject({ id: 4, user_id: 10, user_public_id: 'usr_pub' });
  });

  it('create inserts and returns auth method', async () => {
    const created = { id: 5, method_type: 'OAUTH' };
    mockReturning.mockResolvedValueOnce([created]);

    const result = await repository.create({
      user_id: 10,
      method_type: 'OAUTH',
      provider: 'google',
      provider_user_id: 'gid',
      is_primary: true,
      created_by_user_id: 10,
    });

    expect(result).toEqual(created);
    expect(mockInsert).toHaveBeenCalled();
  });

  it('updateLastUsedAt and revoke return null when no rows match', async () => {
    mockReturning.mockResolvedValue([]);
    expect(await repository.updateLastUsedAt(99, 10)).toBeNull();
    expect(await repository.revoke(99, 10)).toBeNull();
  });

  it('updateLastUsedAt, revoke, and revokeAllByUserId mutate rows', async () => {
    const updated = { id: 6, last_used_at: new Date() };
    mockReturning.mockResolvedValueOnce([updated]);
    expect(await repository.updateLastUsedAt(6, 10)).toEqual(updated);

    const revoked = { id: 6, revoked_at: new Date() };
    mockReturning.mockResolvedValueOnce([revoked]);
    expect(await repository.revoke(6, 10)).toEqual(revoked);

    mockReturning.mockResolvedValueOnce([{ id: 7 }, { id: 8 }]);
    expect(await repository.revokeAllByUserId(10)).toBe(2);
  });
});
