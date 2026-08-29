import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The billing-account read paths — `listInvoices`, `listPaymentMethods`,
 * `createPaymentMethodSetup`, and `getPaymentSetup` — were the largest no-coverage cluster in
 * the mutation run (99 uncovered mutants): proven at HTTP by the integration suite, which
 * Stryker's unit surface never runs. These cases pin the unit-level decisions: the fail-open
 * empty page for reads vs the fail-closed 422 for the setup write, the cursor arithmetic, and
 * exactly which Stripe calls each arm may make.
 */

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Blanket maintenance passthrough: services this suite touches (directly or via
    // cross-domain imports) may enter maintenance contexts (tombstoning, admin reads) —
    // the real wrapper opens a database.transaction() and CI's unit lane has no Postgres.
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
    withAppDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

const stripeMocks = vi.hoisted(() => ({
  isStripeConfigured: vi.fn(() => false),
  createStripeSetupIntent: vi.fn().mockResolvedValue('seti_secret_123'),
  listStripeInvoices: vi.fn(),
  listStripePaymentMethods: vi.fn().mockResolvedValue([]),
  retrieveStripeCustomerDefaultPaymentMethodId: vi.fn().mockResolvedValue(null),
  retrieveStripeSubscriptionPaymentClientSecret: vi.fn().mockResolvedValue('pi_secret_456'),
}));
vi.mock('@/infrastructure/payment/stripe.client.js', () => stripeMocks);

import { NotFoundError, UnprocessableEntityError } from '@/shared/errors/index.js';
import {
  PRINCIPAL_SCOPE,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { SubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import { PAGINATION } from '@/shared/constants/pagination.constants.js';

const TEAM_ORGANIZATION = { id: 1, public_id: 'org_public', type: 'TEAM', name: 'Org' };
const ACTIVE_SUBSCRIPTION_ROW = { id: 11, provider_customer_id: 'cus_live' };

function buildService(overrides: { activeSubscription?: unknown; byPublicId?: unknown }) {
  const organizationService = {
    requireOrganizationByPublicId: vi.fn().mockResolvedValue(TEAM_ORGANIZATION),
  } as unknown as OrganizationService;
  const repository = {
    findActiveByOrganization: vi
      .fn()
      .mockResolvedValue(
        'activeSubscription' in overrides ? overrides.activeSubscription : ACTIVE_SUBSCRIPTION_ROW,
      ),
    findByPublicId: vi
      .fn()
      .mockResolvedValue('byPublicId' in overrides ? overrides.byPublicId : null),
  } as unknown as SubscriptionRepository;
  const service = new SubscriptionService(
    organizationService,
    {} as never,
    repository,
    {} as never,
  );
  return { service, repository };
}

function stripeInvoice(id: string) {
  return {
    id,
    status: 'paid',
    currency: 'usd',
    amount_due: 900,
    amount_paid: 900,
    created: 1_700_000_000,
    hosted_invoice_url: `https://stripe.example/${id}`,
    invoice_pdf: null,
    number: id.toUpperCase(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stripeMocks.isStripeConfigured.mockReturnValue(false);
  stripeMocks.createStripeSetupIntent.mockResolvedValue('seti_secret_123');
  stripeMocks.listStripePaymentMethods.mockResolvedValue([]);
  stripeMocks.retrieveStripeCustomerDefaultPaymentMethodId.mockResolvedValue(null);
  stripeMocks.retrieveStripeSubscriptionPaymentClientSecret.mockResolvedValue('pi_secret_456');
});

const scope = PRINCIPAL_SCOPE.REQUEST({
  userPublicId: 'user_public',
  organizationPublicId: 'org_public',
}) as OrganizationPrincipalDatabaseScope;

describe('SubscriptionService.listInvoices — fail-open read', () => {
  it('returns the empty page with the DEFAULT limit when Stripe is unconfigured, without calling Stripe', async () => {
    const { service } = buildService({});

    const page = await service.listInvoices(scope, {});

    expect(page).toEqual({
      items: [],
      total: null,
      limit: PAGINATION.DEFAULT_LIMIT,
      has_more: false,
      next_cursor: null,
    });
    expect(stripeMocks.listStripeInvoices).not.toHaveBeenCalled();
  });

  it('returns the empty page when the organization has no provider customer, EVEN with Stripe configured', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    const { service } = buildService({ activeSubscription: null });

    const page = await service.listInvoices(scope, { limit: 5 });

    expect(page.items).toEqual([]);
    expect(page.limit).toBe(5);
    expect(stripeMocks.listStripeInvoices).not.toHaveBeenCalled();
  });

  it('forwards limit + after as the Stripe cursor and mints next_cursor from the LAST item when more remain', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    stripeMocks.listStripeInvoices.mockResolvedValue({
      data: [stripeInvoice('in_a'), stripeInvoice('in_b')],
      has_more: true,
    });
    const { service } = buildService({});

    const page = await service.listInvoices(scope, { limit: 2, after: 'in_prev' });

    expect(stripeMocks.listStripeInvoices).toHaveBeenCalledWith('cus_live', {
      limit: 2,
      startingAfter: 'in_prev',
    });
    expect(page.items.map((invoice) => invoice.id)).toEqual(['in_a', 'in_b']);
    expect(page.has_more).toBe(true);
    // The cursor is the last SERIALIZED item's id — dropping `.at(-1)` or the ternary breaks paging.
    expect(page.next_cursor).toBe('in_b');
  });

  it('clears next_cursor on the final page even though items exist', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    stripeMocks.listStripeInvoices.mockResolvedValue({
      data: [stripeInvoice('in_last')],
      has_more: false,
    });
    const { service } = buildService({});

    const page = await service.listInvoices(scope, { limit: 2 });

    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeNull();
  });
});

describe('SubscriptionService.listPaymentMethods — fail-open read', () => {
  it('returns [] when Stripe is unconfigured, without calling Stripe', async () => {
    const { service } = buildService({});

    await expect(service.listPaymentMethods(scope)).resolves.toEqual([]);
    expect(stripeMocks.listStripePaymentMethods).not.toHaveBeenCalled();
  });

  it('marks exactly the customer default card as is_default', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    stripeMocks.listStripePaymentMethods.mockResolvedValue([
      {
        id: 'pm_a',
        type: 'card',
        card: { brand: 'visa', last4: '4242', exp_month: 1, exp_year: 2030 },
      },
      {
        id: 'pm_b',
        type: 'card',
        card: { brand: 'amex', last4: '0005', exp_month: 2, exp_year: 2031 },
      },
    ]);
    stripeMocks.retrieveStripeCustomerDefaultPaymentMethodId.mockResolvedValue('pm_b');
    const { service } = buildService({});

    const methods = (await service.listPaymentMethods(scope)) as Array<{
      id: string;
      is_default: boolean;
    }>;

    expect(methods.map((method) => [method.id, method.is_default])).toEqual([
      ['pm_a', false],
      ['pm_b', true],
    ]);
  });
});

