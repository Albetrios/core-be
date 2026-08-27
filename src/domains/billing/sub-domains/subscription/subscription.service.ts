import { ConflictError, NotFoundError, UnprocessableEntityError } from '@/shared/errors/index.js';
import { randomUUID } from 'node:crypto';

import { isPostgresUniqueViolation } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { env } from '@/shared/config/env.config.js';
import {
  RedisLockUnavailableError,
  withRedisLock,
} from '@/infrastructure/cache/redis-lock.util.js';
import { addMonths } from './subscription-period.util.js';
import { INACTIVE_SUBSCRIPTION_STATUSES } from './subscription.repository.js';

/**
 * Per-org lock TTL (seconds) around subscription create (audit-#B4). Must exceed the worst-case
 * `paymentProvider.createSubscription` latency plus the surrounding DB work so the lock never lapses
 * mid-create; a crashed holder auto-releases at this TTL.
 */
const SUBSCRIPTION_CREATE_LOCK_TTL_SECONDS = 20;
/** Max time (ms) a concurrent create waits for the in-flight one to finish before returning a retryable 409. */
const SUBSCRIPTION_CREATE_LOCK_WAIT_MS = 10_000;

/**
 * Subscription statuses that are considered terminal (non-mutable).
 *
 * @remarks
 * `CANCELED` and `INCOMPLETE_EXPIRED` rows can no longer be modified via the
 * cancel / resume / changePlan operations. Attempting to do so would make a
 * spurious Stripe API call against an already-inactive subscription, which
 * produces a Stripe error, surfaces as 503 to the caller, and may confuse
 * downstream event reconciliation. Guard every mutating method with this set
 * before reaching the payment provider (sec-new-B1). Sourced from
 * {@link INACTIVE_SUBSCRIPTION_STATUSES} so the "mutable" and "occupies the
 * subscription slot" definitions stay in lockstep (audit-#1).
 */
const TERMINAL_STATUSES = new Set<string>(INACTIVE_SUBSCRIPTION_STATUSES);

/**
 * Dunning subscription statuses — a payment has failed but the subscription has not yet been
 * canceled. The org keeps its full plan ceiling until `current_period_end + BILLING_DUNNING_GRACE_DAYS`
 * (F4), after which its entitlement lapses to the Free-tier ceiling.
 */
const DUNNING_STATUSES = new Set<string>(['PAST_DUE', 'UNPAID', 'INCOMPLETE']);

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { assertTeamOrganization } from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import type { PlanService } from '@/domains/billing/sub-domains/plan/plan.service.js';
import type { PaymentProvider } from './payment-provider.port.js';
import type { SubscriptionRepository } from './subscription.repository.js';
import type { SubscriptionUpdateData } from './subscription.types.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { PAGINATION } from '@/shared/constants/pagination.constants.js';
import { BillingAccountSerializer } from './billing-account.serializer.js';
import {
  createStripeSetupIntent,
  isStripeConfigured,
  listStripeInvoices,
  listStripePaymentMethods,
  retrieveStripeCustomerDefaultPaymentMethodId,
} from '@/infrastructure/payment/stripe.client.js';

/**
 * Cross-domain port for the tenancy seat counter (REQ-4): resolves how many seats an
 * organization currently consumes (ACTIVE + INVITED memberships).
 *
 * @remarks
 * - **Algorithm:** declared as a minimal structural interface rather than importing
 *   `MembershipService`, so billing can read the count without a hard import cycle
 *   (tenancy's membership service also depends on billing for the seat-limit check).
 * - **Failure modes:** the implementer runs inside the org RLS context and throws on a
 *   missing organization.
 * - **Side effects:** none on this type — the implementer issues the COUNT query.
 * - **Notes:** satisfied structurally by `MembershipService.countActiveMembers`; wired in
 *   by the composition root.
 */
export type MembershipSeatUsagePort = {
  countActiveMembers(options: { organizationPublicId: string }): Promise<number>;
  /**
   * F2: suspends the most-recently-joined non-owner ACTIVE members until the org's active headcount
   * fits `ceiling`; returns how many were suspended. The owner is never suspended. Optional so the
   * worker composition root and minimal test harnesses can omit it (then downgrade auto-suspend is a
   * no-op). Implemented structurally by `MembershipService.suspendExcessActiveMembersToFitCeiling`.
   */
  suspendExcessActiveMembersToFitCeiling?(options: {
    organizationPublicId: string;
    ceiling: number;
  }): Promise<number>;
};

/** Repository row enriched with the REQ-4 seat counters before serialization. */
type SubscriptionRowWithSeatState = {
  seats: number | null;
  plan_included_seats: number | null;
};
import {
  validateChangePlan,
  validateCreateSubscription,
  validateListInvoicesQuery,
  validateUpdateSubscription,
} from './subscription.validator.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import {
  withPrincipalDatabaseContext,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { enqueueSubscriptionSeatSyncBestEffort } from './queues/subscription-seat-sync.queue.js';
import { resolveVerifiedPrincipalScope } from '@/shared/utils/identity/verified-principal-scope.util.js';

/**
 * Namespaces a client-supplied `X-Idempotency-Key` by organization (and operation) before it is
 * forwarded to Stripe (audit #3).
 *
 * @remarks
 * Stripe idempotency keys are scoped per Stripe *account* (the whole platform), not per tenant, so
 * forwarding a bare client header lets a key chosen by org A collide with the same string from org B
 * at Stripe — leaking A's cached object to B, or erroring B's request (`idempotency_error`) as a
 * chosen-key cross-tenant DoS. Prefixing with `op:org` keeps each tenant's key space disjoint.
 * Returns `undefined` when no client key was supplied (the caller passes nothing to Stripe).
 */
export function buildStripeIdempotencyKey(
  operation: string,
  organizationPublicId: string,
  clientKey: string | undefined,
): string | undefined {
  return clientKey === undefined ? undefined : `${operation}:${organizationPublicId}:${clientKey}`;
}

