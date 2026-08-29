import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MfaRepository } from '@/domains/auth/sub-domains/auth-mfa/auth-mfa.repository.js';

const mockReturning = vi.fn().mockResolvedValue([]);
const mockLimit = vi.fn().mockResolvedValue([]);
const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
const mockWhereForSelect = vi.fn(() => ({ limit: mockLimit, orderBy: mockOrderBy }));
const mockWhereForUpdate = vi.fn(() => ({ returning: mockReturning }));
const mockFrom = vi.fn(() => ({ where: mockWhereForSelect }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockSet = vi.fn(() => ({ where: mockWhereForUpdate }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));

vi.mock(
  '@/infrastructure/database/contexts/database-context-runtime.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      getRequestDatabase: () => ({
        select: mockSelect,
        update: mockUpdate,
      }),
    };
  },
);

describe('MfaRepository', () => {
  const repository = new MfaRepository();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockReset();
    mockReturning.mockReset();
  });

  it('findTotpByUserId returns first TOTP method', async () => {
    const totpMethod = { id: 1, method_type: 'MFA_TOTP', user_id: 5 };
    mockLimit.mockResolvedValue([totpMethod]);

    const result = await repository.findTotpByUserId(5);

    expect(result).toEqual(totpMethod);
  });

  it('findTotpByUserId returns null when absent', async () => {
    mockLimit.mockResolvedValue([]);

    const result = await repository.findTotpByUserId(5);

    expect(result).toBeNull();
  });

  it('listMfaByUserId returns MFA methods for user', async () => {
    const methods = [{ id: 1, method_type: 'MFA_TOTP' }];
    // audit #36: listMfaByUserId now chains `.where().limit()` (limit+1 + capListWithWarning).
    mockLimit.mockResolvedValueOnce(methods);

    const result = await repository.listMfaByUserId(5);

    expect(result).toEqual(methods);
  });

  it('findByIdForUser returns method when found', async () => {
    const method = { id: 2, user_id: 5 };
    mockLimit.mockResolvedValue([method]);

    const result = await repository.findByIdForUser(2, 5);

    expect(result).toEqual(method);
  });

  it('updateLastUsedAt updates timestamp', async () => {
    const updated = { id: 2, last_used_at: new Date() };
    mockReturning.mockResolvedValue([updated]);

    const result = await repository.updateLastUsedAt(2, 5);

    expect(mockUpdate).toHaveBeenCalled();
    expect(result).toEqual(updated);
  });

  it('revoke sets revoked_at', async () => {
    const revoked = { id: 2, revoked_at: new Date() };
    mockReturning.mockResolvedValue([revoked]);

    const result = await repository.revoke(2, 5);

    expect(result).toEqual(revoked);
  });

  it('findByIdForUser returns null when method is absent', async () => {
    mockLimit.mockResolvedValue([]);

    const result = await repository.findByIdForUser(99, 5);

    expect(result).toBeNull();
  });

  it('updateLastUsedAt returns null when update affects no rows', async () => {
    mockReturning.mockResolvedValue([]);

    const result = await repository.updateLastUsedAt(99, 5);

    expect(result).toBeNull();
  });

  it('revoke returns null when method is already revoked', async () => {
    mockReturning.mockResolvedValue([]);

    const result = await repository.revoke(99, 5);

    expect(result).toBeNull();
  });
});
