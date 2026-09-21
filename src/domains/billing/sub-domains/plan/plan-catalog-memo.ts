import { CATALOG_MEMO_TTL_MILLISECONDS } from '@/shared/constants/ttl.constants.js';
import type { PlanOutput } from '@/domains/billing/sub-domains/plan/plan.types.js';

let memoizedPlanCatalog: { value: PlanOutput[]; expiresAt: number } | null = null;
let planCatalogLoadInFlight: Promise<PlanOutput[]> | null = null;

/**
 * Serves the public plan catalog from process memory for {@link CATALOG_MEMO_TTL_MILLISECONDS}.
 *
 * @remarks
 * - **Algorithm:** return the unexpired memo; otherwise run `load` once — concurrent callers join
 *   the same in-flight promise rather than each issuing their own query — and memoize the result.
 *   A rejected load is never memoized and clears the in-flight slot, so the next caller retries.
 * - **Failure modes:** none of its own; a `load` rejection propagates to every joined caller.
 * - **Side effects:** module-level state, per process.
 * - **Notes:** this is **not** the Redis read-cache pattern and deliberately does not follow it.
 *   That pattern exists for scope-keyed data that changes under you; this catalog is global and
 *   cannot change while the process runs — every writer is a migration or a CLI seed in a
 *   different process, and `billing.plans` has no tenant column and no per-caller row filtering
 *   (`plans_rls_deny_all`). So there is nothing to key on, nothing to invalidate, and no write
 *   choke point to hook. It follows `migration-version.ts` instead, which memoizes a Postgres read
 *   in-process for exactly the same reason.
 *
 *   The single-flight matters here in a way it does not for that one: `GET /billing/plans` is
 *   public and unauthenticated, so a cold memo is reachable by anyone at the public rate limit.
 *   Without it, expiry under load would send every concurrent request to Postgres at once.
 *
 *   **Staleness is bounded far more tightly than what this route already promises.** It sends
 *   `Cache-Control: max-age=300`, so browsers and any CDN in front of it may serve a five-minute-old
 *   catalog. A one-minute memo is strictly fresher than the answer a caller may already be holding.
 */
export async function memoizePlanCatalog(load: () => Promise<PlanOutput[]>): Promise<PlanOutput[]> {
  const now = Date.now();
  if (memoizedPlanCatalog && memoizedPlanCatalog.expiresAt > now) {
    return memoizedPlanCatalog.value;
  }
  if (planCatalogLoadInFlight) return planCatalogLoadInFlight;

  planCatalogLoadInFlight = load()
    .then((value) => {
      memoizedPlanCatalog = { value, expiresAt: Date.now() + CATALOG_MEMO_TTL_MILLISECONDS };
      return value;
    })
    .finally(() => {
      planCatalogLoadInFlight = null;
    });
  return planCatalogLoadInFlight;
}

/**
 * Test-only: drop the memoized catalog so the next read goes to Postgres.
 *
 * @remarks
 * Called from `cleanupDatabase`, because truncating `billing.plans` cannot reach process memory —
 * a suite that seeds plans and asserts on them would otherwise read the previous file's catalog.
 * Chaos and performance suites that assert something about the *database path* must call it
 * between probes as well; a per-file reset does not help a single test that probes repeatedly.
 */
export function resetPlanCatalogMemoForTests(): void {
  memoizedPlanCatalog = null;
  planCatalogLoadInFlight = null;
}
