import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  memoizePlanCatalog,
  resetPlanCatalogMemoForTests,
} from '@/domains/billing/sub-domains/plan/plan-catalog-memo.js';
import {
  memoizePermissionCatalog,
  resetPermissionCatalogMemoForTests,
} from '@/domains/tenancy/sub-domains/permission/permission-catalog-memo.js';
import { CATALOG_MEMO_TTL_MILLISECONDS } from '@/shared/constants/ttl.constants.js';

/**
 * Both catalog memos, driven through one table — they are separate modules on purpose (each
 * carries its own safety argument), but the behaviour they must share is exactly this.
 */
const MEMOS = [
  {
    name: 'plan catalog',
    memoize: memoizePlanCatalog as (load: () => Promise<unknown[]>) => Promise<unknown[]>,
    reset: resetPlanCatalogMemoForTests,
  },
  {
    name: 'permission catalog',
    memoize: memoizePermissionCatalog as (load: () => Promise<unknown[]>) => Promise<unknown[]>,
    reset: resetPermissionCatalogMemoForTests,
  },
] as const;

describe.each(MEMOS)('$name in-process memo', ({ memoize, reset }) => {
  beforeEach(() => {
    reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    reset();
  });

  it('loads once and serves the same value until the TTL elapses', async () => {
    const load = vi.fn().mockResolvedValue([{ id: 'first' }]);

    await expect(memoize(load)).resolves.toEqual([{ id: 'first' }]);
    await expect(memoize(load)).resolves.toEqual([{ id: 'first' }]);
    expect(load).toHaveBeenCalledTimes(1);

    // One millisecond before expiry is still a hit; the boundary is where a naive `>=` would slip.
    vi.advanceTimersByTime(CATALOG_MEMO_TTL_MILLISECONDS - 1);
    await expect(memoize(load)).resolves.toEqual([{ id: 'first' }]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads after the TTL elapses', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'first' }])
      .mockResolvedValueOnce([{ id: 'second' }]);

    await memoize(load);
    vi.advanceTimersByTime(CATALOG_MEMO_TTL_MILLISECONDS + 1);

    await expect(memoize(load)).resolves.toEqual([{ id: 'second' }]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent cold reads into a single load', async () => {
    // The route this fronts is public and unauthenticated, so expiry under load would otherwise
    // send every concurrent request to Postgres at once. This is the whole reason for the
    // in-flight slot, and a memo without it looks identical until the moment it matters.
    let releaseLoad: (rows: unknown[]) => void = () => {};
    const load = vi.fn().mockImplementation(
      () =>
        new Promise<unknown[]>((resolve) => {
          releaseLoad = resolve;
        }),
    );

    const concurrentReads = [memoize(load), memoize(load), memoize(load)];
    releaseLoad([{ id: 'shared' }]);

    await expect(Promise.all(concurrentReads)).resolves.toEqual([
      [{ id: 'shared' }],
      [{ id: 'shared' }],
      [{ id: 'shared' }],
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never memoizes a failed load, and lets the next caller retry', async () => {
    // Memoizing a rejection would turn one transient database blip into a minute of outage on a
    // public route.
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection terminated'))
      .mockResolvedValueOnce([{ id: 'recovered' }]);

    await expect(memoize(load)).rejects.toThrow('connection terminated');
    await expect(memoize(load)).resolves.toEqual([{ id: 'recovered' }]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('drops the memo on reset so the next read reloads', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'before' }])
      .mockResolvedValueOnce([{ id: 'after' }]);

    await memoize(load);
    reset();

    await expect(memoize(load)).resolves.toEqual([{ id: 'after' }]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
