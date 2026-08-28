import type Stripe from 'stripe';
import type { SubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import { createWorkerSubscriptionRepository } from '@/domains/billing/sub-domains/subscription/subscription.repository.js';
import type { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import { ConflictError } from '@/shared/errors/index.js';
import { isPostgresUniqueViolation } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { captureMessage } from '@/infrastructure/observability/sentry/sentry.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { PlanRepository } from '@/domains/billing/sub-domains/plan/plan.repository.js';
import type {
  StripeWebhookEventClaimResult,
  StripeWebhookEventRepository,
} from './stripe-webhook-event.repository.js';
import { enqueueStripeWebhook } from './queues/stripe-webhook.queue.js';
import { runStripeWebhookHandlerWithOrganizationContext } from './stripe-webhook-organization.util.js';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

/** Result row type from PlanRepository.findByStripePriceId; threaded through the sec-B9 fallback. */
type MatchedPlanForCreate = Awaited<ReturnType<PlanRepository['findByStripePriceId']>>;

/**
 * Resolves the local `billing_cycle` ('monthly' | 'yearly') for a Stripe price
 * id by matching against the plan's `stripe_price_*_id` columns. Falls back to
 * 'monthly' when neither column matches — a defensive default for a Stripe
 * dashboard that has only one of the two price ids populated, so the sec-B9
 * fallback INSERT path still creates a row instead of dropping the event. The
 * upstream `customer.subscription.updated` handler will reconcile any actual
 * billing-cycle drift on the next event.
 */
function resolveBillingCycleForStripePrice(
  stripePriceId: string | undefined,
  plan: {
    stripe_price_monthly_id: string | null;
    stripe_price_yearly_id: string | null;
  },
): 'monthly' | 'yearly' {
  if (stripePriceId !== undefined && plan.stripe_price_yearly_id === stripePriceId) {
    return 'yearly';
  }
  return 'monthly';
}

/**
 * Processes Stripe webhook events and syncs subscription state.
 * Plans are managed offline via admin panel — subscription lifecycle events only.
 *
 * @remarks
 * - **Algorithm:** Signature verification has already happened upstream in
 *   `stripeWebhookIngressPlugin` (raw-body HMAC check); this service then
 *   1) claims the event id in {@link StripeWebhookEventRepository.tryClaimEvent}
 *      to enforce at-least-once idempotency, 2) resolves tenancy scope via
 *      {@link runStripeWebhookHandlerWithOrganizationContext} (reads
 *      `organization_id` metadata or `billing.resolve_organization_public_id_for_stripe_subscription`)
 *      so RLS sees `app.current_organization_public_id`, 3) dispatches by event type
 *      and updates the local subscription row via a worker-scoped repository,
 *      and 4) marks the ledger row `processed`.
 * - **Failure modes:** Returns silently on `processed_duplicate`; throws
 *   {@link ConflictError} on `still_processing_within_lease` so BullMQ retries;
 *   any thrown error marks the ledger row `failed` (truncated reason, up to
 *   2,000 chars) before rethrowing so the worker honours its retry/backoff.
 *   Subscription updates use the `last_stripe_event_created_at` watermark to
 *   discard out-of-order events.
 * - **Side effects:** Writes to `billing.stripe_webhook_events` (always) and
 *   `billing.subscriptions` (on subscription lifecycle events). Logs each
 *   stage; unhandled event types are logged and skipped.
 * - **Notes:** Runs inside {@link withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.SYSTEM_TABLE_WORKER)} so the ledger
 *   write happens without an organization GUC; the subscription write then
 *   switches into {@link withAppDatabaseContext} for RLS-safe mutation. The
 *   `customer.subscription.created` race that left a missing local row
 *   silently advancing to `processed` is now recovered by the sec-B9 fallback
 *   INSERT path; see `tryFallbackInsertForCreated`.
 */
export class StripeWebhookService {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly stripeWebhookEventRepository: StripeWebhookEventRepository,
    /**
     * Used to resolve `items.data[0].price.id` from a `customer.subscription.updated`
     * event back to the local `plans.id` so Dashboard-driven plan changes flow into
     * `subscriptions.plan_id` (sec-B7). Drift between the Stripe-side plan and the
     * local entitlement column otherwise serves the old `plan.features` set forever
     * — most visible after a customer-service-initiated downgrade.
     */
    private readonly planRepository: PlanRepository,
  ) {}

  /**
   * HTTP-ingress durability commit for a verified Stripe event. Persists the event to the
   * Postgres ledger via {@link StripeWebhookEventRepository.tryClaimEvent} BEFORE the caller
   * ACKs Stripe (sec-B finding #6), then enqueues asynchronous BullMQ processing — but only
   * when the ledger transition was `claimed` or `reclaimed`. Returns the claim result.
   *
   * @remarks
   * - **Algorithm:** claims the event id under {@link withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.SYSTEM_TABLE_WORKER)} (no org GUC),
   *   then enqueues on `claimed`/`reclaimed`. `processed_duplicate` (already terminal) and
   *   `still_processing_within_lease` (an in-flight worker will finish) skip the enqueue and log.
   * - **Failure modes:** an enqueue failure propagates so the caller returns non-2xx and Stripe
   *   retries the delivery; the ledger row is already durable, and the reclaim cron re-enqueues
   *   stuck rows if the enqueue was lost.
   * - **Side effects:** writes `billing.stripe_webhook_events`; enqueues a `stripe-webhook` job.
   */
  async ingestEvent(
    event: Stripe.Event,
    context?: { requestId?: string },
  ): Promise<StripeWebhookEventClaimResult> {
    const claimResult = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.SYSTEM_TABLE_WORKER,
      () =>
        this.stripeWebhookEventRepository.tryClaimEvent(
          omitUndefined({
            stripe_event_id: event.id,
            event_type: event.type,
            stripe_created_at: new Date(event.created * 1000),
            request_id: context?.requestId,
          }),
        ),
    );

    if (claimResult === 'claimed' || claimResult === 'reclaimed') {
      await enqueueStripeWebhook(event, context?.requestId);
    } else {
      logger.info(
        { stripeEventId: event.id, eventType: event.type, claimResult },
        'stripe.webhook.ingress.skip_enqueue',
      );
    }

    return claimResult;
  }

  /**
   * Dispatch a Stripe event to the appropriate handler (idempotent by event id).
   */
  async handleEvent(event: Stripe.Event, context?: { requestId?: string }): Promise<void> {
    const stripeEventCreatedAt = new Date(event.created * 1000);

    await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.SYSTEM_TABLE_WORKER, async () => {
      const claimResult = await this.stripeWebhookEventRepository.tryClaimEvent(
        omitUndefined({
          stripe_event_id: event.id,
          event_type: event.type,
          stripe_created_at: stripeEventCreatedAt,
          request_id: context?.requestId,
        }),
      );

      if (claimResult === 'processed_duplicate') {
        logger.info(
          { eventId: event.id, eventType: event.type },
          'stripe.webhook.duplicate_skipped',
        );
        return;
      }

      if (claimResult === 'still_processing_within_lease') {
        throw new ConflictError(
          'errors:stripeWebhookEventInFlight',
          { eventId: event.id },
          `Stripe webhook event ${event.id} is still processing within the lease window`,
        );
      }

      if (claimResult === 'reclaimed') {
        logger.info({ eventId: event.id, eventType: event.type }, 'stripe.webhook.reclaimed');
      }

      // audit #44 — IDEMPOTENCY BOUNDARY: `markProcessed` (below) runs on a different context than
      // the business write, so a crash between the two leaves the ledger row `processing` and the
      // reclaim lease re-runs this dispatch. That is safe ONLY because every side effect here is a
      // Postgres write guarded by the `last_stripe_event_created_at` watermark + unique-violation
      // handling (a re-run is a no-op), and there is NO outbound call in this handler. Any NEW side
      // effect added to `dispatchEvent` MUST be idempotency-keyed or watermark-guarded — do not
      // assume `markProcessed` is a transactional barrier.
      try {
        await runStripeWebhookHandlerWithOrganizationContext(
          event,
          this.stripeWebhookEventRepository,
          async (databaseHandle) => {
            const workerSubscriptionRepository = createWorkerSubscriptionRepository(databaseHandle);
            await this.dispatchEvent(event, stripeEventCreatedAt, workerSubscriptionRepository);
          },
        );
        // sec-new-D2: detect no-op writes (ledger row unexpectedly absent)
        const marked = await this.stripeWebhookEventRepository.markProcessed(event.id);
        if (!marked) {
          logger.warn(
            { eventId: event.id, eventType: event.type },
            'stripe.webhook.mark_processed.no_row',
          );
        }
      } catch (error) {
        const failureReason = error instanceof Error ? error.message : String(error);
        // sec-new-D2: detect no-op writes (ledger row unexpectedly absent)
        const marked = await this.stripeWebhookEventRepository.markFailed(event.id, failureReason);
        if (!marked) {
          logger.warn(
            { eventId: event.id, eventType: event.type, failureReason },
            'stripe.webhook.mark_failed.no_row',
          );
        }
        throw error;
      }
    });
  }

  private async dispatchEvent(
    event: Stripe.Event,
    stripeEventCreatedAt: Date,
    subscriptionRepository: SubscriptionRepository,
  ): Promise<void> {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.handleSubscriptionUpdated(
          event.data.object,
          stripeEventCreatedAt,
          subscriptionRepository,
          event.type,
        );
        break;

      case 'customer.subscription.deleted':
        await this.handleSubscriptionDeleted(
          event.data.object,
          stripeEventCreatedAt,
          subscriptionRepository,
        );
        break;

      default:
        logger.info({ eventType: event.type }, 'stripe.webhook.unhandled_event');
    }
  }

  private async handleSubscriptionUpdated(
    stripeSubscription: Stripe.Subscription,
    stripeEventCreatedAt: Date,
    subscriptionRepository: SubscriptionRepository,
    eventType: 'customer.subscription.created' | 'customer.subscription.updated',
  ): Promise<void> {
    const providerSubscriptionId = stripeSubscription.id;

    const statusMap: Record<string, string> = {
      active: 'ACTIVE',
      past_due: 'PAST_DUE',
      canceled: 'CANCELED',
      unpaid: 'UNPAID',
      trialing: 'TRIALING',
      paused: 'PAUSED',
      incomplete: 'INCOMPLETE',
      incomplete_expired: 'INCOMPLETE_EXPIRED',
    };

    const mappedStatus =
      statusMap[stripeSubscription.status] ?? stripeSubscription.status.toUpperCase();

    const firstItem = stripeSubscription.items.data[0];
    const periodStart = firstItem ? new Date(firstItem.current_period_start * 1000) : new Date();
    const periodEnd = firstItem ? new Date(firstItem.current_period_end * 1000) : new Date();
    // REQ-4: reconcile the purchased seat quantity FROM Stripe (the subscription item quantity).
    // Stripe is the source of truth for `seats`, so a Dashboard-driven quantity change flows here.
    const seats =
      typeof firstItem?.quantity === 'number' && firstItem.quantity >= 0
        ? firstItem.quantity
        : undefined;

    /**
     * sec-B7: resolve the Stripe price id → local plan id. When Stripe is the
     * source of truth (an admin used the Dashboard to swap the plan), the
     * webhook is the only signal we receive — so the sync MUST include
     * `plan_id`. Omit it (rather than setting it to `null`) when the lookup
     * returns no match: a dropped row could mean an unsynced catalog entry,
     * but silently nulling the column would null every cached entitlement and
     * effectively downgrade the customer to "no plan". Better to leave the
     * existing plan_id in place and log the drift — alert tooling already
     * watches webhook-handler logs.
     */
    const stripePriceId = firstItem?.price?.id;
    let resolvedPlanId: number | undefined;
    // Track the matched plan so the sec-B9 fallback INSERT path can derive
    // `billing_cycle` from whether the Stripe price id is the monthly or
    // yearly column on the plan row.
    let matchedPlanForCreate: MatchedPlanForCreate = null;
    if (stripePriceId) {
      const matchedPlan = await this.planRepository.findByStripePriceId(stripePriceId);
      if (matchedPlan) {
        resolvedPlanId = matchedPlan.id;
        matchedPlanForCreate = matchedPlan;
      } else {
        // audit-#13: a Stripe price id with no matching local plan means the
        // plan↔Stripe catalog has drifted (Dashboard price created/changed
        // without syncing `billing.plans`). The row keeps its existing plan_id
        // (never nulled), but the drift must be visible — promote it from a bare
        // log line to a Sentry alert with the offending ids so operators can
        // reconcile the catalog instead of relying on log scraping.
        logger.warn(
          { providerSubscriptionId, stripePriceId },
          'stripe.webhook.plan_id_resolution_miss',
        );
        captureMessage('stripe.webhook.plan_id_resolution_miss', {
          level: 'warning',
          extra: { providerSubscriptionId, stripePriceId },
        });
      }
    }

    const row = await this.subscriptionService.syncFromStripeProviderSubscription(
      providerSubscriptionId,
      omitUndefined({
        status: mappedStatus,
        cancel_at_period_end: stripeSubscription.cancel_at_period_end,
        canceled_at: stripeSubscription.canceled_at
          ? new Date(stripeSubscription.canceled_at * 1000)
          : undefined,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        plan_id: resolvedPlanId,
        // REQ-4: sync the seat quantity from Stripe so local `subscriptions.seats` (and thus
        // seats_total) stays in lockstep with the provider.
        seats,
      }),
      stripeEventCreatedAt,
      subscriptionRepository,
    );

    if (row) {
      logger.info(
        { providerSubscriptionId, status: mappedStatus },
        'stripe.webhook.subscription_synced',
      );
      return;
    }

    // BILL-03: if a deletion tombstone at or after this event's timestamp exists, the
    // subscription was already deleted at Stripe before this create/update was delivered.
    // Refuse to recover — a stale create must not resurrect entitlement.
    const tombstone =
      await this.stripeWebhookEventRepository.findSubscriptionDeletionTombstone(
        providerSubscriptionId,
      );
    if (
      tombstone &&
      tombstone.deleted_event_created_at.getTime() >= stripeEventCreatedAt.getTime()
    ) {
      logger.warn(
        { providerSubscriptionId, stripeEventCreatedAt, eventType },
        'stripe.webhook.subscription_event_superseded_by_deletion',
      );
      return;
    }

    await this.recoverMissingSubscriptionRowForUpsert({
      eventType,
      providerSubscriptionId,
      stripeEventCreatedAt,
      subscriptionRepository,
      stripeSubscription,
      resolvedPlanId,
      matchedPlanForCreate,
      stripePriceId,
      periodStart,
      periodEnd,
      mappedStatus,
    });
  }

  /**
   * Handles a `customer.subscription.{created,updated}` event whose in-place sync
   * UPDATE matched no row.
   *
   * @remarks
   * - **Algorithm:** A null sync has three non-error causes that must be told
   *   apart (sec-B finding #5 + audit-#1): (a) the row exists but is **terminal**
   *   — a CANCELED tombstone written by the deletion path — or already at a newer
   *   watermark (stale); both must be left untouched, never resurrected; (b) no
   *   row exists yet and the event is `.created`, so we can safely materialise one
   *   from the payload; (c) no row exists for a `.updated` event, which is a true
   *   race that must retry. We therefore existence-check **first** (covers (a)),
   *   attempt the `.created` fallback INSERT (covers (b)), then re-check existence
   *   to absorb a concurrent insert (tombstone / `.created`) before deciding to
   *   throw.
   * - **Failure modes:** throws a retryable error for case (c) so BullMQ's
   *   exponential backoff carries the event past the race; the `attempts: 5`
   *   budget drains genuinely orphan events to the DLQ.
   * - **Side effects:** may INSERT one `billing.subscriptions` row via the
   *   `.created` fallback.
   */
  private async recoverMissingSubscriptionRowForUpsert(input: {
    eventType: 'customer.subscription.created' | 'customer.subscription.updated';
    providerSubscriptionId: string;
    stripeEventCreatedAt: Date;
    subscriptionRepository: SubscriptionRepository;
    stripeSubscription: Stripe.Subscription;
    resolvedPlanId: number | undefined;
    matchedPlanForCreate: MatchedPlanForCreate;
    stripePriceId: string | undefined;
    periodStart: Date;
    periodEnd: Date;
    mappedStatus: string;
  }): Promise<void> {
    const { eventType, providerSubscriptionId, stripeEventCreatedAt, subscriptionRepository } =
      input;

    // (a) The row is present but not updatable in place: a terminal CANCELED
    // tombstone (audit-#1) or a newer watermark already wins (stale). Either way
    // the in-place sync correctly refused — skip without resurrecting.
    if (
      await this.rowExistsForProviderSubscription(providerSubscriptionId, subscriptionRepository)
    ) {
      logger.info(
        { providerSubscriptionId, stripeEventCreatedAt, eventType },
        'stripe.webhook.subscription_event_stale_skipped',
      );
      return;
    }

    // (b) No row exists; only `.created` carries enough fields to materialise one.
    const recovered =
      eventType === 'customer.subscription.created'
        ? await this.tryFallbackInsertForCreated({
            stripeSubscription: input.stripeSubscription,
            stripeEventCreatedAt,
            subscriptionRepository,
            resolvedPlanId: input.resolvedPlanId,
            matchedPlanForCreate: input.matchedPlanForCreate,
            stripePriceId: input.stripePriceId,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            mappedStatus: input.mappedStatus,
            providerSubscriptionId,
          })
        : false;
    if (recovered) return;

    // A concurrent `.created` fallback or a deletion tombstone may have inserted
    // the row between the first existence check and the failed fallback — re-check
    // before declaring an orphan so we do not needlessly retry/DLQ.
    if (
      await this.rowExistsForProviderSubscription(providerSubscriptionId, subscriptionRepository)
    ) {
      logger.info(
        { providerSubscriptionId, stripeEventCreatedAt, eventType },
        'stripe.webhook.subscription_event_stale_skipped',
      );
      return;
    }

    // (c) Genuinely no row for a non-`.created` event (or `.created` could not
    // insert, e.g. catalog drift). Throw so BullMQ retries; the late `.created`
    // will INSERT the row and the next event applies correctly.
    logger.warn(
      { providerSubscriptionId, stripeEventCreatedAt, eventType },
      'stripe.webhook.subscription_not_found_will_retry',
    );
    throw new Error(
      `stripe.webhook.subscription_local_row_missing:${eventType}:${providerSubscriptionId}`,
    );
  }

  private async rowExistsForProviderSubscription(
    providerSubscriptionId: string,
    subscriptionRepository: SubscriptionRepository,
  ): Promise<boolean> {
    return this.subscriptionService.existsByStripeProviderSubscriptionId(
      providerSubscriptionId,
      subscriptionRepository,
    );
  }

  /**
   * sec-B9: when `customer.subscription.created` sync returns null (the row
   * did not exist yet — Stripe outran our HTTP create), insert the row
   * straight from the webhook payload. Returns `true` when the recovery
   * insert succeeded (so the caller skips the "stale/not_found" warning),
   * `false` otherwise.
   *
   * Extracted from `handleSubscriptionUpdated` to keep that method below the
   * Biome cognitive-complexity threshold; the policy logic is unchanged. A
   * missing plan id (`subscriptions.plan_id` is NOT NULL) refuses the insert
   * with a structured warning rather than corrupting downstream entitlement
   * reads with a half-broken row.
   */
  private async tryFallbackInsertForCreated(input: {
    stripeSubscription: Stripe.Subscription;
    stripeEventCreatedAt: Date;
    subscriptionRepository: SubscriptionRepository;
    resolvedPlanId: number | undefined;
    matchedPlanForCreate: MatchedPlanForCreate;
    stripePriceId: string | undefined;
    periodStart: Date;
    periodEnd: Date;
    mappedStatus: string;
    providerSubscriptionId: string;
  }): Promise<boolean> {
    const { resolvedPlanId, matchedPlanForCreate, stripePriceId, providerSubscriptionId } = input;
    if (!(resolvedPlanId && matchedPlanForCreate)) {
      logger.warn(
        { providerSubscriptionId, stripePriceId },
        'stripe.webhook.subscription_created_insert_skipped_no_plan',
      );
      return false;
    }
    // audit-#1: `billing.subscriptions.billing_cycle` is constrained to
    // ('MONTHLY','YEARLY') by `chk_subs_cycle`; the resolver returns lower-case,
    // so normalise before the INSERT (the prior code inserted 'monthly' and would
    // have failed the CHECK on the real DB).
    const billingCycle = resolveBillingCycleForStripePrice(
      stripePriceId,
      matchedPlanForCreate,
    ).toUpperCase();
    try {
      const inserted = await this.subscriptionService.createFromStripeWebhookEvent({
        providerSubscriptionId,
        providerCustomerId:
          typeof input.stripeSubscription.customer === 'string'
            ? input.stripeSubscription.customer
            : null,
        planId: resolvedPlanId,
        status: input.mappedStatus,
        cancelAtPeriodEnd: input.stripeSubscription.cancel_at_period_end,
        canceledAt: input.stripeSubscription.canceled_at
          ? new Date(input.stripeSubscription.canceled_at * 1000)
          : null,
        currentPeriodStart: input.periodStart,
        currentPeriodEnd: input.periodEnd,
        billingCycle,
        stripeEventCreatedAt: input.stripeEventCreatedAt,
        repositoryOverride: input.subscriptionRepository,
      });
      if (!inserted) return false;
      logger.info(
        { providerSubscriptionId, planId: resolvedPlanId, billingCycle },
        'stripe.webhook.subscription_inserted_on_created',
      );
      return true;
    } catch (error) {
      // A concurrent `.deleted` tombstone or duplicate `.created` won the
      // `provider_subscription_id` unique race. Treat the now-present row as the
      // winner; the caller re-checks existence and skips instead of retrying.
      if (isPostgresUniqueViolation(error)) {
        logger.info(
          { providerSubscriptionId },
          'stripe.webhook.subscription_created_insert_lost_race',
        );
        return false;
      }
      throw error;
    }
  }

  private async handleSubscriptionDeleted(
    stripeSubscription: Stripe.Subscription,
    stripeEventCreatedAt: Date,
    subscriptionRepository: SubscriptionRepository,
  ): Promise<void> {
    const providerSubscriptionId = stripeSubscription.id;

    const row = await this.subscriptionService.markCanceledByStripeProviderSubscriptionId(
      providerSubscriptionId,
      stripeEventCreatedAt,
      subscriptionRepository,
    );

    if (row) {
      logger.info({ providerSubscriptionId }, 'stripe.webhook.subscription_canceled');
      return;
    }

    // BILL-03: the delete arrived before any local row existed (Stripe delivery reorder).
    // Record a deletion watermark so a later out-of-order created/updated cannot resurrect
    // entitlement. The existing tryInsertCancellationTombstone still writes a CANCELED row
    // in billing.subscriptions as the durable subscription-level guard.
    await this.stripeWebhookEventRepository.recordSubscriptionDeletionTombstone(
      providerSubscriptionId,
      stripeEventCreatedAt,
    );
    logger.warn(
      { providerSubscriptionId, stripeEventCreatedAt },
      'stripe.webhook.subscription_cancel_stale_or_missing_tombstoned',
    );

    // audit-#1 (CRITICAL): no local row matched the deletion. Previously this only
    // logged `subscription_cancel_stale_or_missing` and let the enclosing handler
    // mark the event `processed` — so a later out-of-order
    // `customer.subscription.created` (delivered after `.deleted` during a Stripe
    // ordering delay) would INSERT an ACTIVE row that the now-terminal deletion
    // event could never replay against. Close the gap by writing a terminal
    // CANCELED **tombstone** keyed by `provider_subscription_id`; the unique index
    // + the terminal-status guard on `syncFromStripeProviderSubscription` then make
    // any future `.created` / `.updated` for this id a no-op.
    const tombstoned = await this.tryInsertCancellationTombstone({
      stripeSubscription,
      stripeEventCreatedAt,
      subscriptionRepository,
      providerSubscriptionId,
    });
    if (tombstoned) {
      logger.info(
        { providerSubscriptionId, stripeEventCreatedAt },
        'stripe.webhook.subscription_cancel_tombstone_inserted',
      );
      return;
    }

    // The tombstone could not be written because a concurrent `.created` inserted
    // the row first (lost the unique race). Re-run the cancel against that row.
    const recovered = await this.subscriptionService.markCanceledByStripeProviderSubscriptionId(
      providerSubscriptionId,
      stripeEventCreatedAt,
      subscriptionRepository,
    );
    if (recovered) {
      logger.info({ providerSubscriptionId }, 'stripe.webhook.subscription_canceled');
      return;
    }

    // Nothing durable could be written (no resolvable plan for the tombstone and no
    // row to cancel). Do NOT silently advance the ledger to `processed`: throw so
    // BullMQ retries with backoff — a late `.created` will materialise the row and a
    // retry of this deletion will then cancel it.
    logger.warn(
      { providerSubscriptionId, stripeEventCreatedAt },
      'stripe.webhook.subscription_cancel_no_row_will_retry',
    );
    throw new Error(
      `stripe.webhook.subscription_cancel_local_row_missing:${providerSubscriptionId}`,
    );
  }

  /**
   * Materialises a terminal CANCELED tombstone row for a deletion event whose
   * local subscription row was absent (audit-#1).
   *
   * @remarks
   * - **Algorithm:** resolves the local plan id from the deleted subscription's
   *   `items.data[0].price.id` (the tombstone still needs a NOT-NULL `plan_id`),
   *   derives `billing_cycle` + period boundaries from the payload, and inserts a
   *   CANCELED row via {@link SubscriptionService.insertCanceledTombstoneFromStripeWebhookEvent}.
   * - **Failure modes:** returns `false` when no price/plan can be resolved (the
   *   caller then throws to retry rather than silently dropping the cancellation),
   *   or when a concurrent insert wins the `provider_subscription_id` unique race
   *   (the caller re-runs the cancel against the now-present row).
   * - **Side effects:** at most one INSERT into `billing.subscriptions`.
   */
  private async tryInsertCancellationTombstone(input: {
    stripeSubscription: Stripe.Subscription;
    stripeEventCreatedAt: Date;
    subscriptionRepository: SubscriptionRepository;
    providerSubscriptionId: string;
  }): Promise<boolean> {
    const {
      stripeSubscription,
      stripeEventCreatedAt,
      subscriptionRepository,
      providerSubscriptionId,
    } = input;

    const firstItem = stripeSubscription.items.data[0];
    const stripePriceId = firstItem?.price?.id;
    if (!stripePriceId) {
      logger.warn(
        { providerSubscriptionId },
        'stripe.webhook.subscription_cancel_tombstone_skipped_no_price',
      );
      return false;
    }

    const matchedPlan = await this.planRepository.findByStripePriceId(stripePriceId);
    if (!matchedPlan) {
      logger.warn(
        { providerSubscriptionId, stripePriceId },
        'stripe.webhook.subscription_cancel_tombstone_skipped_no_plan',
      );
      return false;
    }

    const billingCycle = resolveBillingCycleForStripePrice(
      stripePriceId,
      matchedPlan,
    ).toUpperCase();
    const periodStart = new Date(firstItem.current_period_start * 1000);
    const periodEnd = new Date(firstItem.current_period_end * 1000);
    const canceledAt = stripeSubscription.canceled_at
      ? new Date(stripeSubscription.canceled_at * 1000)
      : stripeEventCreatedAt;

    try {
      const inserted = await this.subscriptionService.insertCanceledTombstoneFromStripeWebhookEvent(
        {
          providerSubscriptionId,
          providerCustomerId:
            typeof stripeSubscription.customer === 'string' ? stripeSubscription.customer : null,
          planId: matchedPlan.id,
          billingCycle,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          canceledAt,
          stripeEventCreatedAt,
          repositoryOverride: subscriptionRepository,
        },
      );
      return inserted !== null;
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        logger.info(
          { providerSubscriptionId },
          'stripe.webhook.subscription_cancel_tombstone_lost_race',
        );
        return false;
      }
      throw error;
    }
  }
}
