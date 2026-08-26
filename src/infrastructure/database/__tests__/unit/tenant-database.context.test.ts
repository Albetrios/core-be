import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRequestDatabase } from '@/infrastructure/database/contexts/request-database.context.js';
import { withOrganizationContext } from '@/infrastructure/database/contexts/tenant-database.context.js';
import {
  getActiveOrganizationRlsCheckoutCount,
  type OrganizationRlsCheckoutHoldSample,
  registerOrganizationRlsCheckoutHoldObserver,
  resetOrganizationRlsCheckoutCountForTests,
} from '@/infrastructure/database/pool/organization-rls-checkout-counter.js';

const mockExecute = vi.fn().mockResolvedValue(undefined);
const mockTransactionHandle = { execute: mockExecute, tag: 'transaction-handle' };

vi.mock('@/infrastructure/database/connection.js', () => ({
  database: {
    transaction: vi.fn(
      async (callback: (transaction: typeof mockTransactionHandle) => Promise<unknown>) =>
        callback(mockTransactionHandle),
    ),
  },
}));

describe('withOrganizationContext', () => {
  const originalRuntime = process.env.CORE_BE_RUNTIME;

  beforeEach(() => {
    resetOrganizationRlsCheckoutCountForTests();
  });

  afterEach(() => {
    resetOrganizationRlsCheckoutCountForTests();
    if (originalRuntime === undefined) {
      delete process.env.CORE_BE_RUNTIME;
    } else {
      process.env.CORE_BE_RUNTIME = originalRuntime;
    }
  });

  it('pins ALS so getRequestDatabase returns the same handle passed to the callback', async () => {
    await withOrganizationContext('org_public_test', async (databaseHandle) => {
      expect(getRequestDatabase()).toBe(databaseHandle);
      expect(databaseHandle).toBe(mockTransactionHandle);
    });

    expect(mockExecute).toHaveBeenCalled();
    expect(getRequestDatabase()).not.toBe(mockTransactionHandle);
  });

  it('counts a pooled checkout for the unit of work and releases it afterwards', async () => {
    expect(getActiveOrganizationRlsCheckoutCount()).toBe(0);

    await withOrganizationContext('org_public_checkout', async () => {
      expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);
    });

    expect(getActiveOrganizationRlsCheckoutCount()).toBe(0);
  });

  it('does not open a second checkout when the same organization is reused in a nested context', async () => {
    await withOrganizationContext('org_public_nested', async () => {
      expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);
      await withOrganizationContext('org_public_nested', async () => {
        expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);
      });
      expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);
    });

    expect(getActiveOrganizationRlsCheckoutCount()).toBe(0);
  });

  it('keeps the connection-level HTTP timeouts outside worker runtime (only set_config runs)', async () => {
    delete process.env.CORE_BE_RUNTIME;
    mockExecute.mockClear();

    await withOrganizationContext('org_public_http_timeout', async () => undefined);

    // Exactly one execute: SET LOCAL app.current_organization_id. No SET LOCAL
    // statement_timeout / lock_timeout — HTTP units of work keep the 5s cap.
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('lifts statement and lock timeouts to the worker budget in worker runtime', async () => {
    process.env.CORE_BE_RUNTIME = 'worker';
    mockExecute.mockClear();

    await withOrganizationContext('org_public_worker_timeout', async () => undefined);

    // set_config + SET LOCAL statement_timeout + SET LOCAL lock_timeout.
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it('reports a scoped_context hold-time sample to the registered observer', async () => {
    const samples: OrganizationRlsCheckoutHoldSample[] = [];
    registerOrganizationRlsCheckoutHoldObserver((sample) => {
      samples.push(sample);
    });

    await withOrganizationContext('org_public_hold', async () => undefined);

    expect(samples).toHaveLength(1);
    expect(samples[0]?.path).toBe('scoped_context');
    expect(samples[0]?.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('releases the checkout and records hold time even when the callback throws', async () => {
    const samples: OrganizationRlsCheckoutHoldSample[] = [];
    registerOrganizationRlsCheckoutHoldObserver((sample) => {
      samples.push(sample);
    });

    await expect(
      withOrganizationContext('org_public_throw', async () => {
        throw new Error('unit-of-work failed');
      }),
    ).rejects.toThrow('unit-of-work failed');

    expect(getActiveOrganizationRlsCheckoutCount()).toBe(0);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.path).toBe('scoped_context');
  });
});