// audit H2: a Stripe-backed subscription must NOT change to a plan that has no
// Stripe price id for its billing cycle. The Stripe price update in changePlan is
// gated on `providerPriceId`, but the local `plan_id` write is unconditional — so
// without this guard the local entitlement switches to the new tier while Stripe
// keeps billing the OLD price, and the watermark stamp blocks the reconciling
// `customer.subscription.updated` webhook (un-self-healing divergence). Only a
// genuinely local-only subscription (no `provider_subscription_id`) may change to
// a price-less plan. Extracted so changePlan stays within its complexity budget.
function assertProviderPriceForStripeBackedPlanChange(
  providerSubscriptionId: string | null,
  providerPriceId: string | null | undefined,
): void {
  if (providerSubscriptionId && !providerPriceId) {
    throw new UnprocessableEntityError('errors:planNotAvailableForBillingCycle');
  }
}

/**
 * Coordinates plan lookups, payment-provider calls, and subscription updates
 * for a single organization.
 *
 * @remarks
 * - **Algorithm:** Each public method runs the database portion inside
 *   {@link withPrincipalDatabaseContext} so Postgres sees the org GUC for
 *   RLS, then performs the Stripe API call (create / change-plan / cancel /
 *   resume) outside that context, then re-opens an organization context to
 *   write back the resulting row. Webhook-triggered methods
 *   (`syncFromStripeProviderSubscription`, `markCanceledByStripeProviderSubscriptionId`)
 *   accept a repository override so the webhook worker can pass its own
 *   worker-scoped handle.
 * - **Failure modes:** Throws {@link NotFoundError} when the organization,
 *   plan, or subscription cannot be loaded. The mutating operations (`create` /
 *   `changePlan` / `cancel` / `resume`) first reject a PERSONAL organization with
 *   422 via `assertTeamOrganization(organization, 'BILLING')` — billing is a
 *   team-only action (a PERSONAL organization cannot manage billing). On `create`, throws
 *   {@link ConflictError} (`errors:subscriptionAlreadyExists`) when the
 *   organization already has a non-terminal subscription (checked before the
 *   Stripe call) or when a concurrent create loses the partial-unique-index
 *   race (Postgres `unique_violation`, `23505`). The payment provider is
 *   **fail-closed**: a Stripe failure on `create` / `cancel` / `resume` /
 *   `changePlan` surfaces as `ServiceUnavailableError` from the provider, which
 *   runs *before* any local write, so no local subscription row is created or
 *   mutated when the provider call fails — the Stripe webhook stays the
 *   reconciliation source of truth. If persistence fails *after* the Stripe
 *   create succeeded, the provider is rolled back via `compensateFailedCreate`.
 *   On `changePlan`, a successful provider price update followed by a local
 *   write failure triggers `compensatePlanChange` back to the previous price.
 * - **Side effects:** External Stripe API calls (create / update / cancel /
 *   resume / compensations) and writes to `billing.subscriptions`.
 * - **Notes:** Stripe network calls MUST stay outside the database context to
 *   avoid blocking a Postgres connection on remote I/O. Idempotency for
 *   `create` is forwarded to Stripe via `idempotencyKey` (the
 *   `X-Idempotency-Key` HTTP header).
 */
