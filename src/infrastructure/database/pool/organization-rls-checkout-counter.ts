/** In-process count of in-flight org-scoped RLS transaction checkouts (HTTP request-pinned and service unit-of-work). */
let activeOrganizationRlsCheckouts = 0;

/**
 * Which code path opened the org-scoped RLS checkout being measured:
 * - `scoped_context` — a `withOrganizationDatabaseContext` / `withOrganizationDatabaseContext` unit of work
 *   (the default `DATABASE_RLS_SCOPED_CONTEXTS=true` path; also used by workers and scripts).
 * - `request_transaction` — the legacy per-HTTP-request `organization-rls-transaction` middleware
 *   that pins one checkout for the full request (only when `DATABASE_RLS_SCOPED_CONTEXTS=false`).
 */
export type OrganizationRlsCheckoutPath = 'scoped_context' | 'request_transaction';

/** One completed org-RLS checkout: how long the pooled connection was held and by which path. */
export type OrganizationRlsCheckoutHoldSample = {
  readonly path: OrganizationRlsCheckoutPath;
  readonly durationSeconds: number;
};

/** Sink for completed checkout hold samples (wired to the Prometheus histogram by the metrics stack). */
export type OrganizationRlsCheckoutHoldObserver = (
  sample: OrganizationRlsCheckoutHoldSample,
) => void;

let checkoutHoldObserver: OrganizationRlsCheckoutHoldObserver | null = null;

/** Increments the in-process org-RLS checkout gauge when a pooled checkout is acquired. */
export function incrementOrganizationRlsCheckoutCount(): void {
  activeOrganizationRlsCheckouts += 1;
}

/** Decrements the gauge on transaction commit/rollback; clamps to zero to tolerate replay/test drift. */
export function decrementOrganizationRlsCheckoutCount(): void {
  if (activeOrganizationRlsCheckouts > 0) {
    activeOrganizationRlsCheckouts -= 1;
  }
}

/**
 * Current count of in-flight organization-scoped RLS transaction checkouts —
 * read by the DB-pool exhaustion alerter to detect saturation before postgres.js
 * starts queuing, and exported as the `database_rls_active_checkouts` gauge.
 */
export function getActiveOrganizationRlsCheckoutCount(): number {
  return activeOrganizationRlsCheckouts;
}

/**
 * Registers the sink that receives every {@link OrganizationRlsCheckoutHoldSample}. The metrics
 * stack registers a sink that observes the `database_rls_checkout_hold_seconds` histogram; pass
 * `null` to detach. Kept dependency-free here so the hot DB-checkout paths never import prom-client.
 */
export function registerOrganizationRlsCheckoutHoldObserver(
  observer: OrganizationRlsCheckoutHoldObserver | null,
): void {
  checkoutHoldObserver = observer;
}

/**
 * Reports one completed checkout hold to the registered observer (no-op when none is registered,
 * e.g. metrics disabled). Never throws — metrics recording must not break a database checkout path.
 */
export function observeOrganizationRlsCheckoutHold(
  sample: OrganizationRlsCheckoutHoldSample,
): void {
  if (checkoutHoldObserver === null) {
    return;
  }
  checkoutHoldObserver(sample);
}

/** Test-only: reset checkout counter and detach the hold observer between Vitest cases. */
export function resetOrganizationRlsCheckoutCountForTests(): void {
  activeOrganizationRlsCheckouts = 0;
  checkoutHoldObserver = null;
}
