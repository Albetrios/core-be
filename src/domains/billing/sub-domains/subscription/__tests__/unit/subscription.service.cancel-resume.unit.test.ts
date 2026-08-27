import { describe, it, expect, vi, beforeEach } from 'vitest';

// REQ-4: stub the seat-sync producer queue so changePlan's best-effort enqueue never opens Redis.
vi.mock(
  '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.queue.js',
  () => ({
    enqueueSubscriptionSeatSyncBestEffort: vi.fn(),
  }),
);

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withPrincipalDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

import { NotFoundError, UnprocessableEntityError } from '@/shared/errors/index.js';
import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { PlanService } from '@/domains/billing/sub-domains/plan/plan.service.js';
import type { SubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import type { PaymentProvider } from '@/domains/billing/sub-domains/subscription/payment-provider.port.js';

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
const baseSubscriptionRow = {
  id: 3,
  public_id: 'sub_public',
  organization_id: 1,
  plan_id: 2,
  billing_cycle: 'MONTHLY' as const,
  status: 'ACTIVE' as const,
  cancel_at_period_end: false,
  current_period_start: new Date('2026-05-01T00:00:00.000Z'),
  current_period_end: new Date('2026-06-01T00:00:00.000Z'),
  provider: 'stripe' as const,
  provider_subscription_id: 'sub_provider',
};

function buildService() {
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
    listByOrganization: vi.fn().mockResolvedValue([]),
    findByPublicId: vi.fn().mockResolvedValue(baseSubscriptionRow),
    findActiveByOrganization: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(baseSubscriptionRow),
    update: vi.fn().mockResolvedValue({ ...baseSubscriptionRow, cancel_at_period_end: true }),
    syncFromStripeProviderSubscription: vi.fn(),
    markCanceledByProviderSubscriptionId: vi.fn(),
  } as unknown as SubscriptionRepository;

  const paymentProvider = {
    isConfigured: vi.fn().mockReturnValue(true),
    getProviderPriceId: vi.fn().mockReturnValue('price_provider'),
    createSubscription: vi.fn().mockResolvedValue({ providerSubscriptionId: 'sub_provider' }),
    cancelSubscriptionAtPeriodEnd: vi.fn().mockResolvedValue(undefined),
    cancelSubscriptionImmediately: vi.fn().mockResolvedValue(undefined),
    resumeSubscription: vi.fn().mockResolvedValue(undefined),
    updateSubscriptionPrice: vi.fn().mockResolvedValue(undefined),
    updateSubscriptionQuantity: vi.fn().mockResolvedValue(undefined),
    compensateFailedCreate: vi.fn().mockResolvedValue(undefined),
    compensatePlanChange: vi.fn().mockResolvedValue(undefined),
  } satisfies PaymentProvider;

  const service = new SubscriptionService(
    organizationService,
    planService,
    repository,
    paymentProvider,
  );

  return { service, organizationService, planService, repository, paymentProvider };
}

const scope = createPrincipalDatabaseScope({
  userPublicId: 'user_public',
  organizationPublicId: 'org_public',
  source: 'token',
}) as OrganizationPrincipalDatabaseScope;