export class SubscriptionService {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly planService: PlanService,
    private readonly repository: SubscriptionRepository,
    private readonly paymentProvider: PaymentProvider,
    // REQ-4: resolves seats_used (ACTIVE + INVITED memberships). Optional so the worker
    // composition root and minimal test harnesses can omit it; when unset, seats_used
    // reports 0 (the read paths still return a coherent shape). The HTTP container always wires it.
    private readonly membershipSeatUsage?: MembershipSeatUsagePort,
  ) {}

  /**
   * Computes `seats_total` / `seats_used` for a subscription row (REQ-4).
   *
   * @remarks
   * - **Algorithm:** `seats_total = row.seats ?? row.plan_included_seats ?? null` (null =
   *   unlimited); `seats_used` is the org's ACTIVE + INVITED membership count from the injected
   *   {@link MembershipSeatUsagePort}.
   * - **Failure modes:** when the membership port is not wired, `seats_used` defaults to 0 (and a
   *   warning is logged) so the response shape stays stable for minimal/worker harnesses.
   * - **Side effects:** one cross-domain membership COUNT (under the org RLS context) per call.
   * - **Notes:** the count is resolved ONCE per request and reused across every row (a list of an
   *   org's subscriptions all share the same org seat usage).
   */
  private async decorateWithSeatCounts<TRow extends SubscriptionRowWithSeatState>(
    organization_public_id: string,
    rows: TRow[],
  ): Promise<(TRow & { seats_total: number | null; seats_used: number })[]> {
    let seatsUsed = 0;
    if (this.membershipSeatUsage) {
      seatsUsed = await this.membershipSeatUsage.countActiveMembers({
        organizationPublicId: organization_public_id,
      });
    } else {
      logger.warn(
        { organizationPublicId: organization_public_id },
        'subscription.seats_used.membership_port_unwired',
      );
    }
    return rows.map((row) => ({
      ...row,
      seats_total: row.seats ?? row.plan_included_seats ?? null,
      seats_used: seatsUsed,
    }));
  }

  /**
   * Reads the org's active seat allowance under a row lock (REQ-4 seat enforcement).
   *
   * @remarks
   * - **Algorithm:** delegates to {@link SubscriptionRepository.findActiveSeatStateByOrganizationForUpdate},
   *   which takes `FOR UPDATE` on the active subscription row, then resolves the ceiling:
   *   active entitlement → purchased `seats` ?? plan `included_seats`; **no active subscription**
   *   (F3) or a **dunning subscription past its grace window** (F4) → the Free-tier ceiling
   *   ({@link PlanService.getFreePlanSeatCeiling}). `null` still means "no ceiling to enforce"
   *   (unlimited plan, or no plan catalog configured).
   * - **Failure modes:** none beyond the underlying queries; the caller MUST already hold an
   *   organization DB context + transaction so the lock spans the subsequent membership insert.
   * - **Side effects:** acquires a `FOR UPDATE` row lock (released at the caller's COMMIT) when an
   *   active subscription exists. The Free-tier path has no subscription row to lock; the caller
   *   ({@link MembershipService} add-member) takes a per-org advisory lock up front so the
   *   count+insert is serialized on the free path too (audit-#M1) — the seat cap no longer depends
   *   on the free ceiling happening to be 1. See `docs/reference/architecture/production-audit-decisions.md`.
   * - **Notes:** this is the cross-domain entry point tenancy's `MembershipService` calls to
   *   enforce the seat limit on add-member; it returns only the numeric ceiling, never the row.
   */
  async reserveSeatCeilingForMemberAdd(organization_id: number): Promise<number | null> {
    const seatState =
      await this.repository.findActiveSeatStateByOrganizationForUpdate(organization_id);
    // F3/F4: no active subscription, or a dunning subscription past its grace window, falls back to
    // the Free-tier ceiling (the cheapest active plan's included_seats) rather than "unlimited".
    if (!seatState || this.isDunningEntitlementLapsed(seatState)) {
      return this.planService.getFreePlanSeatCeiling();
    }
    return seatState.seats ?? seatState.plan_included_seats ?? null;
  }

  /**
   * F4: true when `seatState` is a dunning subscription (PAST_DUE / UNPAID / INCOMPLETE) whose grace
   * window (`current_period_end + BILLING_DUNNING_GRACE_DAYS`) has elapsed, so its entitlement has
   * lapsed to the Free tier. Non-dunning (ACTIVE / TRIALING / PAUSED) and within-grace dunning keep
   * the full plan ceiling.
   */
  private isDunningEntitlementLapsed(seatState: {
    status: string;
    current_period_end: Date;
  }): boolean {
    if (!DUNNING_STATUSES.has(seatState.status)) return false;
    const graceEndsAt =
      new Date(seatState.current_period_end).getTime() +
      env.BILLING_DUNNING_GRACE_DAYS * MILLISECONDS_PER_DAY;
    return Date.now() > graceEndsAt;
  }

  /**
   * Best-effort enqueue of a Stripe seat-quantity reconciliation for an org (REQ-4).
   *
   * @remarks
   * - **Algorithm:** fire-and-forget enqueue onto the seat-sync queue. Each enqueue is a distinct
   *   durable job; the worker re-reads the authoritative member count and pushes it to Stripe.
   * - **Failure modes:** swallows enqueue errors (logged) — a Redis blip must never fail the
   *   member-management or change-plan request that triggered it.
   * - **Side effects:** writes one job to the seat-sync queue.
   * - **Notes:** the cross-domain entry point tenancy's `MembershipService` calls after a member
   *   add/remove commits, and `changePlan` calls after a successful plan change.
   */
  enqueueSeatQuantitySync(organization_public_id: string, idempotencyKey?: string): void {
    // audit #1: stamp a STABLE idempotency token so every RETRY of the same job reuses it — the
    // Stripe quantity update is then deduped at Stripe instead of re-issued (which, with
    // proration/usage billing, would post duplicate proration line items). The member add/remove hot
    // path passes no key and gets an org-scoped random token (a fresh one per enqueue avoids a stale
    // idempotent replay on an N→M→N seat oscillation).
    // sec-review: when the caller DOES supply a client key (`changePlan`), namespace it by org before
    // it reaches Stripe as `${token}:qty:${n}` — otherwise two orgs reusing the same client-key string
    // with the same resulting seat count collide on ONE Stripe idempotency key across different
    // subscriptions (Stripe 400 param-mismatch → retries exhaust → seats never sync).
    const seatSyncToken =
      buildStripeIdempotencyKey('sub-seat-sync', organization_public_id, idempotencyKey) ??
      `seat-sync:${organization_public_id}:${randomUUID()}`;
    enqueueSubscriptionSeatSyncBestEffort(
      omitUndefined({
        organizationPublicId: organization_public_id,
        idempotencyKey: seatSyncToken,
      }),
    );
  }

  /**
   * Reconciles the Stripe subscription quantity to the org's current member count (REQ-4).
   *
   * @remarks
   * - **Algorithm:** phase 1 (org DB context) reads the active subscription; the Stripe quantity
   *   update then runs OUTSIDE any DB context (no checkout held across the round trip — mirrors the
   *   HTTP create/cancel/change-plan phasing); phase 2 (org DB context) persists `subscriptions.seats`
   *   so reads reflect the synced quantity immediately (the `customer.subscription.updated` webhook
   *   also confirms it). Seat usage (ACTIVE + INVITED) comes from the injected membership port.
   * - **Failure modes:** a Stripe outage throws `ServiceUnavailableError` from the provider so the
   *   caller (BullMQ worker) retries; no active subscription / no member-port is a no-op. Local-only
   *   subscriptions (no `provider_subscription_id`) skip the Stripe call but still persist `seats`.
   * - **Side effects:** at most one Stripe update + one local `subscriptions.seats` write.
   * - **Notes:** safe to call from the seat-sync worker directly (it manages its own contexts, like
   *   `cancelActiveForOrganizationOffboarding`); never holds a checkout across the Stripe call.
   */
  async syncSeatQuantityForOrganization(
    organization_public_id: string,
    idempotencyKey?: string,
  ): Promise<void> {
    if (!this.membershipSeatUsage) {
      logger.warn(
        { organizationPublicId: organization_public_id },
        'subscription.seat_sync.membership_port_unwired',
      );
      return;
    }
    const { organization, subscription } = await withPrincipalDatabaseContext(
      resolveVerifiedPrincipalScope({ organizationPublicId: organization_public_id }),
      async () => {
        const organization =
          await this.organizationService.requireOrganizationByPublicId(organization_public_id);
        const subscription = await this.repository.findActiveByOrganization(organization.id);
        return { organization, subscription };
      },
    );
    if (!subscription) return;

    const seatsUsed = await this.membershipSeatUsage.countActiveMembers({
      organizationPublicId: organization_public_id,
    });
    // Stripe requires quantity >= 1; never push 0 (which Stripe rejects) — clamp to 1 so a transient
    // empty-membership read cannot fail the sync.
    const quantity = Math.max(1, seatsUsed);

    // audit #1: scope the Stripe idempotency key by the resolved quantity. The base token is stable
    // across a job's retries (so a retried update with the SAME quantity is deduped at Stripe — no
    // duplicate proration); appending the quantity means a retry that recomputes a DIFFERENT desired
    // quantity becomes a distinct operation instead of a Stripe param-mismatch error. Undefined only
    // on a non-queue direct call (the enqueue path always stamps a token).
    const quantityUpdateIdempotencyKey =
      idempotencyKey !== undefined ? `${idempotencyKey}:qty:${quantity}` : undefined;

    // Stripe network call — OUTSIDE any database context.
    if (subscription.provider_subscription_id) {
      await this.paymentProvider.updateSubscriptionQuantity(
        subscription.provider_subscription_id,
        quantity,
        quantityUpdateIdempotencyKey,
      );
    }

    await withPrincipalDatabaseContext(
      resolveVerifiedPrincipalScope({ organizationPublicId: organization_public_id }),
      async () =>
        this.repository.update(subscription.public_id, organization.id, {
          seats: quantity,
        }),
    );
  }

  async syncFromStripeProviderSubscription(
    provider_subscription_id: string,
    data: SubscriptionUpdateData,
    stripe_event_created_at: Date,
    repositoryOverride?: SubscriptionRepository,
  ) {
    const repository = repositoryOverride ?? this.repository;
    return repository.syncFromStripeProviderSubscription(
      provider_subscription_id,
      data,
      stripe_event_created_at,
    );
  }

  async markCanceledByStripeProviderSubscriptionId(
    provider_subscription_id: string,
    stripe_event_created_at: Date,
    repositoryOverride?: SubscriptionRepository,
  ) {
    const repository = repositoryOverride ?? this.repository;
    return repository.markCanceledByProviderSubscriptionId(
      provider_subscription_id,
      stripe_event_created_at,
    );
  }

  /**
   * sec-B finding #5: existence check on a Stripe-side subscription id, used by the
   * webhook service to distinguish stale-event (no-op) from race-condition (retry)
   * when the sync UPDATE returns null. Routed through the service so tests inject
   * the worker-scoped repository the same way they do for sync/cancel.
   */
  async existsByStripeProviderSubscriptionId(
    provider_subscription_id: string,
    repositoryOverride?: SubscriptionRepository,
  ): Promise<boolean> {
    const repository = repositoryOverride ?? this.repository;
    return repository.existsByProviderSubscriptionId(provider_subscription_id);
  }

  /**
   * Fallback INSERT path for `customer.subscription.created` webhook events
   * whose local row is still missing (sec-B9).
   *
   * @remarks
   * When the Stripe webhook arrives before the HTTP create path has committed
   * the local row (typical B2 race in busy production traffic), the regular
   * sync UPDATE matches 0 rows and the event quietly advances to `processed` —
   * the user's first billing cycle is then invisible to local entitlement.
   * This method resolves the active organization context (`organizationPublicId`
   * is set by the webhook tenancy resolver before the dispatch) and inserts
   * the row with the worker-scoped repository. Returns `null` on a missing
   * organization (catalog drift; should already be caught by the tenancy
   * resolver but defensive here) so the caller can log + advance the ledger
   * rather than throw a non-retryable error.
   */
  async createFromStripeWebhookEvent(input: {
    providerSubscriptionId: string;
    providerCustomerId: string | null;
    planId: number;
    status: string;
    cancelAtPeriodEnd: boolean;
    canceledAt: Date | null;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    billingCycle: string;
    stripeEventCreatedAt: Date;
    repositoryOverride: SubscriptionRepository;
  }) {
    const organizationId = await input.repositoryOverride.findOrganizationIdFromCurrentContext();
    if (organizationId === null) {
      return null;
    }
    // SubscriptionCreateData does not carry cancel_at_period_end / canceled_at
    // — the subsequent customer.subscription.updated event (Stripe always
    // emits one shortly after .created) will sync those columns through the
    // regular UPDATE path. For a brand-new subscription they are essentially
    // always (false, null) anyway.
    return input.repositoryOverride.create({
      organization_id: organizationId,
      plan_id: input.planId,
      billing_cycle: input.billingCycle,
      status: input.status,
      current_period_start: input.currentPeriodStart,
      current_period_end: input.currentPeriodEnd,
      provider: 'stripe',
      provider_subscription_id: input.providerSubscriptionId,
      ...(input.providerCustomerId !== null
        ? { provider_customer_id: input.providerCustomerId }
        : {}),
      last_stripe_event_created_at: input.stripeEventCreatedAt,
    });
  }

  /**
   * Insert a terminal CANCELED tombstone row for a Stripe
   * `customer.subscription.deleted` event whose local subscription row never
   * existed (audit-#1).
   *
   * @remarks
   * - **Algorithm:** resolves the internal organization id from the active
   *   webhook RLS context (set by the tenancy resolver before dispatch), then
   *   inserts a `CANCELED` row keyed by `provider_subscription_id` with the
   *   deletion event's `created` timestamp stamped on `last_stripe_event_created_at`.
   *   The partial unique index `idx_subscriptions_provider_subscription_id_unique`
   *   plus the terminal-status guard in {@link syncFromStripeProviderSubscription}
   *   then make any later out-of-order `.created` / `.updated` for the same id a
   *   no-op, closing the resurrection gap.
   * - **Failure modes:** returns `null` when the organization cannot be resolved
   *   (defensive — the tenancy resolver already throws earlier) so the caller can
   *   fall back to a retryable error instead of silently advancing the ledger. A
   *   concurrent insert that loses the `provider_subscription_id` unique race
   *   surfaces as a Postgres unique violation; the caller catches it and treats
   *   the now-present row as the winner.
   * - **Side effects:** one INSERT into `billing.subscriptions`.
   */
  async insertCanceledTombstoneFromStripeWebhookEvent(input: {
    providerSubscriptionId: string;
    providerCustomerId: string | null;
    planId: number;
    billingCycle: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    canceledAt: Date;
    stripeEventCreatedAt: Date;
    repositoryOverride: SubscriptionRepository;
  }) {
    const organizationId = await input.repositoryOverride.findOrganizationIdFromCurrentContext();
    if (organizationId === null) {
      return null;
    }
    return input.repositoryOverride.create({
      organization_id: organizationId,
      plan_id: input.planId,
      billing_cycle: input.billingCycle,
      status: 'CANCELED',
      canceled_at: input.canceledAt,
      cancel_at_period_end: false,
      current_period_start: input.currentPeriodStart,
      current_period_end: input.currentPeriodEnd,
      provider: 'stripe',
      provider_subscription_id: input.providerSubscriptionId,
      ...(input.providerCustomerId !== null
        ? { provider_customer_id: input.providerCustomerId }
        : {}),
      last_stripe_event_created_at: input.stripeEventCreatedAt,
    });
  }

  async list(scope: OrganizationPrincipalDatabaseScope) {
    const organization_public_id = scope.organizationPublicId;
    return withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationByPublicId(organization_public_id);
      const rows = await this.repository.listByOrganization(organization.id);
      // REQ-4: enrich each row with seats_total / seats_used (cross-domain membership count).
      return this.decorateWithSeatCounts(organization_public_id, rows);
    });
  }

  async get(scope: OrganizationPrincipalDatabaseScope, subscription_public_id: string) {
    const organization_public_id = scope.organizationPublicId;
    return withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationByPublicId(organization_public_id);
      const subscription = await this.repository.findByPublicId(
        subscription_public_id,
        organization.id,
      );
      if (!subscription) throw new NotFoundError('Subscription');
      // REQ-4: attach seats_total / seats_used to the single subscription.
      const [decorated] = await this.decorateWithSeatCounts(organization_public_id, [subscription]);
      return decorated!;
    });
  }

  /**
   * Returns the Stripe PaymentIntent `client_secret` for an INCOMPLETE subscription so the
   * frontend can confirm the first payment. Stripe network I/O runs outside RLS context.
   */
  async getPaymentSetup(scope: OrganizationPrincipalDatabaseScope, subscription_public_id: string) {
    const organization_public_id = scope.organizationPublicId;
    const providerSubscriptionId = await withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationByPublicId(organization_public_id);
      const subscription = await this.repository.findByPublicId(
        subscription_public_id,
        organization.id,
      );
      if (!subscription) throw new NotFoundError('Subscription');
      if (subscription.status !== 'INCOMPLETE') {
        return null;
      }
      return subscription.provider_subscription_id ?? null;
    });

    if (!providerSubscriptionId) {
      return { client_secret: null as string | null };
    }

    const { isStripeConfigured, retrieveStripeSubscriptionPaymentClientSecret } = await import(
      '@/infrastructure/payment/stripe.client.js'
    );
    if (!isStripeConfigured()) {
      return { client_secret: null };
    }

    const client_secret =
      await retrieveStripeSubscriptionPaymentClientSecret(providerSubscriptionId);
    return { client_secret };
  }

  async create(
    scope: OrganizationPrincipalDatabaseScope,
    body: unknown,
    created_by_user_public_id: string | undefined,
    idempotencyKey?: string,
  ) {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateCreateSubscription(body);
    // B4: serialize concurrent creates for one org across the pre-check → Stripe create → insert
    // window so two requests with distinct idempotency keys cannot each mint a Stripe subscription
    // (the loser was previously compensated via cancel). The partial unique index + compensating
    // cancel below remain the durable correctness backstop if the lock ever lapses.
    const runCreate = async () => {
      const { organization, plan, createdByUserInternalId } = await withPrincipalDatabaseContext(
        scope,
        async () => {
          const organization =
            await this.organizationService.requireOrganizationByPublicId(organization_public_id);
          // Personal organizations cannot manage billing (assertTeamOrganization → 422).
          // Reject before the Stripe call so a personal org gets 422, not a churned provider call.
          assertTeamOrganization(organization, 'BILLING');
          // Reject before the Stripe call when a non-terminal subscription already
          // exists, so a duplicate request never churns the payment provider.
          const existingActive = await this.repository.findActiveByOrganization(organization.id);
          if (existingActive) {
            throw new ConflictError('errors:subscriptionAlreadyExists');
          }
          const plan = await this.planService.requireActivePlanByPublicId(parsed.plan_id);
          const createdByUserInternalId =
            await this.organizationService.resolveUserInternalIdByPublicId(
              created_by_user_public_id,
            );
          return { organization, plan, createdByUserInternalId };
        },
      );

      const now = new Date();
      // addMonths clamps month-end dates (Jan 31 + 1mo → Feb 28/29, not Mar 3) instead of the raw
      // Date.setMonth overflow. For Stripe-backed subs the webhook overwrites this with the
      // authoritative period end; for local-only subs this is the persisted value.
      const periodEnd = addMonths(now, parsed.billing_cycle === 'yearly' ? 12 : 1);

      // Stripe network call — outside any database context.
      const paymentResult = await this.paymentProvider.createSubscription(
        omitUndefined({
          organization,
          plan,
          billingCycle: parsed.billing_cycle,
          // audit #3: namespace the client key by org before it reaches Stripe's global key space.
          idempotencyKey: buildStripeIdempotencyKey(
            'sub-create',
            organization_public_id,
            idempotencyKey,
          ),
        }),
      );

      try {
        const created = await withPrincipalDatabaseContext(scope, async () =>
          this.repository.create(
            omitUndefined({
              organization_id: organization.id,
              plan_id: plan.id,
              billing_cycle: parsed.billing_cycle.toUpperCase() as 'MONTHLY' | 'YEARLY',
              // audit-#2: a Stripe-backed subscription is created with
              // `payment_behavior: 'default_incomplete'`, i.e. Stripe status
              // `incomplete` with NO successful payment yet. Persist the local row
              // as INCOMPLETE so entitlement never over-reports as TRIALING (an
              // entitled state) before the first `customer.subscription.updated`
              // webhook reconciles the real status. Local-only subscriptions (no
              // Stripe) keep the repository's TRIALING default.
              status: paymentResult.providerSubscriptionId ? 'INCOMPLETE' : undefined,
              current_period_start: now,
              current_period_end: periodEnd,
              created_by_user_id: createdByUserInternalId ?? undefined,
              provider: paymentResult.providerSubscriptionId ? 'stripe' : undefined,
              provider_subscription_id: paymentResult.providerSubscriptionId,
              provider_customer_id: paymentResult.providerCustomerId,
              // sec-B2: stamp the watermark when Stripe accepted the subscription so a
              // late-arriving `customer.subscription.created` event (whose `created`
              // timestamp predates this moment) is filtered by the monotonic guard and
              // cannot regress the row to a stale earlier state. Unset when Stripe is
              // not configured (no webhook to reconcile, no watermark needed).
              last_stripe_event_created_at: paymentResult.providerSubscriptionId
                ? new Date()
                : undefined,
            }),
          ),
        );
        // REQ-4: a freshly-created subscription has no Stripe-synced `seats` yet, so seats_total
        // falls back to the plan's included_seats; seats_used reflects current memberships.
        const [decorated] = await this.decorateWithSeatCounts(organization_public_id, [created]);
        return decorated!;
      } catch (error) {
        if (paymentResult.providerSubscriptionId) {
          await this.paymentProvider.compensateFailedCreate(paymentResult.providerSubscriptionId);
        }
        // A concurrent create that lost the race to the partial unique index
        // surfaces as a 409 instead of a 500 (the Stripe sub is already rolled back above).
        if (isPostgresUniqueViolation(error)) {
          throw new ConflictError('errors:subscriptionAlreadyExists');
        }
        throw error;
      }
    };

    try {
      return await withRedisLock(
        {
          key: `billing:subscription:create:${organization_public_id}`,
          ttlSeconds: SUBSCRIPTION_CREATE_LOCK_TTL_SECONDS,
          waitTimeoutMs: SUBSCRIPTION_CREATE_LOCK_WAIT_MS,
        },
        runCreate,
      );
    } catch (error) {
      if (error instanceof RedisLockUnavailableError) {
        // A concurrent create for this org held the lock past our wait — return a retryable 409
        // instead of minting a second Stripe subscription. By the time the wait elapses the winner
        // has usually committed, so a retry gets a clean `subscriptionAlreadyExists`.
        throw new ConflictError('errors:subscriptionCreateInProgress').withReason(
          'subscription_create_in_progress',
        );
      }
      throw error;
    }
  }

  async update(
    scope: OrganizationPrincipalDatabaseScope,
    subscription_public_id: string,
    body: unknown,
  ) {
    const organization_public_id = scope.organizationPublicId;
    // sec-B1: validateUpdateSubscription enforces an empty-body DTO. Any client trying to
    // PATCH `cancel_at_period_end` (or other billing-state fields) is rejected with 422
    // and must use the dedicated /cancel and /resume routes (which DO call Stripe).
    validateUpdateSubscription(body);
    const existing = await withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationByPublicId(organization_public_id);
      const found = await this.repository.findByPublicId(subscription_public_id, organization.id);
      if (!found) throw new NotFoundError('Subscription');
      return found;
    });
    // REQ-4: keep the response shape consistent with list/get/create.
    const [decorated] = await this.decorateWithSeatCounts(organization_public_id, [existing]);
    return decorated!;
  }

  /**
   * F2: brings the org's active headcount within the new plan's seat allowance by auto-suspending
   * the most-recently-joined non-owner members (the owner is never suspended), AFTER the plan change
   * has committed.
   *
   * @remarks
   * - **Algorithm:** delegates to the tenancy seat port's `suspendExcessActiveMembersToFitCeiling`,
   *   which suspends `activeCount - ceiling` non-owner ACTIVE members ordered by `joined_at DESC`.
   * - **Failure modes:** **best-effort** — a suspend failure is logged but never rethrown, because
   *   the plan change is already committed; throwing here would trip the Stripe-compensation catch
   *   and roll back the *price* while leaving the local plan changed (divergence). The add-member
   *   ceiling check still blocks further growth until the org is back within its allowance.
   * - **Side effects:** flips excess memberships to `SUSPENDED`. No-op when the new plan grants
   *   unlimited seats (`included_seats === null`) or the port is unwired (worker/test harnesses).
   * - **Notes:** suspended members re-consume a seat on reactivation and are re-checked against the
   *   ceiling (the F1 guard), so they can be restored after an upgrade.
   */
  private async suspendExcessMembersForDowngrade(
    organizationPublicId: string,
    newPlan: { included_seats: number | null },
  ): Promise<void> {
    if (
      newPlan.included_seats === null ||
      !this.membershipSeatUsage?.suspendExcessActiveMembersToFitCeiling
    ) {
      return;
    }
    try {
      const suspended = await this.membershipSeatUsage.suspendExcessActiveMembersToFitCeiling({
        organizationPublicId,
        ceiling: newPlan.included_seats,
      });
      if (suspended > 0) {
        logger.info(
          { organizationPublicId, ceiling: newPlan.included_seats, suspended },
          'billing.changePlan.members_suspended',
        );
      }
    } catch (error) {
      logger.error(
        { organizationPublicId, ceiling: newPlan.included_seats, error },
        'billing.changePlan.suspend_excess_failed',
      );
    }
  }

  async changePlan(
    scope: OrganizationPrincipalDatabaseScope,
    subscription_public_id: string,
    body: unknown,
    idempotencyKey?: string,
  ) {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateChangePlan(body);
    const { organization, plan, subscription, previousPlan } = await withPrincipalDatabaseContext(
      scope,
      async () => {
        const organization =
          await this.organizationService.requireOrganizationByPublicId(organization_public_id);
        // Personal organizations cannot manage billing — reject before the subscription
        // lookup so a personal org gets 422 (capability unavailable), not 404.
        assertTeamOrganization(organization, 'BILLING');
        const plan = await this.planService.requireActivePlanByPublicId(parsed.plan_id);
        const subscription = await this.repository.findByPublicId(
          subscription_public_id,
          organization.id,
        );
        if (!subscription) throw new NotFoundError('Subscription');
        // sec-new-B1: terminal subscriptions cannot have their plan changed
        if (TERMINAL_STATUSES.has(subscription.status)) {
          throw new UnprocessableEntityError('errors:subscriptionNotMutable');
        }
        const previousPlan = await this.planService.requirePlanRecordByInternalId(
          subscription.plan_id,
        );
        return { organization, plan, subscription, previousPlan };
      },
    );

    const providerPriceId = this.paymentProvider.getProviderPriceId(
      plan,
      subscription.billing_cycle === 'YEARLY' ? 'yearly' : 'monthly',
    );
    let providerPlanUpdated = false;

    // audit H2: fail closed before any local write when a Stripe-backed subscription
    // would change to a plan with no Stripe price for its cycle (extracted to keep
    // changePlan's cognitive complexity within budget).
    assertProviderPriceForStripeBackedPlanChange(
      subscription.provider_subscription_id,
      providerPriceId,
    );

    // Stripe network call — outside any database context. Fail-closed: a provider
    // failure throws ServiceUnavailableError here (before any local write), so the
    // local plan never silently diverges from Stripe. Local-only subscriptions
    // (no provider_subscription_id or no mapped price) skip the call and proceed.
    if (subscription.provider_subscription_id && providerPriceId) {
      await this.paymentProvider.updateSubscriptionPrice(
        subscription.provider_subscription_id,
        providerPriceId,
        buildStripeIdempotencyKey('sub-change-plan', organization_public_id, idempotencyKey),
      );
      providerPlanUpdated = true;
    }

    const periodStart = new Date(subscription.current_period_start);
    const periodEnd = new Date(subscription.current_period_end);
    try {
      const updated = await withPrincipalDatabaseContext(scope, async () =>
        this.repository.update(subscription_public_id, organization.id, {
          plan_id: plan.id,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          // sec-B3: stamp the watermark so a stale `customer.subscription.updated` event
          // delivered after this HTTP mutation cannot regress the plan back to its prior
          // price (the webhook guard accepts an event only when its `created` > watermark).
          last_stripe_event_created_at: new Date(),
        }),
      );
      if (!updated) throw new NotFoundError('Subscription');
      // F2: the plan change is now committed, so the new ceiling is in effect. Auto-suspend the
      // most-recently-joined non-owner members down to the new allowance (best-effort; never rolls
      // back the committed plan change). Runs before the Stripe quantity sync so it reconciles to the
      // post-suspension headcount.
      await this.suspendExcessMembersForDowngrade(organization_public_id, plan);
      // REQ-4: a plan change can change the seat allowance and proration, so reconcile the
      // Stripe subscription quantity to the current member count out-of-band (never inline —
      // a Stripe outage must not fail the plan change). No-op for local-only subscriptions.
      this.enqueueSeatQuantitySync(organization_public_id, idempotencyKey);
      const [decorated] = await this.decorateWithSeatCounts(organization_public_id, [updated]);
      return decorated!;
    } catch (error) {
      if (providerPlanUpdated && subscription.provider_subscription_id) {
        const previousProviderPriceId = this.paymentProvider.getProviderPriceId(
          previousPlan,
          subscription.billing_cycle === 'YEARLY' ? 'yearly' : 'monthly',
        );
        if (previousProviderPriceId) {
          await this.paymentProvider.compensatePlanChange(
            subscription.provider_subscription_id,
            previousProviderPriceId,
          );
        }
      }
      throw error;
    }
  }

  async cancel(
    scope: OrganizationPrincipalDatabaseScope,
    subscription_public_id: string,
    idempotencyKey?: string,
  ) {
    const organization_public_id = scope.organizationPublicId;
    const { organization, subscription } = await withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationByPublicId(organization_public_id);
      // Personal organizations cannot manage billing — reject before the subscription
      // lookup so a personal org gets 422 (capability unavailable), not 404.
      assertTeamOrganization(organization, 'BILLING');
      const subscription = await this.repository.findByPublicId(
        subscription_public_id,
        organization.id,
      );
      if (!subscription) throw new NotFoundError('Subscription');
      // sec-new-B1: terminal subscriptions cannot be canceled (they are already non-billable)
      if (TERMINAL_STATUSES.has(subscription.status)) {
        throw new UnprocessableEntityError('errors:subscriptionNotMutable');
      }
      return { organization, subscription };
    });

    // reaudit-#6: a never-activated INCOMPLETE subscription has no active period, so
    // `cancel_at_period_end` is a no-op and the row would keep occupying the org's single
    // subscription slot until a Stripe `incomplete_expired` webhook arrives — if that webhook
    // never lands, the org is permanently locked out of re-subscribing. Cancel it immediately
    // (at Stripe and locally) so the slot is freed now, giving a programmatic exit.
    if (subscription.status === 'INCOMPLETE') {
      if (subscription.provider_subscription_id) {
        await this.paymentProvider.cancelSubscriptionImmediately(
          subscription.provider_subscription_id,
          buildStripeIdempotencyKey('sub-cancel-now', organization_public_id, idempotencyKey),
        );
      }
      const canceled = await withPrincipalDatabaseContext(scope, async () =>
        this.repository.update(subscription_public_id, organization.id, {
          status: 'CANCELED',
          canceled_at: new Date(),
          last_stripe_event_created_at: new Date(),
        }),
      );
      if (!canceled) throw new NotFoundError('Subscription');
      const [decoratedCanceled] = await this.decorateWithSeatCounts(organization_public_id, [
        canceled,
      ]);
      return decoratedCanceled!;
    }

    // Stripe network call — outside any database context.
    if (subscription.provider_subscription_id) {
      await this.paymentProvider.cancelSubscriptionAtPeriodEnd(
        subscription.provider_subscription_id,
        buildStripeIdempotencyKey('sub-cancel', organization_public_id, idempotencyKey),
      );
    }

    const updated = await withPrincipalDatabaseContext(scope, async () =>
      this.repository.update(subscription_public_id, organization.id, {
        cancel_at_period_end: true,
        // sec-B3: stamp the watermark so a stale Stripe `updated` event arriving later
        // cannot regress `cancel_at_period_end` back to false and silently resume billing.
        last_stripe_event_created_at: new Date(),
      }),
    );
    if (!updated) throw new NotFoundError('Subscription');
    const [decorated] = await this.decorateWithSeatCounts(organization_public_id, [updated]);
    return decorated!;
  }

  /**
   * Immediately cancels the organization's active subscription as part of organization offboarding
   * (route-audit-#2). Idempotent: a no-op when there is no active subscription.
   *
   * @remarks
   * - **Algorithm:** resolve the org + its active subscription; if one exists, cancel it at Stripe
   *   NOW (not at period end — the org is going away) and set the local row `CANCELED`.
   * - **Failure modes:** a Stripe outage throws `ServiceUnavailableError` (propagated), so the
   *   caller's organization delete aborts rather than soft-deleting an org that keeps billing.
   * - **Side effects:** Stripe cancel + a local `subscriptions` update.
   * - **Notes:** deleting an org previously left its subscription billing forever — no offboarding
   *   path touched billing. Re-running after a partial failure finds no active sub → no-op.
   */
  async cancelActiveForOrganizationOffboarding(organization_public_id: string): Promise<void> {
    const { organization, subscription } = await withPrincipalDatabaseContext(
      resolveVerifiedPrincipalScope({ organizationPublicId: organization_public_id }),
      async () => {
        const organization =
          await this.organizationService.requireOrganizationByPublicId(organization_public_id);
        const subscription = await this.repository.findActiveByOrganization(organization.id);
        return { organization, subscription };
      },
    );
    if (!subscription) return;

    // Stripe network call — outside any database context.
    if (subscription.provider_subscription_id) {
      // audit L1: stamp a deterministic idempotency key so an org-delete retry
      // re-issues the SAME cancel (Stripe dedups) instead of an un-keyed duplicate.
      // No client key exists on the offboarding path, so the provider subscription
      // id is the stable per-subscription discriminator.
      await this.paymentProvider.cancelSubscriptionImmediately(
        subscription.provider_subscription_id,
        buildStripeIdempotencyKey(
          'sub-cancel-offboarding',
          organization_public_id,
          subscription.provider_subscription_id,
        ),
      );
    }
    await withPrincipalDatabaseContext(
      resolveVerifiedPrincipalScope({ organizationPublicId: organization_public_id }),
      async () =>
        this.repository.update(subscription.public_id, organization.id, {
          status: 'CANCELED',
          canceled_at: new Date(),
          last_stripe_event_created_at: new Date(),
        }),
    );
  }

  async resume(
    scope: OrganizationPrincipalDatabaseScope,
    subscription_public_id: string,
    idempotencyKey?: string,
  ) {
    const organization_public_id = scope.organizationPublicId;
    const { organization, subscription } = await withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationByPublicId(organization_public_id);
      // Personal organizations cannot manage billing — reject before the subscription
      // lookup so a personal org gets 422 (capability unavailable), not 404.
      assertTeamOrganization(organization, 'BILLING');
      const subscription = await this.repository.findByPublicId(
        subscription_public_id,
        organization.id,
      );
      if (!subscription) throw new NotFoundError('Subscription');
      // sec-new-B1: terminal subscriptions cannot be resumed (already non-billable)
      if (TERMINAL_STATUSES.has(subscription.status)) {
        throw new UnprocessableEntityError('errors:subscriptionNotMutable');
      }
      return { organization, subscription };
    });

    // Stripe network call — outside any database context.
    if (subscription.provider_subscription_id) {
      await this.paymentProvider.resumeSubscription(
        subscription.provider_subscription_id,
        buildStripeIdempotencyKey('sub-resume', organization_public_id, idempotencyKey),
      );
    }

    const updated = await withPrincipalDatabaseContext(scope, async () =>
      this.repository.update(subscription_public_id, organization.id, {
        cancel_at_period_end: false,
        // sec-B4: do NOT force-write `status: 'ACTIVE'`. The Stripe webhook is the source
        // of truth for status — the real value may be PAST_DUE (failed payment) or
        // INCOMPLETE (3DS pending), and forcing ACTIVE here grants a transient
        // entitlement window before the follow-up `customer.subscription.updated` event
        // reconciles. The local row now only flips the cancel toggle.
        //
        // sec-B3: stamp the watermark so a stale Stripe `updated` event arriving later
        // (e.g. delayed from the cancel that we are reversing) cannot re-set
        // `cancel_at_period_end` back to true.
        last_stripe_event_created_at: new Date(),
      }),
    );
    if (!updated) throw new NotFoundError('Subscription');
    const [decorated] = await this.decorateWithSeatCounts(organization_public_id, [updated]);
    return decorated!;
  }

  /**
   * Lists Stripe invoices for the organization's billing customer, one cursor page at a time.
   *
   * @remarks
   * - **Algorithm:** validates the cursor query (`limit` ≤ 100, `after` = a Stripe invoice id),
   *   fetches one Stripe page via `starting_after` + `limit`, and returns the standard list envelope
   *   (`items`/`limit`/`has_more`/`next_cursor`). The next cursor is the last row's Stripe id when
   *   Stripe reports `has_more`; `total` is always `null` (Stripe exposes no count).
   * - **Notes:** returns an empty page when Stripe is not configured or the org has no provider
   *   customer yet. Invoices live in Stripe, not our DB — this is a cursor passthrough, not a keyset
   *   query, so it does not use the DB list helpers.
   */
  async listInvoices(scope: OrganizationPrincipalDatabaseScope, query: unknown) {
    const parsed = validateListInvoicesQuery(query);
    // `limit` is optional in the DTO (kept optional in OpenAPI) — apply the shared default here.
    const limit = parsed.limit ?? PAGINATION.DEFAULT_LIMIT;
    const emptyPage = {
      items: [] as ReturnType<typeof BillingAccountSerializer.invoices>,
      total: null,
      limit,
      has_more: false,
      next_cursor: null as string | null,
    };
    const customerId = await this.resolveStripeCustomerId(scope);
    if (!(customerId && isStripeConfigured())) {
      return emptyPage;
    }
    const page = await listStripeInvoices(customerId, {
      limit,
      ...(parsed.after ? { startingAfter: parsed.after } : {}),
    });
    const items = BillingAccountSerializer.invoices(page.data);
    const lastItem = items.at(-1);
    return {
      items,
      total: null,
      limit,
      has_more: page.has_more,
      next_cursor: page.has_more ? (lastItem?.id ?? null) : null,
    };
  }

  /**
   * Lists card payment methods on the organization's Stripe customer.
   */
  async listPaymentMethods(scope: OrganizationPrincipalDatabaseScope) {
    const customerId = await this.resolveStripeCustomerId(scope);
    if (!(customerId && isStripeConfigured())) {
      return [];
    }
    const [methods, defaultId] = await Promise.all([
      listStripePaymentMethods(customerId),
      retrieveStripeCustomerDefaultPaymentMethodId(customerId),
    ]);
    return BillingAccountSerializer.paymentMethods(methods, defaultId);
  }

  /**
   * Creates a SetupIntent `client_secret` so the frontend can add a card in-app.
   */
  async createPaymentMethodSetup(
    scope: OrganizationPrincipalDatabaseScope,
    idempotencyKey?: string,
  ) {
    const organization_public_id = scope.organizationPublicId;
    const customerId = await this.resolveStripeCustomerId(scope);
    if (!customerId) {
      throw new UnprocessableEntityError('errors:subscriptionNotMutable');
    }
    if (!isStripeConfigured()) {
      return { client_secret: null as string | null };
    }
    const client_secret = await createStripeSetupIntent(
      customerId,
      omitUndefined({
        idempotencyKey: idempotencyKey
          ? buildStripeIdempotencyKey('pm-setup', organization_public_id, idempotencyKey)
          : undefined,
      }),
    );
    return { client_secret };
  }

  /** Resolves the Stripe customer id from the org's active subscription row. */
  private async resolveStripeCustomerId(
    scope: OrganizationPrincipalDatabaseScope,
  ): Promise<string | null> {
    const organization_public_id = scope.organizationPublicId;
    return withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationByPublicId(organization_public_id);
      assertTeamOrganization(organization, 'BILLING');
      const subscription = await this.repository.findActiveByOrganization(organization.id);
      return subscription?.provider_customer_id ?? null;
    });
  }
}
