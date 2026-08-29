import type Stripe from 'stripe';
import type { WorkerContextDatabaseHandle } from '@/infrastructure/database/utils/database-handle.types.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { StripeWebhookEventRepository } from './stripe-webhook-event.repository.js';

type StripeSubscriptionEvent =
  | Stripe.CustomerSubscriptionCreatedEvent
  | Stripe.CustomerSubscriptionUpdatedEvent
  | Stripe.CustomerSubscriptionDeletedEvent;

function isStripeSubscriptionEvent(event: Stripe.Event): event is StripeSubscriptionEvent {
  return (
    event.type === 'customer.subscription.created' ||
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.deleted'
  );
}

function stripeEventRequiresOrganizationContext(eventType: string): boolean {
  return (
    eventType === 'customer.subscription.created' ||
    eventType === 'customer.subscription.updated' ||
    eventType === 'customer.subscription.deleted'
  );
}

const ORGANIZATION_ID_METADATA_KEY = 'organization_id';

function readOrganizationPublicIdFromStripeMetadata(
  metadata: Stripe.Metadata | null | undefined,
): string | undefined {
  if (metadata === null || metadata === undefined) {
    return undefined;
  }
  // eslint-disable-next-line security/detect-object-injection -- ORGANIZATION_ID_METADATA_KEY is a module constant.
  const organizationPublicId = metadata[ORGANIZATION_ID_METADATA_KEY];
  return typeof organizationPublicId === 'string' && organizationPublicId.length > 0
    ? organizationPublicId
    : undefined;
}

/**
 * Extracts the Stripe customer id from a subscription object's `customer` field,
 * which the API returns either expanded (`Stripe.Customer` / `DeletedCustomer`)
 * or as a bare id string depending on the webhook configuration.
 */
function readStripeCustomerId(
  customer: Stripe.Subscription['customer'] | null | undefined,
): string | undefined {
  if (typeof customer === 'string') {
    return customer.length > 0 ? customer : undefined;
  }
  const customerId = customer?.id;
  return typeof customerId === 'string' && customerId.length > 0 ? customerId : undefined;
}

/**
 * Resolves tenancy scope for Stripe webhook side effects (RLS requires app.current_organization_public_id).
 *
 * @remarks
 * The **database mapping is authoritative whenever it exists** (audit #2): the
 * owning organization is resolved from the locally-persisted subscription row
 * (by provider subscription id) or, when that id is not yet mapped, from the
 * customer mapping (`provider_customer_id` — present on the local row from the
 * moment the service creates a subscription). Stripe `metadata.organization_id`
 * is reduced to a **cross-check**: when a subscription *or* customer mapping
 * resolves, a metadata value that disagrees throws (a tamper signal) and the
 * database value wins. This closes the realistic redirect attack — an attacker
 * with Stripe-side write access who sets `metadata.organization_id` on an
 * existing customer's subscription can no longer route its events into another
 * tenant, because the customer mapping now overrides metadata and the mismatch
 * throws.
 *
 * Metadata remains the binding of **last resort** only for a genuinely
 * first-contact, Dashboard-originated subscription whose customer is also
 * unknown locally (the fallback-INSERT path, audit-#1): there is no other source
 * of truth, and the `subscriptions_tenant_isolation` WITH CHECK (audit #41) is
 * the backstop — a metadata value naming a non-existent organization resolves to
 * no GUC id and the write fails closed.
 *
 * Both Postgres lookups are delegated to {@link StripeWebhookEventRepository} so
 * direct DB access stays at the repository layer (architecture rule: services
 * and utils call repositories; only repositories own the DB connection).
 */
export async function resolveOrganizationPublicIdForStripeEvent(
  event: Stripe.Event,
  repository: StripeWebhookEventRepository,
): Promise<string | undefined> {
  if (!isStripeSubscriptionEvent(event)) {
    return undefined;
  }

  const stripeSubscription = event.data.object;

  const fromMetadata = readOrganizationPublicIdFromStripeMetadata(stripeSubscription.metadata);
  const fromSubscription = await repository.resolveOrganizationPublicIdByProviderSubscriptionId(
    stripeSubscription.id,
  );

  // The subscription-id mapping is the most specific authoritative source; fall
  // back to the customer-id mapping only when the subscription is not yet
  // persisted locally (created-event race / Dashboard-origin).
  const stripeCustomerId = readStripeCustomerId(stripeSubscription.customer);
  const fromCustomer =
    fromSubscription === undefined && stripeCustomerId !== undefined
      ? await repository.resolveOrganizationPublicIdByStripeCustomerId(stripeCustomerId)
      : undefined;

  const fromDatabase = fromSubscription ?? fromCustomer;

  if (fromMetadata !== undefined && fromDatabase !== undefined && fromMetadata !== fromDatabase) {
    throw new Error(
      `Stripe webhook event ${event.id} (${event.type}) has mismatched organization metadata for subscription ${stripeSubscription.id}`,
    );
  }

  // Database mapping wins when present; metadata is the binding of last resort
  // for a first-contact subscription with no local row, guarded by the
  // subscriptions WITH CHECK (audit #41) against a non-existent organization.
  return fromDatabase ?? fromMetadata;
}

/**
 * Runs billing mutations under SET LOCAL app.current_organization_public_id for RLS policies.
 */
export async function runWithOrganizationPublicIdForStripeWebhook<T>(
  organizationPublicId: string,
  callback: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
): Promise<T> {
  return withAppDatabaseContext(
    PRINCIPAL_SCOPE.JOB({ organizationPublicId: organizationPublicId }),
    callback,
  );
}

/**
 * Resolves the organization scope for `event` and runs `handler` inside that
 * RLS context, returning `undefined` for events that legitimately have no
 * organization (e.g. unhandled global event types). Throws when the event type
 * requires tenancy (subscription lifecycle) but no organization could be found,
 * so the caller marks the ledger row failed instead of silently skipping.
 */
export async function runStripeWebhookHandlerWithOrganizationContext<T>(
  event: Stripe.Event,
  repository: StripeWebhookEventRepository,
  handler: (databaseHandle: WorkerContextDatabaseHandle) => Promise<T>,
): Promise<T | undefined> {
  const organizationPublicId = await resolveOrganizationPublicIdForStripeEvent(event, repository);
  if (organizationPublicId === undefined) {
    logger.warn(
      { eventId: event.id, eventType: event.type },
      'stripe.webhook.organization_not_resolved',
    );

    if (stripeEventRequiresOrganizationContext(event.type)) {
      throw new Error(
        `Stripe webhook event ${event.id} (${event.type}) requires organization context but organization could not be resolved`,
      );
    }

    return undefined;
  }

  return runWithOrganizationPublicIdForStripeWebhook(organizationPublicId, handler);
}