describe('SubscriptionService cancel / resume / changePlan guards', () => {
  let context: ReturnType<typeof buildService>;

  beforeEach(() => {
    context = buildService();
  });

  it('cancel still calls Stripe and persists when subscription has provider id', async () => {
    const { service, repository, paymentProvider } = context;

    await service.cancel(scope, 'sub_public');

    expect(paymentProvider.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledWith(
      'sub_provider',
      undefined,
    );
    expect(repository.update).toHaveBeenCalledWith(
      'sub_public',
      organization.id,
      expect.objectContaining({ cancel_at_period_end: true }),
    );
  });

  it('reaudit-#6: cancel on an INCOMPLETE subscription cancels immediately and frees the slot', async () => {
    const { service, repository, paymentProvider } = context;
    vi.mocked(repository.findByPublicId).mockResolvedValueOnce({
      ...baseSubscriptionRow,
      status: 'INCOMPLETE',
    } as never);
    vi.mocked(repository.update).mockResolvedValueOnce({
      ...baseSubscriptionRow,
      status: 'CANCELED',
    } as never);

    await service.cancel(scope, 'sub_public');

    // Immediate Stripe cancel (not at-period-end, which is a no-op on an incomplete sub)...
    expect(paymentProvider.cancelSubscriptionImmediately).toHaveBeenCalledWith(
      'sub_provider',
      undefined,
    );
    expect(paymentProvider.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
    // ...and the local row is set CANCELED, which releases the per-org subscription slot.
    expect(repository.update).toHaveBeenCalledWith(
      'sub_public',
      organization.id,
      expect.objectContaining({ status: 'CANCELED' }),
    );
  });

  it('cancel throws NotFoundError when subscription is missing (no Stripe call)', async () => {
    const { service, repository, paymentProvider } = context;
    vi.mocked(repository.findByPublicId).mockResolvedValueOnce(null);

    await expect(service.cancel(scope, 'sub_public')).rejects.toBeInstanceOf(NotFoundError);
    expect(paymentProvider.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('route-audit-#2: cancelActiveForOrganizationOffboarding cancels the active sub immediately', async () => {
    const { service, repository, paymentProvider } = context;
    vi.mocked(repository.findActiveByOrganization).mockResolvedValueOnce({
      ...baseSubscriptionRow,
      status: 'ACTIVE',
    } as never);

    await service.cancelActiveForOrganizationOffboarding('org_public');

    // Immediate Stripe cancel (org is going away — stop billing now, not at period end)
    // with a deterministic idempotency key so an org-delete retry dedups (audit L1).
    expect(paymentProvider.cancelSubscriptionImmediately).toHaveBeenCalledWith(
      'sub_provider',
      'sub-cancel-offboarding:org_public:sub_provider',
    );
    expect(paymentProvider.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
    // ...and the local row is set CANCELED.
    expect(repository.update).toHaveBeenCalledWith(
      'sub_public',
      organization.id,
      expect.objectContaining({ status: 'CANCELED' }),
    );
  });

  it('route-audit-#2: cancelActiveForOrganizationOffboarding is a no-op when no active subscription', async () => {
    const { service, repository, paymentProvider } = context;
    vi.mocked(repository.findActiveByOrganization).mockResolvedValueOnce(null);

    await service.cancelActiveForOrganizationOffboarding('org_public');

    expect(paymentProvider.cancelSubscriptionImmediately).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('resume calls Stripe and clears cancel_at_period_end without force-writing status (sec-B4)', async () => {
    const { service, repository, paymentProvider } = context;

    await service.resume(scope, 'sub_public');

    expect(paymentProvider.resumeSubscription).toHaveBeenCalledWith('sub_provider', undefined);
    expect(repository.update).toHaveBeenCalledWith(
      'sub_public',
      organization.id,
      expect.objectContaining({ cancel_at_period_end: false }),
    );
    // sec-B4: status is no longer force-written; the Stripe webhook reconciles it.
    // sec-B3: HTTP mutations stamp the watermark so a stale Stripe event cannot regress.
    const updatePayload = vi.mocked(repository.update).mock.calls[0]![2];
    expect(updatePayload.status).toBeUndefined();
    expect(updatePayload.last_stripe_event_created_at).toBeInstanceOf(Date);
  });

  it('changePlan does not call paymentProvider when subscription has no provider id', async () => {
    const { service, repository, paymentProvider } = context;
    vi.mocked(repository.findByPublicId).mockResolvedValueOnce({
      ...baseSubscriptionRow,
      provider_subscription_id: null,
    } as never);

    await service.changePlan(scope, 'sub_public', { plan_id: 'plan_public' });

    expect(paymentProvider.updateSubscriptionPrice).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalled();
  });

  // sec-new-B1: terminal-status guard prevents Stripe calls on CANCELED / INCOMPLETE_EXPIRED
  it.each([['CANCELED'], ['INCOMPLETE_EXPIRED']] as const)(
    'cancel throws UnprocessableEntityError for terminal status %s (sec-new-B1)',
    async (terminalStatus) => {
      const { service, repository, paymentProvider } = context;
      vi.mocked(repository.findByPublicId).mockResolvedValueOnce({
        ...baseSubscriptionRow,
        status: terminalStatus,
      } as never);

      await expect(service.cancel(scope, 'sub_public')).rejects.toBeInstanceOf(
        UnprocessableEntityError,
      );
      expect(paymentProvider.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    },
  );

  it.each([['CANCELED'], ['INCOMPLETE_EXPIRED']] as const)(
    'resume throws UnprocessableEntityError for terminal status %s (sec-new-B1)',
    async (terminalStatus) => {
      const { service, repository, paymentProvider } = context;
      vi.mocked(repository.findByPublicId).mockResolvedValueOnce({
        ...baseSubscriptionRow,
        status: terminalStatus,
      } as never);

      await expect(service.resume(scope, 'sub_public')).rejects.toBeInstanceOf(
        UnprocessableEntityError,
      );
      expect(paymentProvider.resumeSubscription).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    },
  );

  it.each([['CANCELED'], ['INCOMPLETE_EXPIRED']] as const)(
    'changePlan throws UnprocessableEntityError for terminal status %s (sec-new-B1)',
    async (terminalStatus) => {
      const { service, repository, paymentProvider } = context;
      vi.mocked(repository.findByPublicId).mockResolvedValueOnce({
        ...baseSubscriptionRow,
        status: terminalStatus,
      } as never);

      await expect(
        service.changePlan(scope, 'sub_public', { plan_id: 'plan_public' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityError);
      expect(paymentProvider.updateSubscriptionPrice).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    },
  );
});
