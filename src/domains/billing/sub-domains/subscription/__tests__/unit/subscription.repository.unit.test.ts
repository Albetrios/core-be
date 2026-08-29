import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';

const mockLimit = vi.fn();
// audit #37: listByOrganization now chains `.orderBy().limit()`; other queries still use
// `.where().limit()` directly, so expose both off the where-result.
const mockOrderByList = vi.fn(() => ({ limit: mockLimit }));
const mockWhereList = vi.fn(() => ({ limit: mockLimit, orderBy: mockOrderByList }));
const mockLeftJoin = vi.fn(() => ({ where: mockWhereList }));
const mockFromList = vi.fn(() => ({ where: mockWhereList, leftJoin: mockLeftJoin }));
const mockSelect = vi.fn(() => ({ from: mockFromList }));

const mockReturning = vi.fn();
const mockWhereUpdate = vi.fn(() => ({ returning: mockReturning }));
const mockSet = vi.fn(() => ({ where: mockWhereUpdate }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));

const mockValues = vi.fn(() => ({ returning: mockReturning }));
const mockInsert = vi.fn(() => ({ values: mockValues }));

vi.mock('@/shared/utils/infrastructure/postgres-error.util.js', () => ({
  runInsertWithPublicIdentifierRetry: async (operation: () => Promise<unknown>) => operation(),
}));

vi.mock('@/shared/utils/identity/public-id.util.js', () => ({
  generatePublicId: () => 'subscription_public',
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
      // A5: resolveRepositoryDatabaseHandle now lives in the SAME module as
      // getRequestDatabase, so its internal call bypasses the export mock —
      // override it directly to hand repositories the same mock handle.
      resolveRepositoryDatabaseHandle: (databaseHandle: unknown) =>
        databaseHandle ?? {
          select: mockSelect,
          insert: mockInsert,
          update: mockUpdate,
        },
    };
  },
);

describe('SubscriptionRepository', () => {
  const repository = new SubscriptionRepository();

  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockReset();
    mockReturning.mockReset();
  });

  it('listByOrganization returns subscription rows', async () => {
    const subscription = { public_id: 'sub_1', organization_id: 10 };
    mockLimit.mockResolvedValue([subscription]);

    const result = await repository.listByOrganization(10, 5);

    // capListWithWarning fetches limit+1 to detect truncation without returning an extra row.
    expect(mockLimit).toHaveBeenCalledWith(6);
    expect(result).toEqual([subscription]);
  });

  it('findByPublicId returns null when subscription is missing', async () => {
    mockWhereList.mockReturnValueOnce({
      limit: vi.fn().mockResolvedValue([]),
      orderBy: mockOrderByList,
    });

    const result = await repository.findByPublicId('missing', 10);

    expect(result).toBeNull();
  });

  it('create inserts subscription with generated public id and re-selects with plan join (sec-re-07)', async () => {
    const inserted = { public_id: 'subscription_public', organization_id: 10 };
    // sec-re-07: create now does INSERT then SELECT-with-plan-join. First
    // `mockReturning` resolution feeds the INSERT; the SELECT goes through
    // `.from().leftJoin().where().limit()` chain so we override the chain's
    // limit to return the joined row.
    const joined = {
      public_id: 'subscription_public',
      organization_id: 10,
      plan_public_id: 'pln_pub',
    };
    mockReturning.mockResolvedValue([inserted]);
    mockLimit.mockResolvedValue([joined]);

    const result = await repository.create({
      organization_id: 10,
      plan_id: 1,
      billing_cycle: 'MONTHLY',
      current_period_start: new Date(),
      current_period_end: new Date(),
      provider: 'stripe',
      provider_subscription_id: 'sub_stripe',
      provider_customer_id: 'cus_stripe',
    });

    expect(result).toEqual(joined);
  });

  it('update returns null when subscription is not found', async () => {
    mockReturning.mockResolvedValue([]);

    const result = await repository.update('sub_missing', 10, { status: 'ACTIVE' });

    expect(result).toBeNull();
  });

  it('findByPublicId returns subscription row when present', async () => {
    const subscription = { public_id: 'sub_1', organization_id: 10, plan_public_id: 'pln_pub' };
    mockLimit.mockResolvedValueOnce([subscription]);

    const result = await repository.findByPublicId('sub_1', 10);

    expect(result).toEqual(subscription);
  });

  it('update returns updated subscription row joined with plan public id (sec-re-07)', async () => {
    // sec-re-07: update now performs UPDATE → SELECT-with-plan-join. The
    // first `mockReturning` resolution drives the UPDATE's RETURNING (id only);
    // the follow-up SELECT goes through the `.from().leftJoin().where().limit()`
    // chain so the same `mockLimit` mocks both the SELECT result.
    const updated = { public_id: 'sub_1', status: 'ACTIVE', plan_public_id: 'pln_pub' };
    mockReturning.mockResolvedValue([{ id: 1 }]);
    mockLimit.mockResolvedValue([updated]);

    const result = await repository.update('sub_1', 10, { status: 'ACTIVE' });

    expect(result).toEqual(updated);
  });

  it('syncFromStripeProviderSubscription returns updated row', async () => {
    const synced = { public_id: 'sub_1', provider_subscription_id: 'sub_stripe' };
    mockReturning.mockResolvedValue([synced]);

    const result = await repository.syncFromStripeProviderSubscription(
      'sub_stripe',
      { status: 'ACTIVE' },
      new Date(),
    );

    expect(result).toEqual(synced);
  });

  it('syncFromStripeProviderSubscription returns null when stale', async () => {
    mockReturning.mockResolvedValue([]);

    const result = await repository.syncFromStripeProviderSubscription(
      'sub_stale',
      { status: 'ACTIVE' },
      new Date(),
    );

    expect(result).toBeNull();
  });

  it('markCanceledByProviderSubscriptionId returns canceled row', async () => {
    const canceled = { public_id: 'sub_1', status: 'CANCELED' };
    mockReturning.mockResolvedValue([canceled]);

    const result = await repository.markCanceledByProviderSubscriptionId('sub_stripe', new Date());

    expect(result).toEqual(canceled);
  });

  it('markCanceledByProviderSubscriptionId returns null when no row updates', async () => {
    mockReturning.mockResolvedValue([]);

    const result = await repository.markCanceledByProviderSubscriptionId('sub_missing', new Date());

    expect(result).toBeNull();
  });
});
