import { describe, it, expect, vi } from 'vitest';

// Stub the seat-sync producer queue so importing the service never opens Redis in unit tests.
const seatSyncMocks = vi.hoisted(() => ({ enqueueSubscriptionSeatSyncBestEffort: vi.fn() }));
vi.mock(
  '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.queue.js',
  () => seatSyncMocks,
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

// audit-#B4: run the create critical section transparently — the lock itself is covered in
// redis-lock.util.unit.test.ts; here it must not open a real Redis connection.
vi.mock('@/infrastructure/cache/redis-lock.util.js', () => ({
  withRedisLock: vi.fn(async (_options: unknown, fn: () => Promise<unknown>) => fn()),
  RedisLockUnavailableError: class RedisLockUnavailableError extends Error {},
}));

import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';
import { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { PlanService } from '@/domains/billing/sub-domains/plan/plan.service.js';
import type { SubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import type { PaymentProvider } from '@/domains/billing/sub-domains/subscription/payment-provider.port.js';

// A PERSONAL organization cannot manage billing; the subscription mutations must reject it
// with 422 via `assertTeamOrganization(organization, 'BILLING')` BEFORE any plan lookup, subscription
// lookup, or Stripe call (defense-in-depth for what the frontend already hides via the org `type`).
const personalOrganization = {
  id: 1,
  public_id: 'org_personal',
  name: 'Personal',
  slug: null,
  type: 'PERSONAL',
  stripe_customer_id: null,
};

function buildService() {
  const organizationService = {
    requireOrganizationByPublicId: vi.fn().mockResolvedValue(personalOrganization),
  } as unknown as OrganizationService;
  const planService = {
    requireActivePlanByPublicId: vi.fn(),
    requirePlanRecordByInternalId: vi.fn(),
  } as unknown as PlanService;
  const paymentProvider = {
    createSubscription: vi.fn(),
    updateSubscriptionPrice: vi.fn(),
    cancelSubscriptionAtPeriodEnd: vi.fn(),
    cancelSubscriptionImmediately: vi.fn(),
    resumeSubscription: vi.fn(),
    getProviderPriceId: vi.fn(),
  } as unknown as PaymentProvider;
  const repository = {
    findActiveByOrganization: vi.fn(),
    findByPublicId: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  } as unknown as SubscriptionRepository;
  const service = new SubscriptionService(
    organizationService,
    planService,
    repository,
    paymentProvider,
  );
  return { service, planService, paymentProvider, repository };
}

const BILLING_REJECTION = {
  statusCode: 422,
  messageKey: 'errors:personalOrganizationNoBilling',
};

const personalScope = createPrincipalDatabaseScope({
  userPublicId: 'user_public',
  organizationPublicId: 'org_personal',
  source: 'token',
}) as OrganizationPrincipalDatabaseScope;

describe('SubscriptionService — personal-org billing guard', () => {
  it('create rejects a PERSONAL organization with 422 before any plan lookup or Stripe call', async () => {
    const { service, planService, paymentProvider, repository } = buildService();
    await expect(
      service.create(
        personalScope,
        { plan_id: 'pln_test', billing_cycle: 'monthly' },
        'creator_public',
        'idem-personal-billing-key',
      ),
    ).rejects.toMatchObject(BILLING_REJECTION);
    expect(vi.mocked(repository.findActiveByOrganization)).not.toHaveBeenCalled();
    expect(vi.mocked(planService.requireActivePlanByPublicId)).not.toHaveBeenCalled();
    expect(vi.mocked(paymentProvider.createSubscription)).not.toHaveBeenCalled();
  });

  it('changePlan rejects a PERSONAL organization with 422 before the subscription lookup', async () => {
    const { service, repository } = buildService();
    await expect(
      service.changePlan(personalScope, 'sub_x', { plan_id: 'pln_test' }, 'idem-key'),
    ).rejects.toMatchObject(BILLING_REJECTION);
    expect(vi.mocked(repository.findByPublicId)).not.toHaveBeenCalled();
  });

  it('cancel rejects a PERSONAL organization with 422 before the subscription lookup', async () => {
    const { service, repository } = buildService();
    await expect(service.cancel(personalScope, 'sub_x', 'idem-key')).rejects.toMatchObject(
      BILLING_REJECTION,
    );
    expect(vi.mocked(repository.findByPublicId)).not.toHaveBeenCalled();
  });

  it('resume rejects a PERSONAL organization with 422 before the subscription lookup', async () => {
    const { service, repository } = buildService();
    await expect(service.resume(personalScope, 'sub_x', 'idem-key')).rejects.toMatchObject(
      BILLING_REJECTION,
    );
    expect(vi.mocked(repository.findByPublicId)).not.toHaveBeenCalled();
  });
});
