/**
 * How many times {@link getRequestDatabase} has fallen through to the bare, GUC-less pool.
 *
 * @remarks
 * Reset only by process restart; the metrics stack reads it through
 * {@link registerUnscopedDatabaseAccessObserver}.
 */
let unscopedDatabaseAccessCount = 0;

/**
 * How many more fall-throughs will pay for a stack capture.
 *
 * @remarks
 * Capturing a stack on every call would put `Error.captureStackTrace` on a hot path. The first
 * few are enough to name the offending call site — after that the counter alone carries the
 * signal, so the cost settles at one integer increment.
 */
const CALL_SITE_CAPTURE_BUDGET = 50;

/** Distinct call sites reported so far, capped so a pathological caller cannot grow it without bound. */
const MAX_TRACKED_CALL_SITES = 20;

let remainingCallSiteCaptures = CALL_SITE_CAPTURE_BUDGET;
const seenCallSites = new Set<string>();

/** One observed unscoped database access: where it came from, if the capture budget allowed a look. */
export type UnscopedDatabaseAccessSample = {
  /** Resolved call site (`file:line`), or `undefined` once the capture budget is spent. */
  readonly callSite: string | undefined;
  /** True the first time this particular call site is seen — the only ones worth logging. */
  readonly isNewCallSite: boolean;
};

/** Sink for unscoped-access samples, wired to Prometheus and the logger by the metrics stack. */
export type UnscopedDatabaseAccessObserver = (sample: UnscopedDatabaseAccessSample) => void;

let accessObserver: UnscopedDatabaseAccessObserver | null = null;

/**
 * Registers the sink that receives unscoped-access samples.
 *
 * @remarks
 * Kept as an observer rather than a direct metrics import so the database runtime does not
 * depend on the observability stack — the same inversion
 * `organization-rls-checkout-counter.ts` uses.
 */
export function registerUnscopedDatabaseAccessObserver(
  observer: UnscopedDatabaseAccessObserver | null,
): void {
  accessObserver = observer;
}

/** Total unscoped database accesses observed in this process. */
export function getUnscopedDatabaseAccessCount(): number {
  return unscopedDatabaseAccessCount;
}

/** Resets the counter, the capture budget and the seen-site set — tests only. */
export function resetUnscopedDatabaseAccessTrackingForTests(): void {
  unscopedDatabaseAccessCount = 0;
  remainingCallSiteCaptures = CALL_SITE_CAPTURE_BUDGET;
  seenCallSites.clear();
}

/**
 * The first frame outside this file and the context runtime — i.e. whoever asked for a handle.
 */
function resolveCallSite(): string | undefined {
  const { stack } = new Error('unscoped-database-access');
  if (!stack) return undefined;
  for (const line of stack.split('\n').slice(1)) {
    if (line.includes('unscoped-query-counter')) continue;
    if (line.includes('database-context-runtime')) continue;
    const location = frameLocation(line);
    if (location) return location;
  }
  return undefined;
}

/**
 * The `file:line:column` a V8 stack frame ends with — `at fn (file:1:2)` or `at file:1:2`.
 *
 * @remarks
 * Parsed from the frame's last token rather than with one anchored pattern: a character class
 * that also admits the digits and colons after it backtracks super-linearly on a malformed frame
 * (Sonar S5852). Splitting on whitespace and stripping the parentheses stays linear.
 */
function frameLocation(frame: string): string | undefined {
  const lastToken = frame.trim().split(/\s+/).pop() ?? '';
  const location =
    lastToken.startsWith('(') && lastToken.endsWith(')') ? lastToken.slice(1, -1) : lastToken;
  if (location.includes('(') || location.includes(')')) return undefined;
  return /:\d+:\d+$/.test(location) ? location : undefined;
}

/**
 * Records that a query is about to run on the bare pool with no database context active.
 *
 * @remarks
 * - **Why:** a missing context is silent. `upload.uploads` is FORCE RLS with GUC-gated policy
 *   arms, so offboarding that ran without a context matched nothing, erased nothing, and
 *   reported success — and dev and CI could not see it because those roles bypass RLS. No
 *   static test can answer "is a context active here"; only the runtime can, so it counts.
 * - **Algorithm:** always increments. Resolves a call site only while the capture budget lasts,
 *   and flags the first sighting of each site so the sink can log once instead of per call.
 * - **Failure modes:** none raised. A throwing observer is swallowed — telemetry must never
 *   break a query.
 * - **Side effects:** increments a module counter; notifies the registered observer.
 *
 * In the API process this is **not** an error on its own: plenty of legitimate reads run on the
 * shared pool against tables with no GUC-gated policy. It is a signal to investigate — a
 * non-zero rate against a FORCE RLS table is the bug this exists to surface. Worker runtime
 * still throws instead, which is the stricter treatment it has always had.
 */
export function recordUnscopedDatabaseAccess(): void {
  unscopedDatabaseAccessCount += 1;
  if (!accessObserver) return;

  let callSite: string | undefined;
  if (remainingCallSiteCaptures > 0) {
    remainingCallSiteCaptures -= 1;
    callSite = resolveCallSite();
  }

  let isNewCallSite = false;
  if (
    callSite !== undefined &&
    !seenCallSites.has(callSite) &&
    seenCallSites.size < MAX_TRACKED_CALL_SITES
  ) {
    seenCallSites.add(callSite);
    isNewCallSite = true;
  }

  try {
    accessObserver({ callSite, isNewCallSite });
  } catch {
    // Telemetry must never break a query.
  }
}
