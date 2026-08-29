import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserSettingsRepository } from '@/domains/user/sub-domains/user-settings/user-settings.repository.js';

// audit #12: upsert is now a single atomic INSERT ... ON CONFLICT DO UPDATE (no read-branch-write),
// so the mock chain is select (getByUserId) + insert().values().onConflictDoUpdate().returning().
const mockReturning = vi.fn().mockResolvedValue([]);
const mockOnConflictDoUpdate = vi.fn((_config: { set: Record<string, unknown> }) => ({
  returning: mockReturning,
}));
const mockValues = vi.fn((_row: Record<string, unknown>) => ({
  onConflictDoUpdate: mockOnConflictDoUpdate,
}));
const mockInsert = vi.fn(() => ({ values: mockValues }));
const mockLimit = vi.fn().mockResolvedValue([]);
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

vi.mock(
  '@/infrastructure/database/contexts/database-context-runtime.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      getRequestDatabase: () => ({
        select: mockSelect,
        insert: mockInsert,
      }),
    };
  },
);

describe('UserSettingsRepository', () => {
  const repository = new UserSettingsRepository();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue([]);
    mockReturning.mockResolvedValue([]);
  });

  it('getByUserId returns settings row', async () => {
    const settings = { user_id: 1, language: 'en' };
    mockLimit.mockResolvedValue([settings]);
    expect(await repository.getByUserId(1)).toEqual(settings);
  });

  it('getByUserId returns null when no row exists', async () => {
    mockLimit.mockResolvedValue([]);
    expect(await repository.getByUserId(999)).toBeNull();
  });

  it('upsert is a single atomic INSERT ... ON CONFLICT DO UPDATE — never a read-branch-write (audit #12)', async () => {
    const created = { user_id: 1, language: 'es' };
    mockReturning.mockResolvedValue([created]);

    const result = await repository.upsert(1, { language: 'es' });

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    // getByUserId (select) is NOT used by upsert anymore — no pre-read to race.
    expect(mockSelect).not.toHaveBeenCalled();
    expect(result).toEqual(created);
  });

  it('the conflict SET touches ONLY the supplied fields (no clobber of omitted ones)', async () => {
    await repository.upsert(1, { language: 'fr' });

    const setArg = mockOnConflictDoUpdate.mock.calls[0]![0]!.set as Record<string, unknown>;
    expect(setArg).toHaveProperty('language', 'fr');
    expect(setArg).toHaveProperty('updated_at');
    // Fields not in this PATCH must NOT appear in the SET (so they keep their stored value).
    expect(setArg).not.toHaveProperty('is_dark_mode_enabled');
    expect(setArg).not.toHaveProperty('is_notifications_enabled');
    expect(setArg).not.toHaveProperty('preferred_locales');
  });

  it('an empty PATCH only bumps updated_at in the conflict SET', async () => {
    await repository.upsert(2, {});

    const setArg = mockOnConflictDoUpdate.mock.calls[0]![0]!.set as Record<string, unknown>;
    expect(Object.keys(setArg)).toEqual(['updated_at']);
  });

  it('the INSERT row carries factory defaults for a brand-new row', async () => {
    await repository.upsert(3, { is_dark_mode_enabled: true });

    const insertedRow = mockValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertedRow).toMatchObject({
      user_id: 3,
      is_dark_mode_enabled: true,
      is_notifications_enabled: true,
      language: 'en',
      preferred_locales: ['en'],
    });
  });
});
