import type { OrganizationBillingContext } from '@/domains/tenancy/sub-domains/organization/organization.types.js';
import type { PlanRecord } from '@/domains/billing/sub-domains/plan/plan.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { PaymentProvider, PaymentProviderCreateResult } from './payment-provider.port.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import {
  isStripeConfigured,
  createStripeCustomer,
  createStripeSubscription,
  cancelStripeSubscription,
  resumeStripeSubscription,
  updateStripeSubscription,
  updateStripeSubscriptionQuantity,
} from '@/infrastructure/payment/stripe.client.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { ConfigurationError, ServiceUnavailableError } from '@/shared/errors/index.js';
import { env } from '@/shared/config/env.config.js';

/**
 * Builds the Stripe customer email address from the platform's outbound
 * transactional mail domain.
 *
 * @remarks
 * sec-B11: the previous implementation interpolated the tenant-controlled
 * `organization.slug` directly: `billing@${slug}.com`. An organization with
 * slug `google` would be registered with Stripe as `billing@google.com`, and
 * every Stripe-originated email (receipts, dunning, dispute notifications)
 * would land at that external domain. The result is bounced mail, deliverability
 * damage on the legitimate domain, and third-party complaints to AWS / Stripe.
 *
 * Switch to a per-organization plus-addressed mailbox on a domain we own.
 * The domain is derived from `EMAIL_FROM_ADDRESS` (the same address auth /
 * notification mail comes from), so an operator that sets up Stripe MUST
 * already have a verified outbound sender — no new env variable is required.
 * The organization public id is embedded so admin tooling can map a stuck Stripe email
 * back to a local organization at a glance.
 *
 * sec-B finding #19: the prior fallback to a `*@invalid` literal silently
 * accepted a misconfigured environment — Stripe receipts, dunning, and refund
 * notifications would land on a reserved-TLD address (RFC 6761) and bounce
 * permanently. The cross-field env-schema refine (Stripe ⇒ `EMAIL_FROM_ADDRESS`)
 * is the canonical guard; this throw is the boot-time-late fallback so a future
 * loosening of the refine still fails closed rather than silently fanning
 * `@invalid` customers into Stripe.
 */
function buildStripeCustomerEmail(organizationPublicId: string): string {
  const fromAddress = env.EMAIL_FROM_ADDRESS;
  if (!fromAddress) {
    throw new ConfigurationError(
      'EMAIL_FROM_ADDRESS must be configured before creating Stripe customers — otherwise ' +
        'Stripe receipts/dunning land on an unowned domain.',
    );
  }
  const atIndex = fromAddress.lastIndexOf('@');
  if (atIndex < 0) {
    throw new ConfigurationError(
      `EMAIL_FROM_ADDRESS=${fromAddress} is not a valid email — cannot derive Stripe customer domain.`,
    );
  }
  return `billing+${organizationPublicId}@${fromAddress.slice(atIndex + 1)}`;
}

/**
 * Stripe implementation of {@link PaymentProvider}.
 *
 * @remarks
 * Mutation paths (`createSubscription`, `cancelSubscriptionAtPeriodEnd`,
 * `resumeSubscription`, `updateSubscriptionPrice`) are **fail-closed**: a Stripe
 * API failure is logged and re-surfaced as a {@link ServiceUnavailableError} so
 * the caller never persists local billing state for a provider mutation that did
 * not succeed. Compensation
 * helpers (`compensateFailedCreate`, `compensatePlanChange`) intentionally swallow
 * their own errors because they run on an already-failing path where the
 * Stripe webhook remains the reconciliation source of truth.
 */
export class StripePaymentProvider implements PaymentProvider {
  constructor(private readonly organizationService: OrganizationService) {}

  isConfigured(): boolean {
    return isStripeConfigured();
  }

  getProviderPriceId(plan: PlanRecord, billingCycle: 'monthly' | 'yearly'): string | null {
    const priceId =
      billingCycle === 'yearly' ? plan.stripe_price_yearly_id : plan.stripe_price_monthly_id;
    return priceId ?? null;
  }

