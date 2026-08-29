import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemberRoleRepository } from '@/domains/tenancy/sub-domains/member-roles/member-role.repository.js';

/**
 * Drizzle row chain: `select().from(...).where(...).orderBy(...).limit(...)` resolves to
 * the fetched rows. The repository no longer issues a parallel count query, so only the
 * row chain needs to be mocked.
 */
const mockLimit = vi.fn();
const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
const mockWhereRows = vi.fn(() => ({ orderBy: mockOrderBy }));
const mockFromRows = vi.fn(() => ({ where: mockWhereRows }));
const mockSelect = vi.fn();

const mockReturning = vi.fn();
const mockSet = vi.fn(() => ({ where: vi.fn(() => ({ returning: mockReturning })) }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));
const mockValues = vi.fn(() => ({ returning: mockReturning }));
const mockInsert = vi.fn(() => ({ values: mockValues }));

vi.mock('@/shared/utils/infrastructure/postgres-error.util.js', () => ({
  runInsertWithPublicIdentifierRetry: async (operation: () => Promise<unknown>) => operation(),
}));

vi.mock('@/shared/utils/identity/public-id.util.js', () => ({
  generatePublicId: () => 'role_public_test',
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

describe('MemberRoleRepository', () => {
  const repository = new MemberRoleRepository();

  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockReset();
    mockLimit.mockReset();
    mockSelect.mockImplementation(() => ({ from: mockFromRows }));
  });

  it('findByOrganizationId returns empty list when no rows', async () => {
    mockLimit.mockResolvedValue([]);

    const result = await repository.findByOrganizationId(1, { limit: 20, order: 'asc' });

    expect(result.items).toEqual([]);
    expect(result.total).toBeNull();
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeNull();
    expect(result.limit).toBe(20);
  });

  it('findByOrganizationId returns paginated roles', async () => {
    const rows = [
      {
        public_id: 'role_1',
        name: 'Admin',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        id: 1,
      },
    ];
    mockLimit.mockResolvedValue(rows);

    const result = await repository.findByOrganizationId(1, { limit: 20, order: 'asc' });

    expect(result.items).toHaveLength(1);
    expect(result.has_more).toBe(false);
  });

  it('findByPublicId returns null when role is missing', async () => {
    mockSelect.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    });

    const result = await repository.findByPublicId('missing', 1);

    expect(result).toBeNull();
  });

  it('update and softDelete return null when role is missing', async () => {
    mockReturning.mockResolvedValue([]);

    expect(await repository.update('missing', 1, { name: 'X' }, 9)).toBeNull();
    expect(await repository.softDelete('missing', 1)).toBeNull();
  });

  it('create inserts role with explicit is_system false', async () => {
    const created = { public_id: 'role_public_test', is_system: false };
    mockReturning.mockResolvedValue([created]);

    const result = await repository.create({
      organization_id: 1,
      name: 'Custom',
      is_system: false,
    });

    expect(result).toEqual(created);
  });
});