describe('SubscriptionService.createPaymentMethodSetup — fail-closed write', () => {
  it('refuses with 422 when the organization has no provider customer (nothing to attach a card to)', async () => {
    const { service } = buildService({ activeSubscription: null });

    await expect(service.createPaymentMethodSetup(scope)).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
    expect(stripeMocks.createStripeSetupIntent).not.toHaveBeenCalled();
  });

  it('degrades to a null client_secret when Stripe is unconfigured, without calling Stripe', async () => {
    const { service } = buildService({});

    await expect(service.createPaymentMethodSetup(scope)).resolves.toEqual({
      client_secret: null,
    });
    expect(stripeMocks.createStripeSetupIntent).not.toHaveBeenCalled();
  });

  it('creates the SetupIntent with a namespaced Stripe idempotency key derived from the client key', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    const { service } = buildService({});

    const result = await service.createPaymentMethodSetup(scope, 'client-key-1');

    const [customerId, options] = stripeMocks.createStripeSetupIntent.mock.calls[0] as [
      string,
      { idempotencyKey?: string },
    ];
    expect(customerId).toBe('cus_live');
    // pm-setup namespace + organization + client key — a raw client key forwarded verbatim could collide
    // with the same key used on a different Stripe mutation.
    expect(options.idempotencyKey).toContain('pm-setup');
    expect(options.idempotencyKey).toContain('client-key-1');
    expect(result).toEqual({ client_secret: 'seti_secret_123' });
  });

  it('omits the Stripe idempotency key entirely when the client sent none', async () => {
    stripeMocks.isStripeConfigured.mockReturnValue(true);
    const { service } = buildService({});

    await service.createPaymentMethodSetup(scope);

    const options = stripeMocks.createStripeSetupIntent.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect('idempotencyKey' in options).toBe(false);
  });
});

describe('SubscriptionService.getPaymentSetup', () => {
  it('404s for an unknown subscription id', async () => {
    const { service } = buildService({ byPublicId: null });

    await expect(service.getPaymentSetup(scope, 'sub_missing')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('returns a null client_secret for a non-INCOMPLETE subscription without touching Stripe', async () => {
    const { service } = buildService({
      byPublicId: { status: 'ACTIVE', provider_subscription_id: 'sub_live' },
    });
    stripeMocks.isStripeConfigured.mockReturnValue(true);

    await expect(service.getPaymentSetup(scope, 'sub_x')).resolves.toEqual({
      client_secret: null,
    });
    expect(stripeMocks.retrieveStripeSubscriptionPaymentClientSecret).not.toHaveBeenCalled();
  });

  it('returns a null client_secret for an INCOMPLETE local-only subscription (no provider id)', async () => {
    const { service } = buildService({
      byPublicId: { status: 'INCOMPLETE', provider_subscription_id: null },
    });
    stripeMocks.isStripeConfigured.mockReturnValue(true);

    await expect(service.getPaymentSetup(scope, 'sub_x')).resolves.toEqual({
      client_secret: null,
    });
  });

  it('retrieves the payment client_secret for an INCOMPLETE Stripe-backed subscription', async () => {
    const { service } = buildService({
      byPublicId: { status: 'INCOMPLETE', provider_subscription_id: 'sub_live' },
    });
    stripeMocks.isStripeConfigured.mockReturnValue(true);

    await expect(service.getPaymentSetup(scope, 'sub_x')).resolves.toEqual({
      client_secret: 'pi_secret_456',
    });
    expect(stripeMocks.retrieveStripeSubscriptionPaymentClientSecret).toHaveBeenCalledWith(
      'sub_live',
    );
  });
});
