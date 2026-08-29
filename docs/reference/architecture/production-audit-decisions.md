# Production-readiness audit — decisions & policies

This document records the **decisions** taken during the multi-round production-readiness audit
(security → operations → business-logic/concurrency → performance/data-integrity), so the rationale
behind each "we did / deliberately did not do X" is discoverable rather than living only in PR
history. It also specifies the **seat-entitlement policy** in full, since that policy spans the
`billing` and `tenancy` domains and is not obvious from either domain alone.

> Scope note: the security and concurrency fixes themselves are documented inline in the code
> (`sec-new-*`, `audit-*`, `reaudit-*` comment tags) and in the relevant domain docs. This file
> captures the **cross-cutting product/engineering decisions** and the entitlement model.

---

## 1. Seat-entitlement policy (billing × tenancy)

An organization's **seat ceiling** — the maximum number of seats it may consume (a seat is consumed by
each `ACTIVE` + `INVITED` membership) — is a function of its **billing entitlement**, not just its
current plan row. Three states were previously under-specified; the policy below closes them.

### 1.1 Seat-ceiling resolution

Resolved in `SubscriptionService.reserveSeatCeilingForMemberAdd`
(`src/domains/billing/sub-domains/subscription/subscription.service.ts`), under the active-subscription
`FOR UPDATE` row lock so it serializes against concurrent member adds. On the **free-tier / no-subscription
branch there is no subscription row to lock**, so `MembershipService.assertSeatAvailableForMemberAdd`
additionally takes a per-organization advisory xact lock (`RESOURCE_QUOTA_LOCK_NAMESPACE.MEMBERSHIP_SEAT`) before the
count+insert — audit-#M1. This closes a TOCTOU where two concurrent adds could both pass `used < ceiling`
and overshoot a free/entry plan with `included_seats > 1`; the cap no longer relies on the free ceiling
happening to be 1.

Seat-ceiling table by billing state:

| Org billing state | Seat ceiling |
| ----------------- | ------------ |
| Active entitlement — `ACTIVE` / `TRIALING` (or a dunning status still **within** grace) | purchased `seats` ?? plan `included_seats` (`null` ⇒ unlimited) |
| **No subscription** (never subscribed, or `CANCELED` / `INCOMPLETE_EXPIRED`) | **Free-tier ceiling** — the `included_seats` of the cheapest active plan (the "Free" plan) |
| **Dunning past grace** — `PAST_DUE` / `UNPAID` / `INCOMPLETE` and `now > current_period_end + BILLING_DUNNING_GRACE_DAYS` | **Free-tier ceiling** (entitlement lapses to free) |

- **F3 — unsubscribed organizations are capped at the Free tier** (decision: *cap at Free-tier seats*). Previously
  an organization with no active subscription resolved to `null` (unlimited), so a brand-new team organization or a
  canceled organization could add members without bound. It now resolves to the cheapest active plan's
  `included_seats`. Resolving "cheapest active plan" (rather than hard-coding a name/flag) means the
  floor entitlement tracks whatever the catalog's entry tier is.
- **F4 — dunning grace window** (decision: *grace window, then restrict*). A subscription in a dunning
  status keeps its full plan ceiling until `current_period_end + BILLING_DUNNING_GRACE_DAYS`, after
  which it falls to the Free-tier ceiling. This preserves the standard dunning UX (a failed payment
  does not instantly revoke collaborators) while preventing indefinite premium headcount on an unpaid
  subscription. Stripe's own dunning continues in parallel and eventually moves the subscription to
  `CANCELED`, at which point the "no subscription" row applies.
- `BILLING_DUNNING_GRACE_DAYS` — env knob, default **14** days.

### 1.2 Over-cap on downgrade — auto-suspend (decision: *auto-suspend excess members*)

When `changePlan` moves an organization to a plan whose `included_seats` is **below** its current active member
count, the **excess members are auto-suspended to fit the new ceiling** rather than the downgrade being
rejected (the previous F2 behavior was a `409 seat_limit_exceeded_for_plan` block).

- **Selection:** `ACTIVE`, non-owner memberships, ordered by `joined_at` **descending** (most-recently
  joined are suspended first; longest-tenured members are kept), limited to `activeCount - ceiling`.
- **Owner is never suspended** (`organizations.owner_user_id` is always excluded), so an organization can never
  lock itself out by downgrading.
- Suspension sets membership `status = 'SUSPENDED'`. A suspended seat is **not** counted toward the cap
  (consistent with the existing admin suspend/reactivate flow), so the organization immediately fits its new
  ceiling. Re-activating a suspended member re-consumes a seat and is re-checked against the ceiling
  (the F1 reactivation guard), so members can be restored after an upgrade.
- **Cross-domain wiring:** billing owns the plan change; the suspend is a `tenancy` write. To avoid a
  hard import cycle (tenancy's `MembershipService` already depends on billing for the seat check),
  billing calls it through the structural `MembershipSeatUsagePort` (the same port that exposes
  `countActiveMembers`), implemented by `MembershipService`. The suspend runs in the organization DB context +
  transaction so RLS and atomicity hold.

> **Why auto-suspend over block:** the product owner chose to let the downgrade always succeed and
> absorb the excess as suspended (recoverable) members, rather than forcing manual member removal
> before a downgrade. The trade-off — some members silently lose access on downgrade — is mitigated by
> owner-protection, longest-tenured-kept ordering, and full reversibility on upgrade.

### 1.3 Display vs enforcement

The enforced ceiling (above) and the `seats_total` shown on the subscription serializer should stay
consistent; the serializer's `seats_total` is derived from the same resolution.

### 1.4 Implementation status & resolved considerations

**Status: shipped.** F3 (Free-tier cap) and F4 (dunning grace) landed in PR #773; F2 (over-cap-downgrade
auto-suspend) in PR #774. The two considerations flagged before implementation were resolved as follows:

