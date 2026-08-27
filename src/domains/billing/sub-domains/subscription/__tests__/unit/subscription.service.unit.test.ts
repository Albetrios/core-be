import { describe, it, expect, vi, beforeEach } from 'vitest';

// REQ-4: stub the seat-sync producer queue so changePlan's best-effort enqueue never opens Redis.
vi.mock(
  '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.queue.js',
  () => ({
    enqueueSubscriptionSeatSyncBestEffort: vi.fn(),
  }),
);

vi.mock(
  '@/infrastructure/database/contexts/principal-database.context.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      withPrincipalDatabaseContext: vi.fn(
        async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
      ),
    };
  },
);

// audit-#B4: run the create critical section transparently by default (the lock is exercised in
// redis-lock.util.unit.test.ts). Individual tests override withRedisLock to simulate contention.
const redisLockMocks = vi.hoisted(() => {
  class RedisLockUnavailableError extends Error {}
  return {
    RedisLockUnavailableError,
    withRedisLock: vi.fn(async (_options: unknown, fn: () => Promise<unknown>) => fn()),
  };
});
vi.mock('@/infrastructure/cache/redis-lock.util.js', () => redisLockMocks);

import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableEntityError,
  ValidationError,
} from '@/shared/errors/index.js';
import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';
import { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { PlanService } from '@/domains/billing/sub-domains/plan/plan.service.js';
import { StripePaymentProvider } from '@/domains/billing/sub-domains/subscription/stripe-payment-provider.js';
import type { SubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';

const stripeMocks = vi.hoisted(() => ({
  isStripeConfigured: vi.fn(() => false),
  createStripeCustomer: vi.fn().mockResolvedValue({ id: 'cus_stripe' }),
  createStripeSubscription: vi.fn().mockResolvedValue({ id: 'sub_stripe' }),
  updateStripeSubscription: vi.fn().mockResolvedValue({ id: 'sub_stripe' }),
  cancelStripeSubscription: vi.fn().mockResolvedValue({ id: 'sub_stripe' }),
  resumeStripeSubscription: vi.fn().mockResolvedValue({ id: 'sub_stripe' }),
}));

vi.mock('@/infrastructure/payment/stripe.client.js', () => stripeMocks);

const organization = {
  id: 1,
  public_id: 'org_public',
  stripe_customer_id: null,
  name: 'Org',
  slug: 'org',
};
const plan = {
  id: 2,
  public_id: 'plan_public',
  price_monthly: '10.00',
  price_yearly: '100.00',
  currency: 'USD',
  stripe_price_monthly_id: null,
  stripe_price_yearly_id: null,
};
const subscriptionRow = {
  id: 3,
  public_id: 'sub_public',
  organization_id: 1,
  plan_id: 2,
  billing_cycle: 'MONTHLY',
  status: 'ACTIVE',
  current_period_start: new Date('2026-05-01'),
  current_period_end: new Date('2026-06-01'),
  provider_subscription_id: null,
};

const scope = createPrincipalDatabaseScope({
  userPublicId: 'user_public',
  organizationPublicId: 'org_public',
  source: 'token',
}) as OrganizationPrincipalDatabaseScope;

describe('SubscriptionService', () => {
  const organizationService = {
    requireOrganizationByPublicId: vi.fn().mockResolvedValue(organization),
    resolveUserInternalIdByPublicId: vi.fn().mockResolvedValue(10),
    updateStripeCustomerIdForOrganization: vi.fn(),
  } as unknown as OrganizationService;

  const planService = {
    requirePlanRecordByPublicId: vi.fn().mockResolvedValue(plan),
    requireActivePlanByPublicId: vi.fn().mockResolvedValue(plan),
    requirePlanRecordByInternalId: vi.fn().mockResolvedValue(plan),
  } as unknown as PlanService;

  const repository = {
    listByOrganization: vi.fn().mockResolvedValue([subscriptionRow]),
    findActiveByOrganization: vi.fn().mockResolvedValue(null),
    findByPublicId: vi.fn().mockResolvedValue(subscriptionRow),
    create: vi.fn().mockResolvedValue(subscriptionRow),
    update: vi.fn().mockResolvedValue({ ...subscriptionRow, cancel_at_period_end: true }),
    syncFromStripeProviderSubscription: vi.fn(),
    markCanceledByProviderSubscriptionId: vi.fn(),
  } as unknown as SubscriptionRepository;

  const paymentProvider = new StripePaymentProvider(organizationService);

  const service = new SubscriptionService(
    organizationService,
    planService,
    repository,
    paymentProvider,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(repository.findActiveByOrganization).mockResolvedValue(null);
    vi.mocked(repository.findByPublicId).mockResolvedValue(subscriptionRow as never);
    vi.mocked(repository.update).mockResolvedValue(subscriptionRow as never);
  });

  it('list returns subscriptions for organization', async () => {
    const result = await service.list(scope);
    // REQ-4: each row is decorated with seats_total / seats_used (superset of the repo row).
    expect(result).toMatchObject([subscriptionRow]);
    expect(result[0]).toHaveProperty('seats_total');
  });

  it('get returns subscription when found', async () => {
    const result = await service.get(scope, 'sub_public');
    expect(result.public_id).toBe('sub_public');
  });

  it('get throws when subscription missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(service.get(scope, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('create allows re-subscription after cancel when no non-terminal row exists', async () => {
    vi.mocked(repository.findActiveByOrganization).mockResolvedValue(null);
    const result = await service.create(
      scope,
      { plan_id: 'plan_public', billing_cycle: 'monthly' },
      'user_public',
    );
    expect(repository.findActiveByOrganization).toHaveBeenCalledWith(organization.id);
    expect(repository.create).toHaveBeenCalled();
    // REQ-4: the row is now decorated with seats_total / seats_used, so it is a superset of the
    // repository row — assert the original fields survived rather than exact equality.
    expect(result).toMatchObject(subscriptionRow);
    expect(result).toHaveProperty('seats_used');
  });

  it('audit-#B4: create wraps the critical section in a per-org Redis lock', async () => {
    await service.create(
      scope,
      { plan_id: 'plan_public', billing_cycle: 'monthly' },
      'user_public',
    );
    expect(redisLockMocks.withRedisLock).toHaveBeenCalledTimes(1);
    const lockOptions = redisLockMocks.withRedisLock.mock.calls[0]![0] as { key: string };
    expect(lockOptions.key).toBe('billing:subscription:create:org_public');
  });

  it('audit-#B4: create maps lock contention to a retryable 409 without minting a second Stripe sub', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    // Simulate a concurrent create still holding the lock past our wait window.
    redisLockMocks.withRedisLock.mockRejectedValueOnce(
      new redisLockMocks.RedisLockUnavailableError('billing:subscription:create:org_public'),
    );
    await expect(
      service.create(scope, { plan_id: 'plan_public', billing_cycle: 'monthly' }, 'user_public'),
    ).rejects.toBeInstanceOf(ConflictError);
    // The critical section never ran, so no Stripe subscription was created for the loser.
    expect(stripeMocks.createStripeSubscription).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('create rejects with ConflictError before Stripe when an active subscription exists', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(repository.findActiveByOrganization).mockResolvedValue(subscriptionRow as never);
    await expect(
      service.create(scope, { plan_id: 'plan_public', billing_cycle: 'monthly' }, 'user_public'),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(stripeMocks.createStripeSubscription).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('create maps a unique_violation to ConflictError and compensates Stripe', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: 'price_monthly',
    } as never);
    vi.mocked(repository.create).mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
    );

    await expect(
      service.create(scope, { plan_id: 'plan_public', billing_cycle: 'monthly' }, 'user_public'),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(stripeMocks.cancelStripeSubscription).toHaveBeenCalledWith('sub_stripe', false);
  });

  it('create persists local subscription without Stripe', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(false);
    const result = await service.create(
      scope,
      { plan_id: 'plan_public', billing_cycle: 'monthly' },
      'user_public',
    );
    expect(repository.create).toHaveBeenCalled();
    // REQ-4: the row is now decorated with seats_total / seats_used, so it is a superset of the
    // repository row — assert the original fields survived rather than exact equality.
    expect(result).toMatchObject(subscriptionRow);
    expect(result).toHaveProperty('seats_used');
    // audit-#2: a local-only subscription (no Stripe) leaves status unset so the
    // repository default (TRIALING) applies — there is no payment to be pending on.
    const createPayload = vi.mocked(repository.create).mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    expect(createPayload).not.toHaveProperty('status');
  });

  it('create persists status INCOMPLETE when Stripe backs the subscription (audit-#2)', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: 'price_monthly',
    } as never);

    await service.create(
      scope,
      { plan_id: 'plan_public', billing_cycle: 'monthly' },
      'user_public',
    );

    const createPayload = vi.mocked(repository.create).mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    // The Stripe subscription is `incomplete` (default_incomplete) with no payment
    // yet, so the local row must NOT over-report as the entitled TRIALING state.
    expect(createPayload.status).toBe('INCOMPLETE');
    expect(createPayload.provider_subscription_id).toBe('sub_stripe');
  });

  it('update rejects cancel_at_period_end (sec-B1: use /cancel + /resume instead)', async () => {
    await expect(
      service.update(scope, 'sub_public', { cancel_at_period_end: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('update with empty body returns the existing subscription (no-op)', async () => {
    const result = await service.update(scope, 'sub_public', {});
    // REQ-4: the row is now decorated with seats_total / seats_used, so it is a superset of the
    // repository row — assert the original fields survived rather than exact equality.
    expect(result).toMatchObject(subscriptionRow);
    expect(result).toHaveProperty('seats_used');
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('changePlan updates plan on subscription', async () => {
    await service.changePlan(scope, 'sub_public', { plan_id: 'plan_public' });
    expect(repository.update).toHaveBeenCalled();
  });

  it('cancel marks subscription to cancel at period end', async () => {
    await service.cancel(scope, 'sub_public');
    expect(repository.update).toHaveBeenCalledWith(
      'sub_public',
      1,
      expect.objectContaining({ cancel_at_period_end: true }),
    );
  });

  it('resume clears cancel_at_period_end but does NOT force status=ACTIVE (sec-B4)', async () => {
    await service.resume(scope, 'sub_public');
    expect(repository.update).toHaveBeenCalledWith(
      'sub_public',
      1,
      expect.objectContaining({ cancel_at_period_end: false }),
    );
    // sec-B4: status is no longer force-written; the upcoming Stripe webhook reconciles it.
    const updatePayload = vi.mocked(repository.update).mock.calls[0]![2];
    expect(updatePayload.status).toBeUndefined();
    // sec-B3: HTTP mutations stamp the watermark so a stale Stripe event cannot regress.
    expect(updatePayload.last_stripe_event_created_at).toBeInstanceOf(Date);
  });

  it('create uses Stripe when configured and plan has price id', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: 'price_monthly',
    } as never);

    await service.create(
      scope,
      { plan_id: 'plan_public', billing_cycle: 'monthly' },
      'user_public',
    );

    expect(stripeMocks.createStripeCustomer).toHaveBeenCalled();
    expect(stripeMocks.createStripeSubscription).toHaveBeenCalled();
    expect(organizationService.updateStripeCustomerIdForOrganization).toHaveBeenCalled();
  });

  it('create forwards the request idempotency key to Stripe and uses a deterministic customer-create key', async () => {
    // Money-path regression (C1): the X-Idempotency-Key threaded controller -> service ->
    // provider must land on Stripe's subscription-create. A dropped key lets a retry or a
    // double-click that crosses the in-flight window mint a SECOND paid subscription.
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: 'price_monthly',
    } as never);

    await service.create(
      scope,
      { plan_id: 'plan_public', billing_cycle: 'monthly' },
      'user_public',
      'idem-create-key',
    );

    // audit #3: the client key is namespaced by operation + org before reaching Stripe's
    // account-global idempotency space (no cross-tenant key collision).
    expect(stripeMocks.createStripeSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'sub-create:org_public:idem-create-key' }),
    );
    // The customer-create uses a deterministic per-org key (`customer-create:<org>`) so a
    // retried create after a crash returns the same Stripe customer instead of minting a
    // duplicate (organization has no stripe_customer_id in this fixture).
    expect(stripeMocks.createStripeCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'customer-create:org_public' }),
    );
  });

  it('changePlan forwards the request idempotency key to the Stripe price update', async () => {
    // Money-path regression (C4): updateStripeSubscription is a non-atomic retrieve-then-update;
    // a retried change-plan WITHOUT the forwarded key can double-apply the proration. The key
    // must reach the Stripe price swap's options.
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...subscriptionRow,
      provider_subscription_id: 'sub_stripe',
    } as never);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: 'price_monthly',
    } as never);

    await service.changePlan(scope, 'sub_public', { plan_id: 'plan_public' }, 'idem-change-key');

    // audit #3: namespaced by operation + org before reaching Stripe's account-global key space.
    expect(stripeMocks.updateStripeSubscription).toHaveBeenCalledWith(
      'sub_stripe',
      expect.objectContaining({ idempotencyKey: 'sub-change-plan:org_public:idem-change-key' }),
    );
  });

  it('cancel calls Stripe when provider subscription id exists', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...subscriptionRow,
      provider_subscription_id: 'sub_stripe',
    } as never);

    await service.cancel(scope, 'sub_public');
    expect(stripeMocks.cancelStripeSubscription).toHaveBeenCalledWith(
      'sub_stripe',
      true,
      undefined,
    );
  });

  it('resume calls Stripe when provider subscription id exists', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...subscriptionRow,
      provider_subscription_id: 'sub_stripe',
    } as never);

    await service.resume(scope, 'sub_public');
    expect(stripeMocks.resumeStripeSubscription).toHaveBeenCalledWith('sub_stripe', undefined);
  });

  it('changePlan updates Stripe subscription when configured', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...subscriptionRow,
      provider_subscription_id: 'sub_stripe',
    } as never);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: 'price_monthly',
    } as never);

    await service.changePlan(scope, 'sub_public', { plan_id: 'plan_public' });
    expect(stripeMocks.updateStripeSubscription).toHaveBeenCalled();
  });

  it('create compensates Stripe subscription when local create fails', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: 'price_monthly',
    } as never);
    vi.mocked(repository.create).mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      service.create(scope, { plan_id: 'plan_public', billing_cycle: 'monthly' }, 'user_public'),
    ).rejects.toThrow('database unavailable');

    expect(stripeMocks.cancelStripeSubscription).toHaveBeenCalledWith('sub_stripe', false);
  });

  it('changePlan reverts Stripe price when local update fails after Stripe update', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...subscriptionRow,
      provider_subscription_id: 'sub_stripe',
      billing_cycle: 'MONTHLY',
    } as never);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: 'price_new',
    } as never);
    vi.mocked(planService.requirePlanRecordByInternalId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: 'price_old',
    } as never);
    vi.mocked(repository.update).mockResolvedValueOnce(null);

    await expect(
      service.changePlan(scope, 'sub_public', { plan_id: 'plan_public' }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(stripeMocks.updateStripeSubscription).toHaveBeenCalledTimes(2);
    expect(stripeMocks.updateStripeSubscription).toHaveBeenLastCalledWith('sub_stripe', {
      priceId: 'price_old',
    });
  });

  it('create fails closed when Stripe create fails — no local subscription committed', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: 'price_monthly',
    } as never);
    stripeMocks.createStripeSubscription.mockRejectedValueOnce(new Error('stripe down'));

    await expect(
      service.create(scope, { plan_id: 'plan_public', billing_cycle: 'monthly' }, 'user_public'),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('syncFromStripeProviderSubscription and markCanceled delegate to repository', async () => {
    const eventDate = new Date();
    await service.syncFromStripeProviderSubscription('sub_stripe', { status: 'ACTIVE' }, eventDate);
    await service.markCanceledByStripeProviderSubscriptionId('sub_stripe', eventDate);
    expect(repository.syncFromStripeProviderSubscription).toHaveBeenCalled();
    expect(repository.markCanceledByProviderSubscriptionId).toHaveBeenCalled();
  });

  it('cancel and resume fail closed when Stripe calls fail — local state unchanged', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...subscriptionRow,
      provider_subscription_id: 'sub_stripe',
    } as never);
    stripeMocks.cancelStripeSubscription.mockRejectedValueOnce(new Error('stripe cancel failed'));
    stripeMocks.resumeStripeSubscription.mockRejectedValueOnce(new Error('stripe resume failed'));

    await expect(service.cancel(scope, 'sub_public')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    await expect(service.resume(scope, 'sub_public')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('update with empty body throws NotFoundError when subscription is missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(service.update(scope, 'sub_public', {})).rejects.toBeInstanceOf(NotFoundError);
  });

  it('changePlan throws when subscription is missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(
      service.changePlan(scope, 'sub_public', { plan_id: 'plan_public' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('changePlan throws when update returns no row', async () => {
    vi.mocked(repository.update).mockResolvedValue(null);
    await expect(
      service.changePlan(scope, 'sub_public', { plan_id: 'plan_public' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('cancel and resume throw when subscription is missing or update fails', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(service.cancel(scope, 'sub_public')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.resume(scope, 'sub_public')).rejects.toBeInstanceOf(NotFoundError);

    vi.mocked(repository.findByPublicId).mockResolvedValue(subscriptionRow as never);
    vi.mocked(repository.update).mockResolvedValue(null);
    await expect(service.cancel(scope, 'sub_public')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.resume(scope, 'sub_public')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('create reuses existing Stripe customer and supports yearly price', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(organizationService.requireOrganizationByPublicId).mockResolvedValue({
      ...organization,
      stripe_customer_id: 'cus_existing',
    } as never);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_yearly_id: 'price_yearly',
    } as never);

    await service.create(scope, { plan_id: 'plan_public', billing_cycle: 'yearly' }, 'user_public');

    expect(stripeMocks.createStripeCustomer).not.toHaveBeenCalled();
    expect(stripeMocks.createStripeSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_existing',
        priceId: 'price_yearly',
      }),
    );
  });

  it('create logs and continues when plan has no Stripe price id', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: null,
      stripe_price_yearly_id: null,
    } as never);

    await service.create(
      scope,
      { plan_id: 'plan_public', billing_cycle: 'monthly' },
      'user_public',
    );
    expect(stripeMocks.createStripeSubscription).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalled();
  });

  it('changePlan compensates with yearly Stripe price when billing cycle is yearly', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...subscriptionRow,
      provider_subscription_id: 'sub_stripe',
      billing_cycle: 'YEARLY',
    } as never);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_yearly_id: 'price_new_yearly',
    } as never);
    vi.mocked(planService.requirePlanRecordByInternalId).mockResolvedValue({
      ...plan,
      stripe_price_yearly_id: 'price_old_yearly',
    } as never);
    vi.mocked(repository.update).mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      service.changePlan(scope, 'sub_public', { plan_id: 'plan_public' }),
    ).rejects.toThrow('database unavailable');

    expect(stripeMocks.updateStripeSubscription).toHaveBeenLastCalledWith('sub_stripe', {
      priceId: 'price_old_yearly',
    });
  });

  it('changePlan does not compensate when previous plan has no Stripe price id', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...subscriptionRow,
      provider_subscription_id: 'sub_stripe',
    } as never);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: 'price_new',
    } as never);
    vi.mocked(planService.requirePlanRecordByInternalId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: null,
      stripe_price_yearly_id: null,
    } as never);
    vi.mocked(repository.update).mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      service.changePlan(scope, 'sub_public', { plan_id: 'plan_public' }),
    ).rejects.toThrow('database unavailable');

    expect(stripeMocks.updateStripeSubscription).toHaveBeenCalledTimes(1);
  });

  it('create persists without created_by_user_id when user cannot be resolved', async () => {
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(null);
    await service.create(
      scope,
      { plan_id: 'plan_public', billing_cycle: 'monthly' },
      'missing_user',
    );
    const createPayload = vi.mocked(repository.create).mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    expect(createPayload).not.toHaveProperty('created_by_user_id');
  });

  // audit H2: a Stripe-backed subscription changing to a plan with no Stripe price id
  // for its cycle must FAIL CLOSED — otherwise the local plan_id is updated while
  // Stripe keeps billing the old price (un-self-healing divergence). The old test
  // enshrined the buggy "proceeds local-only" behavior; flipped to assert the throw.
  it('changePlan fails closed when a Stripe-backed subscription targets a plan with no Stripe price id (audit H2)', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...subscriptionRow,
      provider_subscription_id: 'sub_stripe',
    } as never);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: null,
      stripe_price_yearly_id: null,
    } as never);

    await expect(
      service.changePlan(scope, 'sub_public', { plan_id: 'plan_public' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
    expect(stripeMocks.updateStripeSubscription).not.toHaveBeenCalled();
    // Local entitlement must NOT diverge from Stripe.
    expect(repository.update).not.toHaveBeenCalled();
  });

  // The genuinely local-only path (no provider_subscription_id) may still change to a
  // plan without a Stripe price — there is no Stripe state to diverge from.
  it('changePlan proceeds local-only for a subscription with no provider_subscription_id', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...subscriptionRow,
      provider_subscription_id: null,
    } as never);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: null,
      stripe_price_yearly_id: null,
    } as never);

    await service.changePlan(scope, 'sub_public', { plan_id: 'plan_public' });
    expect(stripeMocks.updateStripeSubscription).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalled();
  });

  it('changePlan fails closed when Stripe price update fails — local plan unchanged', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...subscriptionRow,
      provider_subscription_id: 'sub_stripe',
    } as never);
    vi.mocked(planService.requireActivePlanByPublicId).mockResolvedValue({
      ...plan,
      stripe_price_monthly_id: 'price_new',
    } as never);
    stripeMocks.updateStripeSubscription.mockRejectedValueOnce(new Error('stripe update failed'));

    await expect(
      service.changePlan(scope, 'sub_public', { plan_id: 'plan_public' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(repository.update).not.toHaveBeenCalled();
  });
});
