import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getUnscopedDatabaseAccessCount,
  recordUnscopedDatabaseAccess,
  registerUnscopedDatabaseAccessObserver,
  resetUnscopedDatabaseAccessTrackingForTests,
  type UnscopedDatabaseAccessSample,
} from '@/infrastructure/database/pool/unscoped-query-counter.js';

/**
 * A missing database context is silent: on a FORCE RLS table whose policy arms are GUC-gated,
 * the query matches nothing, returns zero rows, and the caller concludes there was nothing
 * there. That is how organization and account deletion came to erase no uploads while reporting
 * success, and dev and CI could not see it because both roles bypass RLS.
 *
 * No static test can answer "is a context active at this call site" — the runtime can, so
 * `getRequestDatabase()` counts every fall-through to the bare pool. These assertions pin the
 * properties that make that counting safe to leave on: it never throws, it stops paying for
 * stack captures, and it names a call site once rather than on every call.
 */
describe('unscoped database access counter', () => {
  beforeEach(() => {
    registerUnscopedDatabaseAccessObserver(null);
    resetUnscopedDatabaseAccessTrackingForTests();
  });

  it('counts every access even with no observer registered', () => {
    recordUnscopedDatabaseAccess();
    recordUnscopedDatabaseAccess();

    // The counter is the always-on signal; the observer is only how it reaches Prometheus.
    expect(getUnscopedDatabaseAccessCount()).toBe(2);
  });

  it('flags a repeated call site as new exactly once, so one offender cannot flood the log', () => {
    const samples: UnscopedDatabaseAccessSample[] = [];
    registerUnscopedDatabaseAccessObserver((sample) => samples.push(sample));

    // Same line, called repeatedly — one physical call site.
    for (let attempt = 0; attempt < 5; attempt += 1) recordUnscopedDatabaseAccess();

    expect(samples).toHaveLength(5);
    expect(samples.filter((sample) => sample.isNewCallSite)).toHaveLength(1);
    expect(getUnscopedDatabaseAccessCount()).toBe(5);
  });

  it('resolves a call site that points at the caller, not at the counter itself', () => {
    const samples: UnscopedDatabaseAccessSample[] = [];
    registerUnscopedDatabaseAccessObserver((sample) => samples.push(sample));

    recordUnscopedDatabaseAccess();

    const [sample] = samples;
    expect(sample?.callSite).toBeDefined();
    // Naming the counter's own frame would make every report identical and useless — the whole
    // point is to name whoever asked for a handle.
    expect(sample?.callSite).not.toContain('pool/unscoped-query-counter');
    expect(sample?.callSite).not.toContain('database-context-runtime');
    // Whatever the runner does to the frame's prefix (bare path here, `file://` URL under some
    // transforms), it must end in a resolvable file:line:column.
    expect(sample?.callSite).toMatch(/:\d+:\d+$/);
  });

  it('stops capturing call sites once the budget is spent, but keeps counting', () => {
    const samples: UnscopedDatabaseAccessSample[] = [];
    registerUnscopedDatabaseAccessObserver((sample) => samples.push(sample));

    // Comfortably past the capture budget.
    for (let attempt = 0; attempt < 120; attempt += 1) recordUnscopedDatabaseAccess();

    // `Error.captureStackTrace` on a hot path is the thing being avoided: the tail of the run
    // must cost one integer increment, not a stack walk.
    expect(samples.at(-1)?.callSite).toBeUndefined();
    expect(getUnscopedDatabaseAccessCount()).toBe(120);
  });

  it('never lets a throwing observer break the query that triggered it', () => {
    registerUnscopedDatabaseAccessObserver(
      vi.fn(() => {
        throw new Error('metrics sink is down');
      }),
    );

    // Telemetry failing must not turn a working query into a failed request.
    expect(() => recordUnscopedDatabaseAccess()).not.toThrow();
    expect(getUnscopedDatabaseAccessCount()).toBe(1);
  });
});
