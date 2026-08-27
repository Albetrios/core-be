import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { PlanService } from '@/domains/billing/sub-domains/plan/plan.service.js';
import type { SubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import type { PaymentProvider } from '@/domains/billing/sub-domains/subscription/payment-provider.port.js';

// REQ-4: stub the seat-sync producer queue so changePlan's best-effort enqueue never opens Redis.
vi.mock(
  '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.queue.js',
  () => ({
    enqueueSubscriptionSeatSyncBestEffort: vi.fn(),
  }),
);

// audit-#B4: run the create critical section transparently — the lock itself is covered in
// redis-lock.util.unit.test.ts; here it must not open a real Redis connection.
vi.mock('@/infrastructure/cache/redis-lock.util.js', () => ({
  withRedisLock: vi.fn(async (_options: unknown, fn: () => Promise<unknown>) => fn()),
  RedisLockUnavailableError: class RedisLockUnavailableError extends Error {},
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withPrincipalDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

/**
 * Regression for sec-B1 + sec-B2 + sec-B3 + sec-B4 (High×4): Stripe reconciliation gaps.
 *
 * - **sec-B1:** PATCH `cancel_at_period_end` previously bypassed Stripe entirely. The DTO
 *   now rejects that field, so clients must use the dedicated `/cancel` and `/resume`
 *   routes (both of which DO call Stripe). Empty PATCH bodies stay valid and are no-ops.
 *
 * - **sec-B2 (partial):** `create()` previously left `last_stripe_event_created_at` NULL.
 *   A late-arriving `customer.subscription.created` webhook would pass the watermark
 *   guard (`isNull OR lt`) and could clobber the row. Now `create()` bumps the watermark
 *   so a stale .created event is filtered.
 *
 * - **sec-B3:** every HTTP mutation (`update`, `cancel`, `resume`, `changePlan`) now bumps
 *   `last_stripe_event_created_at`. Without this, an old Stripe `updated` event delivered
 *   after the HTTP mutation could regress the row state (e.g. re-enable an HTTP-cancelled
 *   subscription).
 *
 * - **sec-B4:** `resume()` no longer force-writes `status: 'ACTIVE'`. The Stripe webhook is
 *   the source of truth for status; the local row is updated only on the `cancel_at_period_end
 *   = false` toggle, and the upcoming webhook reconciles the actual status (which may be
 *   PAST_DUE / INCOMPLETE / etc.).
 */
const scope = createPrincipalDatabaseScope({
  userPublicId: 'user_public',
  organizationPublicId: 'org_public',
  source: 'token',
}) as OrganizationPrincipalDatabaseScope;

describe('SubscriptionService — Stripe reconciliation (sec-B1+B2+B3+B4)', () => {
  const organization = { id: 1, public_id: 'org_public' };
  const plan = {
    id: 5,
    public_id: 'plan_pro',
    name: 'Pro',
    features: {},
    is_active: true,
    metadata: {},
    stripe_price_id_monthly: 'price_mo',
    stripe_price_id_yearly: 'price_yr',
  };
  const subscription = {
    id: 9,
    public_id: 'sub_public',
    organization_id: organization.id,
    plan_id: plan.id,
    billing_cycle: 'MONTHLY' as const,
    status: 'ACTIVE',
    current_period_start: new Date('2026-06-01T00:00:00Z'),
    current_period_end: new Date('2026-07-01T00:00:00Z'),
    cancel_at_period_end: false,
    last_stripe_event_created_at: null,
    provider: 'stripe',
    provider_subscription_id: 'sub_xxx',
    provider_customer_id: 'cus_xxx',
  };

  const organizationService = {
    requireOrganizationByPublicId: vi.fn().mockResolvedValue(organization),
    resolveUserInternalIdByPublicId: vi.fn().mockResolvedValue(7),
  } as unknown as OrganizationService;

  const planService = {
    requireActivePlanByPublicId: vi.fn().mockResolvedValue(plan),
    requirePlanRecordByInternalId: vi.fn().mockResolvedValue(plan),
  } as unknown as PlanService;

  const repository = {
    findActiveByOrganization: vi.fn().mockResolvedValue(null),
    findByPublicId: vi.fn().mockResolvedValue(subscription),
    create: vi.fn().mockResolvedValue(subscription),
    update: vi.fn().mockResolvedValue(subscription),
  } as unknown as SubscriptionRepository;

  const paymentProvider = {
    isConfigured: vi.fn().mockReturnValue(true),
    getProviderPriceId: vi.fn().mockReturnValue('price_mo'),
    createSubscription: vi.fn().mockResolvedValue({
      providerSubscriptionId: 'sub_xxx',
      providerCustomerId: 'cus_xxx',
    }),
    cancelSubscriptionAtPeriodEnd: vi.fn().mockResolvedValue(undefined),
    resumeSubscription: vi.fn().mockResolvedValue(undefined),
    updateSubscriptionPrice: vi.fn().mockResolvedValue(undefined),
    compensateFailedCreate: vi.fn().mockResolvedValue(undefined),
    compensatePlanChange: vi.fn().mockResolvedValue(undefined),
  } as unknown as PaymentProvider;

  const service = new SubscriptionService(
    organizationService,
    planService,
    repository,
    paymentProvider,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(repository.findActiveByOrganization).mockResolvedValue(null);
    vi.mocked(repository.findByPublicId).mockResolvedValue(subscription as never);
    vi.mocked(repository.create).mockResolvedValue(subscription as never);
    vi.mocked(repository.update).mockResolvedValue(subscription as never);
    vi.mocked(paymentProvider.createSubscription).mockResolvedValue({
      providerSubscriptionId: 'sub_xxx',
      providerCustomerId: 'cus_xxx',
    });
  });

  // ── sec-B1 ──────────────────────────────────────────────────────────────────────────
  it('PATCH rejects cancel_at_period_end so clients must use /cancel and /resume (sec-B1)', async () => {
    await expect(
      service.update(scope, 'sub_public', { cancel_at_period_end: true }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(repository.update).not.toHaveBeenCalled();
    // Stripe is not called for the rejected PATCH either — the request never reaches the
    // provider, so the subscription cannot diverge silently.
    expect(paymentProvider.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
  });

  it('PATCH with empty body succeeds as a no-op (idempotent shape preserved)', async () => {
    await expect(service.update(scope, 'sub_public', {})).resolves.toBeDefined();
  });

  // ── sec-B2 ──────────────────────────────────────────────────────────────────────────
  it('create() stamps last_stripe_event_created_at so late Stripe events cannot clobber (sec-B2)', async () => {
    await service.create(scope, { plan_id: 'plan_pro', billing_cycle: 'monthly' }, 'created_by');

    expect(repository.create).toHaveBeenCalledTimes(1);
    const createPayload = vi.mocked(repository.create).mock.calls[0]![0];
    expect(createPayload.last_stripe_event_created_at).toBeInstanceOf(Date);
  });

  it('create() does NOT stamp the watermark when Stripe is not configured (local-only flow)', async () => {
    vi.mocked(paymentProvider.createSubscription).mockResolvedValueOnce({});
    await service.create(scope, { plan_id: 'plan_pro', billing_cycle: 'monthly' }, 'created_by');
    const createPayload = vi.mocked(repository.create).mock.calls[0]![0];
    expect(createPayload.last_stripe_event_created_at).toBeUndefined();
  });

  // ── sec-B3 ──────────────────────────────────────────────────────────────────────────
  it('cancel() bumps last_stripe_event_created_at on the local update (sec-B3)', async () => {
    await service.cancel(scope, 'sub_public');
    const updatePayload = vi.mocked(repository.update).mock.calls[0]![2];
    expect(updatePayload.last_stripe_event_created_at).toBeInstanceOf(Date);
  });

  it('resume() bumps last_stripe_event_created_at on the local update (sec-B3)', async () => {
    await service.resume(scope, 'sub_public');
    const updatePayload = vi.mocked(repository.update).mock.calls[0]![2];
    expect(updatePayload.last_stripe_event_created_at).toBeInstanceOf(Date);
  });

  it('changePlan() bumps last_stripe_event_created_at on the local update (sec-B3)', async () => {
    await service.changePlan(scope, 'sub_public', { plan_id: 'plan_pro' });
    const updatePayload = vi.mocked(repository.update).mock.calls[0]![2];
    expect(updatePayload.last_stripe_event_created_at).toBeInstanceOf(Date);
  });

  // ── sec-B4 ──────────────────────────────────────────────────────────────────────────
  it('resume() does NOT force-write status=ACTIVE; lets the Stripe webhook reconcile (sec-B4)', async () => {
    await service.resume(scope, 'sub_public');
    const updatePayload = vi.mocked(repository.update).mock.calls[0]![2];
    expect(updatePayload.cancel_at_period_end).toBe(false);
    expect(updatePayload.status).toBeUndefined();
  });
});
