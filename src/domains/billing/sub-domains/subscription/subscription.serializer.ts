/**
 * Subscription row fields exposed to API consumers. Mirrors the live Drizzle row but with
 * the public-id rename baked in and every leak-class field excluded — see sec-T finding #17
 * and sec-re-07 (plan public id surfaced after the prior strip-only fix dropped the bigserial
 * plan reference with no substitute).
 */
interface SubscriptionRow {
  public_id: string;
  status: string;
  billing_cycle: string;
  current_period_start: Date | string;
  current_period_end: Date | string;
  trial_end: Date | string | null;
  cancel_at_period_end: boolean;
  canceled_at: Date | string | null;
  provider: string | null;
  /** Joined `billing.plans.public_id` — surfaced as `plan_id` in the response (sec-re-07). */
  plan_public_id: string | null;
  /**
   * REQ-4: total seats available on the subscription — `subscription.seats ?? plan.included_seats`,
   * or `null` when the plan grants unlimited seats. Computed by {@link SubscriptionService} and
   * attached to the row before serialization (the repository row carries the raw `seats` +
   * `plan_included_seats` that feed it).
   */
  seats_total: number | null;
  /**
   * REQ-4: seats currently consumed — the count of ACTIVE + INVITED memberships in the organization,
   * resolved cross-domain via the tenancy membership service. Computed by
   * {@link SubscriptionService}.
   */
  seats_used: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function serializeOne<T extends SubscriptionRow>(row: T) {
  return {
    // sec-T #17: emit the 21-char public_id, NOT the internal bigserial. The
    // bigserial `id`, the bigserial `organization_id`, the bigserial
    // `created_by_user_id` / `updated_by_user_id`, the Stripe-side
    // `provider_subscription_id` / `provider_customer_id`, and the internal
    // `last_stripe_event_created_at` watermark are all DROPPED — they leak
    // platform growth (sequential ids), correlate to Stripe customer activity
    // (Stripe SDKs treat `cus_*`/`sub_*` as private), and reveal worker
    // ordering state. Public consumers join on `public_id` only.
    id: row.public_id,
    status: row.status,
    billing_cycle: row.billing_cycle,
    current_period_start: toIsoString(row.current_period_start),
    current_period_end: toIsoString(row.current_period_end),
    trial_end: toIsoString(row.trial_end),
    cancel_at_period_end: row.cancel_at_period_end,
    canceled_at: toIsoString(row.canceled_at),
    // Provider is kept as a string literal (e.g. `"stripe"`) so callers can
    // route conditional UI without ever seeing the Stripe object ids.
    provider: row.provider,
    // sec-re-07: surface the joined `billing.plans.public_id` as the documented
    // `plan_id` public field. sec-T #17 correctly stripped the bigserial
    // plan_id, but left clients without ANY plan reference in the response —
    // ChangePlanDto round-trips that they could no longer verify against.
    // Defensive `?? null` keeps the contract stable when an unexpectedly
    // joined row carries `undefined`.
    plan_id: row.plan_public_id ?? null,
    // REQ-4: seat counters. `seats_total` is null for an unlimited plan; `seats_used` counts
    // ACTIVE + INVITED memberships so the FE can render "N of M seats used".
    seats_total: row.seats_total ?? null,
    seats_used: row.seats_used,
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
  };
}

/**
 * Strip-only response serializer for `billing.subscriptions` rows that drops every
 * internal bigserial, every Stripe-side id, and the watermark column before reaching
 * the client (sec-T finding #17 — replaces the prior identity passthrough).
 */
export const SubscriptionSerializer = {
  one(row: SubscriptionRow) {
    return serializeOne(row);
  },
  many(rows: readonly SubscriptionRow[]) {
    return rows.map((row) => serializeOne(row));
  },
};
