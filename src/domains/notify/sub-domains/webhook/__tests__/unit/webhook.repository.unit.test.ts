import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookRepository } from '@/domains/notify/sub-domains/webhook/webhook.repository.js';

const mockReturning = vi.fn();
const mockLimit = vi.fn();
const mockOffset = vi.fn();
const mockOrderBy = vi.fn(() => ({ limit: mockLimit, offset: mockOffset }));
const mockWhere = vi.fn(() => ({
  limit: mockLimit,
  orderBy: mockOrderBy,
  returning: mockReturning,
}));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockSet = vi.fn(() => ({ where: mockWhere }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));
const mockValues = vi.fn(() => ({
  onConflictDoUpdate: vi.fn(() => ({ returning: mockReturning })),
  returning: mockReturning,
}));
const mockInsert = vi.fn(() => ({ values: mockValues }));

vi.mock('@/shared/utils/infrastructure/postgres-error.util.js', () => ({
  runInsertWithPublicIdentifierRetry: async (operation: () => Promise<unknown>) => operation(),
}));

vi.mock('@/shared/utils/identity/public-id.util.js', () => ({
  generatePublicId: () => 'webhook_public_test',
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

describe('WebhookRepository', () => {
  const repository = new WebhookRepository();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockReset();
    mockOffset.mockReset();
    mockReturning.mockReset();
  });

  it('listByOrganization returns webhooks for organization', async () => {
    const rows = [
      { public_id: 'wh_1', is_enabled: true, events: { 'subscription.updated': true } },
    ];
    mockLimit.mockResolvedValue(rows);

    const result = await repository.listByOrganization(10, { limit: 20 });

    expect(result.items).toEqual(rows);
    expect(result.total).toBeNull();
    expect(result.has_more).toBe(false);
  });

  it('listEnabledSubscribedToEvent returns SQL-filtered enabled subscribers', async () => {
    const rows = [{ public_id: 'wh_1', is_enabled: true, events: ['subscription.updated'] }];
    mockLimit.mockResolvedValue(rows);

    const result = await repository.listEnabledSubscribedToEvent(10, 'subscription.updated');

    expect(result).toHaveLength(1);
    expect(result[0]?.public_id).toBe('wh_1');
  });

  it('findByPublicId returns null when missing', async () => {
    mockLimit.mockResolvedValue([]);

    const result = await repository.findByPublicId('missing', 10);

    expect(result).toBeNull();
  });

  it('create inserts webhook row', async () => {
    const row = { public_id: 'webhook_public_test', url: 'https://example.com/hook' };
    mockReturning.mockResolvedValue([row]);

    const result = await repository.create({
      organization_id: 10,
      url: 'https://example.com/hook',
      encrypted_secret: 'secret',
      events: ['subscription.updated'],
    });

    expect(mockInsert).toHaveBeenCalled();
    expect(result).toEqual(row);
  });

  it('update and softDelete return null when webhook missing', async () => {
    mockReturning.mockResolvedValue([]);

    expect(await repository.update('missing', 10, { url: 'https://example.com/new' })).toBeNull();
    expect(await repository.softDelete('missing', 10)).toBeNull();
  });
});
