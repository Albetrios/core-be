import type { OrganizationBillingContext } from '@/domains/tenancy/sub-domains/organization/organization.types.js';
import type { PlanRecord } from '@/domains/billing/sub-domains/plan/plan.service.js';

/**
 * Identifiers returned by {@link PaymentProvider.createSubscription}; either
 * field may be omitted when the provider is unconfigured (no-op stub) so
 * persistence stays optional.
 */
export type PaymentProviderCreateResult = {
  providerSubscriptionId?: string;
  providerCustomerId?: string;
};

/**
 * Port for external payment provider subscription lifecycle (Stripe today; others later).
 */
export interface PaymentProvider {
  isConfigured(): boolean;

  getProviderPriceId(plan: PlanRecord, billingCycle: 'monthly' | 'yearly'): string | null;

  createSubscription(input: {
    organization: OrganizationBillingContext;
    plan: PlanRecord;
    billingCycle: 'monthly' | 'yearly';
    trialEnd?: string;
    idempotencyKey?: string;
  }): Promise<PaymentProviderCreateResult>;

  cancelSubscriptionAtPeriodEnd(
    providerSubscriptionId: string,
    idempotencyKey?: string,
  ): Promise<void>;

  /**
   * Cancels the subscription immediately (reaudit-#6). Used for never-activated `INCOMPLETE`
   * subscriptions where `cancel_at_period_end` is a no-op — the organization needs the slot freed now.
   */
  cancelSubscriptionImmediately(
    providerSubscriptionId: string,
    idempotencyKey?: string,
  ): Promise<void>;

  resumeSubscription(providerSubscriptionId: string, idempotencyKey?: string): Promise<void>;

  updateSubscriptionPrice(
    providerSubscriptionId: string,
    providerPriceId: string,
    idempotencyKey?: string,
  ): Promise<void>;

  /**
   * Sets the purchased seat quantity on the subscription (REQ-4). Synced out-of-band from the
   * organization's member count by the seat-quantity-sync worker; idempotent via `idempotencyKey`.
   */
  updateSubscriptionQuantity(
    providerSubscriptionId: string,
    quantity: number,
    idempotencyKey?: string,
  ): Promise<void>;

  compensateFailedCreate(providerSubscriptionId: string): Promise<void>;

  compensatePlanChange(
    providerSubscriptionId: string,
    previousProviderPriceId: string,
  ): Promise<void>;
}