  async createSubscription(input: {
    organization: OrganizationBillingContext;
    plan: PlanRecord;
    billingCycle: 'monthly' | 'yearly';
    trialEnd?: string;
    idempotencyKey?: string;
  }): Promise<PaymentProviderCreateResult> {
    if (!isStripeConfigured()) return {};

    try {
      let stripeCustomerId = input.organization.stripe_customer_id;
      if (!stripeCustomerId) {
        const customer = await createStripeCustomer({
          email: buildStripeCustomerEmail(input.organization.public_id),
          name: input.organization.name,
          metadata: { organization_id: input.organization.public_id },
          // One customer per organization: keying on the organization public id makes a retried create
          // (after a crash between the Stripe call and the local organization-row commit) return the same
          // customer instead of minting a duplicate.
          idempotencyKey: `customer-create:${input.organization.public_id}`,
        });
        stripeCustomerId = customer.id;
        await this.organizationService.updateStripeCustomerIdForOrganization(
          input.organization.public_id,
          stripeCustomerId,
        );
      }

      const stripePriceId = this.getProviderPriceId(input.plan, input.billingCycle);

      if (!stripePriceId) {
        logger.warn(
          { planId: input.plan.public_id, billingCycle: input.billingCycle },
          'Plan missing Stripe price ID — creating local-only subscription',
        );
        return { providerCustomerId: stripeCustomerId };
      }

      const stripeSubscription = await createStripeSubscription(
        omitUndefined({
          customerId: stripeCustomerId,
          priceId: stripePriceId,
          trialEnd: input.trialEnd
            ? Math.floor(new Date(input.trialEnd).getTime() / 1000)
            : undefined,
          metadata: { organization_id: input.organization.public_id },
          idempotencyKey: input.idempotencyKey,
        }),
      );

      return {
        providerSubscriptionId: stripeSubscription.id,
        providerCustomerId: stripeCustomerId,
      };
    } catch (error) {
      logger.error({ error }, 'stripe.subscription.create.failed');
      throw new ServiceUnavailableError('errors:paymentProviderUnavailable');
    }
  }

  async cancelSubscriptionAtPeriodEnd(
    providerSubscriptionId: string,
    idempotencyKey?: string,
  ): Promise<void> {
    if (!isStripeConfigured()) return;
    try {
      await cancelStripeSubscription(
        providerSubscriptionId,
        true,
        idempotencyKey !== undefined ? { idempotencyKey } : undefined,
      );
    } catch (error) {
      logger.error({ error }, 'stripe.subscription.cancel.failed');
      throw new ServiceUnavailableError('errors:paymentProviderUnavailable');
    }
  }

  async cancelSubscriptionImmediately(
    providerSubscriptionId: string,
    idempotencyKey?: string,
  ): Promise<void> {
    if (!isStripeConfigured()) return;
    try {
      // reaudit-#6: `false` = cancel now (not at period end), the only meaningful cancel for a
      // never-activated INCOMPLETE subscription.
      await cancelStripeSubscription(
        providerSubscriptionId,
        false,
        idempotencyKey !== undefined ? { idempotencyKey } : undefined,
      );
    } catch (error) {
      logger.error({ error }, 'stripe.subscription.cancel_immediate.failed');
      throw new ServiceUnavailableError('errors:paymentProviderUnavailable');
    }
  }

  async resumeSubscription(providerSubscriptionId: string, idempotencyKey?: string): Promise<void> {
    if (!isStripeConfigured()) return;
    try {
      await resumeStripeSubscription(
        providerSubscriptionId,
        idempotencyKey !== undefined ? { idempotencyKey } : undefined,
      );
    } catch (error) {
      logger.error({ error }, 'stripe.subscription.resume.failed');
      throw new ServiceUnavailableError('errors:paymentProviderUnavailable');
    }
  }

  async updateSubscriptionPrice(
    providerSubscriptionId: string,
    providerPriceId: string,
    idempotencyKey?: string,
  ): Promise<void> {
    if (!isStripeConfigured()) return;
    try {
      await updateStripeSubscription(
        providerSubscriptionId,
        omitUndefined({
          priceId: providerPriceId,
          idempotencyKey,
        }),
      );
    } catch (error) {
      logger.error({ error }, 'stripe.subscription.change_plan.failed');
      throw new ServiceUnavailableError('errors:paymentProviderUnavailable');
    }
  }

  async updateSubscriptionQuantity(
    providerSubscriptionId: string,
    quantity: number,
    idempotencyKey?: string,
  ): Promise<void> {
    if (!isStripeConfigured()) return;
    try {
      await updateStripeSubscriptionQuantity(
        providerSubscriptionId,
        quantity,
        idempotencyKey !== undefined ? { idempotencyKey } : undefined,
      );
    } catch (error) {
      logger.error({ error }, 'stripe.subscription.update_quantity.failed');
      throw new ServiceUnavailableError('errors:paymentProviderUnavailable');
    }
  }

  async compensateFailedCreate(providerSubscriptionId: string): Promise<void> {
    try {
      await cancelStripeSubscription(providerSubscriptionId, false);
    } catch (compensationError) {
      logger.error(
        { error: compensationError, providerSubscriptionId },
        'stripe.subscription.create.compensation_failed',
      );
    }
  }

  async compensatePlanChange(
    providerSubscriptionId: string,
    previousProviderPriceId: string,
  ): Promise<void> {
    try {
      await updateStripeSubscription(providerSubscriptionId, {
        priceId: previousProviderPriceId,
      });
    } catch (compensationError) {
      logger.error(
        { error: compensationError, providerSubscriptionId },
        'stripe.subscription.change_plan.compensation_failed',
      );
    }
  }
}
