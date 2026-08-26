import { and, desc, eq, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { plans } from '@/domains/billing/sub-domains/plan/plan.schema.js';
import { databaseNowTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { resolveRepositoryDatabaseHandle } from '@/infrastructure/database/contexts/worker-database-guard.util.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/request-database.context.js';
import { assertWorkerDatabaseContext } from '@/infrastructure/database/contexts/worker-database.context.js';
import { DEFAULT_REPOSITORY_LIST_LIMIT } from '@/shared/constants/query-limits.constants.js';
import { capListWithWarning } from '@/shared/utils/infrastructure/list-cap.util.js';
import { subscriptions } from '@/domains/billing/sub-domains/subscription/subscription.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import type { SubscriptionCreateData, SubscriptionUpdateData } from './subscription.types.js';

/**
 * Subscription statuses that release the per-organization subscription slot.
 *
 * @remarks
 * A subscription in one of these states neither occupies the single-subscription
 * slot (so the org can create a fresh subscription) nor is mutable. This list is
 * the single source of truth shared by three call sites that must agree
 * (audit-#1): the `idx_subscriptions_org` partial-unique index predicate, the
 * {@link SubscriptionRepository.findActiveByOrganization} filter, and the
 * service-layer `TERMINAL_STATUSES` guard. `INCOMPLETE_EXPIRED` is included so an
 * abandoned-checkout subscription cannot permanently lock the organization out
 * of re-subscribing.
 */
export const INACTIVE_SUBSCRIPTION_STATUSES = ['CANCELED', 'INCOMPLETE_EXPIRED'] as const;

/**
 * Drizzle `select` projection that mirrors every {@link subscriptions} column and adds
 * the joined `billing.plans.public_id` as `plan_public_id` so the response serializer
 * (sec-re-07) can surface a stable public plan reference without leaking the bigserial
 * `plan_id` (which sec-T #17 correctly strips).
 */
const subscriptionRowWithPlanPublicId = {
  id: subscriptions.id,
  public_id: subscriptions.public_id,
  organization_id: subscriptions.organization_id,
  plan_id: subscriptions.plan_id,
  status: subscriptions.status,
  billing_cycle: subscriptions.billing_cycle,
  // REQ-4: purchased seat quantity (synced from Stripe; NULL until first sync).
  seats: subscriptions.seats,
  current_period_start: subscriptions.current_period_start,
  current_period_end: subscriptions.current_period_end,
  trial_end: subscriptions.trial_end,
  cancel_at_period_end: subscriptions.cancel_at_period_end,
  canceled_at: subscriptions.canceled_at,
  provider: subscriptions.provider,
  provider_subscription_id: subscriptions.provider_subscription_id,
  provider_customer_id: subscriptions.provider_customer_id,
  created_at: subscriptions.created_at,
  updated_at: subscriptions.updated_at,
  created_by_user_id: subscriptions.created_by_user_id,
  updated_by_user_id: subscriptions.updated_by_user_id,
  last_stripe_event_created_at: subscriptions.last_stripe_event_created_at,
  plan_public_id: plans.public_id,
  // REQ-4: the joined plan's seat allowance — the fallback for seats_total when the
  // subscription has no Stripe-synced `seats` yet.
  plan_included_seats: plans.included_seats,
} as const;

/**
 * Drizzle access to the `billing.subscriptions` table — a **mutable state table**, not an
 * immutable append-only ledger (audit-#B2). Rows are updated in place as the subscription
 * transitions status (Stripe syncs, cancel/resume, plan changes, seat counts); they are never
 * hard-deleted in normal flow. DB-level append-only enforcement (as on `audit.logs`) is
 * intentionally NOT applied here because in-place status transitions are the table's core purpose —
 * immutability is scoped to the monotonic `last_stripe_event_created_at` watermark guard below,
 * which prevents stale/out-of-order events from regressing the row, not to the row as a whole.
 *
 * @remarks
 * - **Algorithm:** Each organization is constrained to a single *non-terminal*
 *   subscription row by the partial unique index `idx_subscriptions_org`
 *   (`UNIQUE(organization_id) WHERE status NOT IN ('CANCELED',
 *   'INCOMPLETE_EXPIRED')`), so a fresh subscription can be created once a prior
 *   one is canceled or an abandoned-checkout row expires (audit-#1). Stripe-driven
 *   writes
 *   ({@link syncFromStripeProviderSubscription},
 *   {@link markCanceledByProviderSubscriptionId}) gate the update on
 *   `last_stripe_event_created_at` being `NULL` or strictly older than the incoming
 *   event timestamp so out-of-order or same-second stale events are dropped. The
 *   in-place sync uses strict `<` while cancellation uses `<=`; this asymmetry is
 *   deliberate and makes a terminal cancel **deterministically win** a same-second
 *   in-place update regardless of delivery order (audit-#6, locked by test). Stripe
 *   `event.created` has 1-second resolution, so the residual theoretical edge — a
 *   genuine same-second cancel-then-reactivation — would require a monotonic event
 *   sequence (Stripe does not emit such a pair); tracked as a future hardening.
 * - **Failure modes:** Insert collisions on `public_id` are retried by
 *   {@link runInsertWithPublicIdentifierRetry}; updates that miss the
 *   timestamp guard return `null` to the caller so the worker can log a stale
 *   event instead of writing.
 * - **Side effects:** Writes the `subscriptions` table only; all queries run
 *   under either an organization RLS context (HTTP) or a worker-supplied
 *   handle from {@link createWorkerSubscriptionRepository}.
 * - **Notes:** Tenant isolation is enforced by both the WHERE clauses and the
 *   `subscriptions_tenant_isolation` RLS policy on the table.
 */
export class SubscriptionRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  async listByOrganization(organization_id: number, limit = DEFAULT_REPOSITORY_LIST_LIMIT) {
    // Fetch one extra row so a hit on the cap is observable instead of a silent truncation.
    // sec-re-07: left-join plans so the serializer can surface plan_public_id as the
    // documented public `plan_id` field without leaking the bigserial.
    const rows = await this.db()
      .select(subscriptionRowWithPlanPublicId)
      .from(subscriptions)
      .leftJoin(plans, eq(subscriptions.plan_id, plans.id))
      .where(eq(subscriptions.organization_id, organization_id))
      // audit #37: deterministic order so the cap truncates the OLDEST rows, not an arbitrary set,
      // if an org ever exceeds the cap (churned CANCELED history).
      .orderBy(desc(subscriptions.created_at), desc(subscriptions.id))
      .limit(limit + 1);
    return capListWithWarning({
      rows,
      limit,
      resource: 'billing.subscriptions',
      context: { organizationId: organization_id },
    });
  }

  async findActiveByOrganization(organization_id: number) {
    // sec-re-07: join plans for `plan_public_id` (see listByOrganization).
    const rows = await this.db()
      .select(subscriptionRowWithPlanPublicId)
      .from(subscriptions)
      .leftJoin(plans, eq(subscriptions.plan_id, plans.id))
      .where(
        and(
          eq(subscriptions.organization_id, organization_id),
          // audit-#1: exclude every slot-releasing status (CANCELED AND
          // INCOMPLETE_EXPIRED), kept in lockstep with the idx_subscriptions_org
          // partial-unique predicate so an abandoned-checkout row does not block
          // re-subscription.
          notInArray(subscriptions.status, [...INACTIVE_SUBSCRIPTION_STATUSES]),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Resolves the org's active subscription seat allowance while holding a row lock (REQ-4).
   *
   * @remarks
   * - **Algorithm:** two queries in the caller's transaction: (1) `SELECT ... FOR UPDATE` on the
   *   active (non-terminal) `subscriptions` row alone — NO join, because Postgres rejects
   *   `FOR UPDATE` against the nullable side of an outer join (`42601`) — so a concurrent member-add
   *   blocks on this row until the caller's seat check + membership insert commit, closing the
   *   two-concurrent-adds-exceed-the-limit race. (2) a plain (unlocked) lookup of the plan's
   *   `included_seats` (a global catalog row that must NOT be locked). Returns the per-subscription
   *   `seats` (purchased from Stripe) and `plan_included_seats` so the caller computes
   *   `seats_total = seats ?? included_seats ?? null` (null = unlimited).
   * - **Failure modes:** returns `null` when the org has no active subscription (the seat check is
   *   then a no-op — the billing-free flow still works).
   * - **Side effects:** acquires a row-level `FOR UPDATE` lock released at the enclosing
   *   transaction's COMMIT/ROLLBACK; the caller MUST run inside a transaction for the lock to span
   *   the subsequent insert.
   */
  async findActiveSeatStateByOrganizationForUpdate(organization_id: number): Promise<{
    seats: number | null;
    plan_included_seats: number | null;
    status: string;
    current_period_end: Date;
  } | null> {
    const lockedRows = await this.db()
      .select({
        seats: subscriptions.seats,
        plan_id: subscriptions.plan_id,
        status: subscriptions.status,
        current_period_end: subscriptions.current_period_end,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.organization_id, organization_id),
          notInArray(subscriptions.status, [...INACTIVE_SUBSCRIPTION_STATUSES]),
        ),
      )
      .limit(1)
      .for('update');
    const locked = lockedRows[0];
    if (!locked) return null;
    // Plan is a global catalog row — read its seat allowance WITHOUT a lock.
    const planRows = await this.db()
      .select({ included_seats: plans.included_seats })
      .from(plans)
      .where(eq(plans.id, locked.plan_id))
      .limit(1);
    return {
      seats: locked.seats,
      plan_included_seats: planRows[0]?.included_seats ?? null,
      status: locked.status,
      current_period_end: locked.current_period_end,
    };
  }

  async findByPublicId(public_id: string, organization_id: number) {
    // sec-re-07: join plans for `plan_public_id` (see listByOrganization).
    const rows = await this.db()
      .select(subscriptionRowWithPlanPublicId)
      .from(subscriptions)
      .leftJoin(plans, eq(subscriptions.plan_id, plans.id))
      .where(
        and(
          eq(subscriptions.public_id, public_id),
          eq(subscriptions.organization_id, organization_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Resolves the internal organization id from the active webhook RLS context.
   * Used by the sec-B9 fallback INSERT path so it does not have to take an
   * `OrganizationService` dependency just to map the public id baked into the
   * GUC by `runStripeWebhookHandlerWithOrganizationContext`.
   */
  async findOrganizationIdFromCurrentContext(): Promise<number | null> {
    const rows = await this.db()
      .select({ id: organizations.id })
      .from(organizations)
      .where(sql`${organizations.public_id} = current_setting('app.current_organization_id', true)`)
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async create(data: SubscriptionCreateData) {
    const inserted = await runInsertWithPublicIdentifierRetry(async () => {
      const public_id = generatePublicId('subscription');
      const rows = await this.db()
        .insert(subscriptions)
        .values({
          public_id,
          organization_id: data.organization_id,
          plan_id: data.plan_id,
          billing_cycle: data.billing_cycle,
          status: data.status ?? 'TRIALING',
          current_period_start: data.current_period_start,
          current_period_end: data.current_period_end,
          trial_end: data.trial_end,
          // audit-#1: the deletion-tombstone path persists a terminal CANCELED row
          // (with canceled_at / cancel_at_period_end) so a later out-of-order
          // `customer.subscription.created` cannot resurrect it. Every other path
          // leaves these at their column defaults (NULL / false).
          canceled_at: data.canceled_at,
          cancel_at_period_end: data.cancel_at_period_end,
          provider: data.provider,
          provider_subscription_id: data.provider_subscription_id,
          provider_customer_id: data.provider_customer_id,
          created_by_user_id: data.created_by_user_id,
          last_stripe_event_created_at: data.last_stripe_event_created_at,
        })
        .returning();
      return rows[0]!;
    });
    // sec-re-07: re-select with the plans join so the returned row carries
    // plan_public_id for the HTTP serializer. The follow-up SELECT runs inside
    // the same caller-supplied context (organization for HTTP, worker handle
    // for the webhook fallback path) so RLS still applies — a successful
    // INSERT in this context is guaranteed visible to the same context's
    // SELECT, so a missing row would mean a bug elsewhere (and we'd rather
    // surface that loudly than return a row that's silently missing
    // plan_public_id).
    const joined = await this.findByPublicId(inserted.public_id, data.organization_id);
    if (!joined) {
      throw new Error(
        `subscription.create: row ${inserted.public_id} not visible after insert (context/RLS mismatch?)`,
      );
    }
    return joined;
  }

  async update(public_id: string, organization_id: number, data: SubscriptionUpdateData) {
    const rows = await this.db()
      .update(subscriptions)
      .set({
        ...data,
        updated_at: databaseNowTimestamp,
      })
      .where(
        and(
          eq(subscriptions.public_id, public_id),
          eq(subscriptions.organization_id, organization_id),
          // Terminal subscriptions are immutable. Refuse to mutate a CANCELED / INCOMPLETE_EXPIRED
          // row even if a concurrent webhook moved it there AFTER the service's TERMINAL_STATUSES
          // read-check — a compare-and-set that closes the terminal-guard TOCTOU (route-audit B6).
          notInArray(subscriptions.status, [...INACTIVE_SUBSCRIPTION_STATUSES]),
        ),
      )
      .returning({ id: subscriptions.id });
    if (rows.length === 0) return null;
    // sec-re-07: re-select with the plans join so the HTTP response carries
    // plan_public_id. The two-step (UPDATE then SELECT) runs inside the
    // caller's existing RLS context so the SELECT can never see a row
    // outside the org.
    return this.findByPublicId(public_id, organization_id);
  }

  /**
   * Returns true when a local row already exists for `provider_subscription_id` (regardless
   * of organization context — this is a system-level existence check). Used by the Stripe
   * webhook service to distinguish two failure modes of {@link syncFromStripeProviderSubscription}
   * returning null (sec-B finding #5):
   *   1. The row does not exist yet (Stripe outran our HTTP create — retryable race).
   *   2. The row exists but is at a newer watermark (stale event — no-op).
   *
   * Case 1 must throw so BullMQ retries until the race resolves; case 2 must silently skip.
   * The earlier code conflated the two and silently dropped both, which let an `updated`-
   * before-`created` reorder shadow newer state.
   */
  async existsByProviderSubscriptionId(provider_subscription_id: string): Promise<boolean> {
    const rows = await this.db()
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(eq(subscriptions.provider_subscription_id, provider_subscription_id))
      .limit(1);
    return rows.length > 0;
  }

  async syncFromStripeProviderSubscription(
    provider_subscription_id: string,
    data: SubscriptionUpdateData,
    stripe_event_created_at: Date,
  ) {
    const rows = await this.db()
      .update(subscriptions)
      .set({
        ...data,
        last_stripe_event_created_at: stripe_event_created_at,
        updated_at: databaseNowTimestamp,
      })
      .where(
        and(
          eq(subscriptions.provider_subscription_id, provider_subscription_id),
          // Never RESURRECT a locally-terminal subscription via an in-place `.updated` sync — only
          // the dedicated `.deleted` handler (markCanceled) writes terminal state. Without this, a
          // late `.updated` whose Stripe timestamp beats the wall-clock watermark stamped by an
          // offboarding / immediate-cancel could flip a CANCELED org's sub back to ACTIVE
          // (route-audit B5). A non-terminal Dashboard cancel (ACTIVE → CANCELED via `.updated`) is
          // unaffected: the guard checks the CURRENT row status, not the incoming one.
          notInArray(subscriptions.status, [...INACTIVE_SUBSCRIPTION_STATUSES]),
          or(
            isNull(subscriptions.last_stripe_event_created_at),
            lt(subscriptions.last_stripe_event_created_at, stripe_event_created_at),
          ),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async markCanceledByProviderSubscriptionId(
    provider_subscription_id: string,
    stripe_event_created_at: Date,
  ) {
    const rows = await this.db()
      .update(subscriptions)
      .set({
        status: 'CANCELED',
        canceled_at: new Date(),
        last_stripe_event_created_at: stripe_event_created_at,
        updated_at: databaseNowTimestamp,
      })
      .where(
        and(
          eq(subscriptions.provider_subscription_id, provider_subscription_id),
          or(
            isNull(subscriptions.last_stripe_event_created_at),
            lte(subscriptions.last_stripe_event_created_at, stripe_event_created_at),
          ),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }
}

/** Worker-only factory — requires an explicit handle from `withOrganizationDatabaseContext`. */
export function createWorkerSubscriptionRepository(
  databaseHandle: WorkerDatabaseHandle,
): SubscriptionRepository {
  assertWorkerDatabaseContext(['organization']);
  return new SubscriptionRepository(databaseHandle);
}