1. **Free plan stays at 1 seat (solo) — confirmed.** "Cap unsubscribed organizations at the Free tier" therefore
   means a subscription-less team organization holds **only its owner** — i.e. no members until it subscribes.
   This is the deliberate product decision (the alternative — raising the Free plan's `included_seats`
   to allow a few free collaborators — was considered and declined). The ceiling is still derived from
   the cheapest active plan, so bumping the Free tier later changes the allowance with no code change.
2. **Test ripple was smaller than feared.** F3 enforcement only bites when a plan catalog exists; the
   integration tests that add members to subscription-less organizations don't seed one, so the Free-tier ceiling
   resolves to `null` (unlimited) there and the suite stayed green. A dedicated F3 integration case was
   added that *does* seed a catalog (plan + no subscription → `409 seat_limit_reached`), distinct from
   the no-catalog-unlimited case.

**Implementation (shipped):**

- `PlanRepository.findFreePlanSeatCeiling()` — `included_seats` of the cheapest active plan.
- `SubscriptionRepository.findActiveSeatStateByOrganizationForUpdate` — projection extended to return
  `status` + `current_period_end` so the service evaluates the dunning-grace window.
- `SubscriptionService.reserveSeatCeilingForMemberAdd` applies §1.1; `changePlan` replaced the F2
  409-block (`assertDowngradeWithinSeatAllowance`) with the §1.2 auto-suspend (best-effort, post-commit).
- `MembershipSeatUsagePort` gained `suspendExcessActiveMembersToFitCeiling({ organizationPublicId, ceiling })`,
  implemented by `MembershipService` (owner-excluded, `joined_at DESC`, in the organization tx; permission-cache
  invalidation runs **post-commit**, outside the organization context, per the audit-R11 policy).

---

## 2. `updated_at` auto-update triggers — deliberately NOT added

The data-integrity sweep flagged that no table has a DB-level `BEFORE UPDATE` trigger to maintain
`updated_at` (the project's SQL skill mentions one). **Decision: do not add triggers.**

- Every mutable table's `updated_at` is **already maintained by the repository layer** on every write.
  The only uncovered case is *raw, non-ORM* writes (seeds, manual admin SQL) — rare and controlled.
- A `BEFORE UPDATE` trigger on ~17 tables adds a trigger firing on every `UPDATE` plus 17 DB objects to
  maintain — real overhead for a near-theoretical gap.
- **If belt-and-suspenders is ever wanted** at zero DB cost, use Drizzle's column-level
  `.$onUpdate(() => new Date())` (ORM-layer enforcement, no migration, no per-row trigger) rather than
  DB triggers.

---

## 3. Operational resilience polish

Shipped (see the `ops-polish` PR):

- **`forceCloseConnections: 'idle'`** on the Fastify server — idle keep-alive sockets close immediately
  on shutdown so a rolling deploy drains gracefully instead of hanging on idle connections.
- **Explicit S3 request/connection timeouts** — `S3_REQUEST_TIMEOUT_MS` (15s) and
  `S3_CONNECTION_TIMEOUT_MS` (5s) bound each S3 attempt; previously only `maxAttempts` was set, so a
  stalled endpoint could hang on Node's unbounded default.
- **Bounded transient-read retry** — `runReadWithTransientRetry`
  (`src/shared/utils/infrastructure/postgres-error.util.ts`) retries **only** SQLSTATE class-08 /
  admin-shutdown / socket-reset errors, never query-logic errors, and never inside a transaction. Applied
  to the two auth pre-handler cache-miss reads so a transient managed-Postgres connection drop does not
  spuriously `401` an authenticated request. Available for opt-in use on other standalone autocommit
  reads.

Deliberately **not** changed:

- **`REDIS_BULLMQ_URL` is not yet a hard production requirement.** Making it mandatory would fail boot on
  the current shared-Redis deployment; the shared-host warning already exists. Promote it to a hard
  requirement once a dedicated BullMQ Redis instance is provisioned.

---

## 4. Scale milestones (tracked, not yet built)

These are acceptable today and become worth doing at volume — they are **not** premature now because
retention is index-driven (`DELETE … WHERE created_at < cutoff` is supported by existing indexes).

- **Partition the high-volume append tables** — `audit.logs`, `notify.notifications`,
  `notify.webhook_delivery_attempts` — by `created_at` (RANGE) once a table approaches tens of millions
  of rows, so retention becomes `DROP PARTITION` instead of a bloat-and-vacuum `DELETE`. The `audit.logs`
  migration path is already documented in `src/domains/audit/audit.schema.ts` (needs a composite
  `(id, created_at)` PK). Suggested trigger: sustained > ~10M rows or retention `DELETE` latency/vacuum
  pressure showing up in DB metrics.
- **GIN indexes on `jsonb` columns** (`webhook_delivery_attempts.payload`, `notifications.data`,
  `audit.logs.metadata`, `uploads.metadata`) — add only **if** a query ever filters *inside* those blobs
  (`@>` / `?`). They are write-and-read-whole-row today, so no index is needed.
