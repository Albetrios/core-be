import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthSessionRepository } from '@/domains/auth/sub-domains/auth-session/auth-session.repository.js';

const mockReturning = vi.fn().mockResolvedValue([]);
const mockLimit = vi.fn().mockResolvedValue([]);
const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
const mockWhereForSelect = vi.fn(() => ({ orderBy: mockOrderBy, limit: mockLimit }));
const mockWhereForUpdate = vi.fn(() => ({ returning: mockReturning }));
const mockFrom = vi.fn(() => ({ where: mockWhereForSelect }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockSet = vi.fn(() => ({ where: mockWhereForUpdate }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));
const mockValues = vi.fn(() => ({ returning: mockReturning }));
const mockInsert = vi.fn(() => ({ values: mockValues }));

vi.mock('@/shared/utils/infrastructure/postgres-error.util.js', () => ({
  runInsertWithPublicIdentifierRetry: async (operation: () => Promise<unknown>) => operation(),
}));

vi.mock('@/shared/utils/identity/public-id.util.js', () => ({
  generatePublicId: () => 'session_public_test_id',
}));

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

describe('AuthSessionRepository', () => {
  const repository = new AuthSessionRepository();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockReset();
    mockReturning.mockReset();
    mockFrom.mockImplementation(() => ({ where: mockWhereForSelect }));
  });

  it('listByUserId returns active sessions', async () => {
    const sessions = [{ public_id: 'session_1' }];
    mockOrderBy.mockReturnValueOnce({ limit: vi.fn().mockResolvedValue(sessions) });

    const result = await repository.listByUserId(10);

    expect(result).toEqual(sessions);
  });

  it('findByPublicId and findByPublicIdForUser return row or null', async () => {
    const session = { public_id: 'session_1', user_id: 10 };
    mockLimit.mockResolvedValueOnce([session]);
    expect(await repository.findByPublicId('session_1')).toEqual(session);

    mockLimit.mockResolvedValueOnce([]);
    expect(await repository.findByPublicIdForUser('missing', 10)).toBeNull();
  });

  it('findByTokenHash returns session or null', async () => {
    const session = { public_id: 'session_1', token_hash: 'hash' };
    mockLimit.mockResolvedValueOnce([session]);
    expect(await repository.findByTokenHash('hash')).toEqual(session);

    mockLimit.mockResolvedValueOnce([]);
    expect(await repository.findByTokenHash('missing')).toBeNull();
  });

  it('revoke and revokeByTokenHash return null when session is missing', async () => {
    mockReturning.mockResolvedValue([]);
    expect(await repository.revoke('missing', 10)).toBeNull();
    expect(await repository.revokeByTokenHash('missing-hash')).toBeNull();
  });

  it('updateLastActiveAt and rotateTokenHash update sessions', async () => {
    mockWhereForUpdate.mockReturnValueOnce(Promise.resolve() as never);
    await repository.updateLastActiveAt('session_1');
    expect(mockUpdate).toHaveBeenCalled();

    mockWhereForUpdate.mockReturnValueOnce(Promise.resolve() as never);
    await repository.rotateTokenHash('session_1', 'new-hash');
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it('revoke, revokeByTokenHash, and revokeAllByUserId mutate sessions', async () => {
    const revoked = { public_id: 'session_1' };
    mockReturning.mockResolvedValueOnce([revoked]);
    expect(await repository.revoke('session_1', 10)).toEqual(revoked);

    mockReturning.mockResolvedValueOnce([revoked]);
    expect(await repository.revokeByTokenHash('hash')).toEqual(revoked);

    mockReturning.mockResolvedValueOnce([revoked]);
    expect(await repository.revokeAllByUserId(10)).toEqual([revoked]);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('create inserts session with generated public id', async () => {
    const created = { public_id: 'session_public_test_id', user_id: 10 };
    mockReturning.mockResolvedValueOnce([created]);

    const result = await repository.create({
      user_id: 10,
      token_hash: 'hash',
      refresh_token_hash: 'refresh-hash',
      ip_address: '127.0.0.1',
      user_agent: 'vitest',
      expires_at: new Date(Date.now() + 86_400_000),
    });

    expect(result).toEqual(created);
  });
});
