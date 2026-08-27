import { describe, expect, it, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

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
    withPrincipalDatabaseContext: vi.fn(
      async (_scope: unknown, callback: (handle: unknown) => Promise<unknown>) =>
        callback({ tag: 'pinned-handle' }),
    ),
  };
});

import * as stripeWebhookOrganizationUtil from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook-organization.util.js';
import type { StripeWebhookEventRepository } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook-event.repository.js';

/**
 * Build a minimal `StripeWebhookEventRepository` stub that controls both
 * authoritative resolvers (audit #2): the subscription-id mapping and the
 * customer-id mapping. Used by the tests below to control resolver state
 * without touching Postgres.
 *
 * Architecturally the util takes a `repository` parameter (refactored away from
 * the raw `sql\`\`` it previously used) so the DB queries live on the
 * repository. The tests inject this stub via that parameter.
 */
function buildStripeWebhookEventRepositoryStub(resolved: {
  bySubscription?: string | undefined;
  byCustomer?: string | undefined;
}): StripeWebhookEventRepository {
  return {
    resolveOrganizationPublicIdByProviderSubscriptionId: vi
      .fn<(provider_subscription_id: string) => Promise<string | undefined>>()
      .mockResolvedValue(resolved.bySubscription),
    resolveOrganizationPublicIdByStripeCustomerId: vi
      .fn<(provider_customer_id: string) => Promise<string | undefined>>()
      .mockResolvedValue(resolved.byCustomer),
  } as unknown as StripeWebhookEventRepository;
}

function buildSubscriptionEvent(
  overrides: {
    type?: string;
    metadata?: Record<string, string>;
    customer?: string;
    subscriptionId?: string;
  } = {},
): Stripe.Event {
  return {
    id: 'evt_test',
    type: overrides.type ?? 'customer.subscription.updated',
    data: {
      object: {
        id: overrides.subscriptionId ?? 'sub_test',
        customer: overrides.customer,
        metadata: overrides.metadata ?? {},
      },
    },
  } as unknown as Stripe.Event;
}

describe('runStripeWebhookHandlerWithOrganizationContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when neither the subscription nor the customer maps to an organization', async () => {
    const repository = buildStripeWebhookEventRepositoryStub({
      bySubscription: undefined,
      byCustomer: undefined,
    });
    const handler = vi.fn();

    await expect(
      stripeWebhookOrganizationUtil.runStripeWebhookHandlerWithOrganizationContext(
        buildSubscriptionEvent({ customer: 'cus_unmapped' }),
        repository,
        handler,
      ),
    ).rejects.toThrow(/requires organization context/);
    expect(handler).not.toHaveBeenCalled();
  });

  // audit #2: metadata is the binding of last resort ONLY for a genuinely
  // first-contact subscription whose customer is also unknown locally (the
  // Dashboard-origin fallback-INSERT path). It is guarded downstream by the
  // subscriptions WITH CHECK (audit #41) against a non-existent org.
  it('falls back to metadata only when no subscription or customer mapping exists', async () => {
    const repository = buildStripeWebhookEventRepositoryStub({
      bySubscription: undefined,
      byCustomer: undefined,
    });
    const handler = vi.fn().mockResolvedValue('ok');

    await expect(
      stripeWebhookOrganizationUtil.runStripeWebhookHandlerWithOrganizationContext(
        buildSubscriptionEvent({
          type: 'customer.subscription.created',
          metadata: { organization_id: 'org_dashboard_origin' },
          customer: 'cus_unmapped',
        }),
        repository,
        handler,
      ),
    ).resolves.toBe('ok');
    expect(handler).toHaveBeenCalledWith({ tag: 'pinned-handle' });
  });

  // audit #2: the customer mapping OVERRIDES metadata — the realistic redirect
  // attack (Stripe-side write access setting metadata on an existing customer's
  // subscription) is rejected because the DB-resolved owner disagrees.
  it('rejects metadata that disagrees with an existing customer mapping (redirect attack)', async () => {
    const repository = buildStripeWebhookEventRepositoryStub({
      bySubscription: undefined,
      byCustomer: 'org_real_owner',
    });
    const handler = vi.fn();

    await expect(
      stripeWebhookOrganizationUtil.runStripeWebhookHandlerWithOrganizationContext(
        buildSubscriptionEvent({
          type: 'customer.subscription.created',
          metadata: { organization_id: 'org_victim' },
          customer: 'cus_real',
        }),
        repository,
        handler,
      ),
    ).rejects.toThrow(/mismatched organization metadata/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('throws when Stripe metadata disagrees with the stored subscription owner', async () => {
    const repository = buildStripeWebhookEventRepositoryStub({
      bySubscription: 'org_from_database',
    });
    const handler = vi.fn();

    await expect(
      stripeWebhookOrganizationUtil.runStripeWebhookHandlerWithOrganizationContext(
        buildSubscriptionEvent({ metadata: { organization_id: 'org_from_metadata' } }),
        repository,
        handler,
      ),
    ).rejects.toThrow(/mismatched organization metadata/);
    expect(handler).not.toHaveBeenCalled();
  });

  // audit #2: the customer mapping is the authoritative fallback for a created
  // event whose subscription id is not yet persisted locally.
  it('resolves via the customer mapping when the subscription id is not yet mapped', async () => {
    const repository = buildStripeWebhookEventRepositoryStub({
      bySubscription: undefined,
      byCustomer: 'org_from_customer',
    });
    const handler = vi.fn().mockResolvedValue('ok');

    await expect(
      stripeWebhookOrganizationUtil.runStripeWebhookHandlerWithOrganizationContext(
        buildSubscriptionEvent({
          type: 'customer.subscription.created',
          metadata: { organization_id: 'org_from_customer' },
          customer: 'cus_real',
        }),
        repository,
        handler,
      ),
    ).resolves.toBe('ok');
    expect(handler).toHaveBeenCalledWith({ tag: 'pinned-handle' });
  });

  it('prefers the subscription mapping over the customer mapping', async () => {
    const repository = buildStripeWebhookEventRepositoryStub({
      bySubscription: 'org_from_subscription',
      byCustomer: 'org_should_not_be_used',
    });
    const handler = vi.fn().mockResolvedValue('ok');

    await expect(
      stripeWebhookOrganizationUtil.runStripeWebhookHandlerWithOrganizationContext(
        buildSubscriptionEvent({ customer: 'cus_real' }),
        repository,
        handler,
      ),
    ).resolves.toBe('ok');
    // The customer resolver is skipped entirely once the subscription resolves.
    expect(repository.resolveOrganizationPublicIdByStripeCustomerId).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith({ tag: 'pinned-handle' });
  });

  it('returns undefined without invoking handler for unhandled events when organization is unresolved', async () => {
    const repository = buildStripeWebhookEventRepositoryStub({ bySubscription: undefined });
    const handler = vi.fn();

    const event = {
      id: 'evt_test',
      type: 'customer.updated',
      data: { object: {} },
    } as unknown as Stripe.Event;

    const result =
      await stripeWebhookOrganizationUtil.runStripeWebhookHandlerWithOrganizationContext(
        event,
        repository,
        handler,
      );
    expect(result).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(repository.resolveOrganizationPublicIdByProviderSubscriptionId).not.toHaveBeenCalled();
  });
});
