import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRequestDatabase } from '@/infrastructure/database/contexts/request-database.context.js';
import {
  createPrincipalDatabaseScope,
  withPrincipalDatabaseContext,
} from '@/infrastructure/database/contexts/principal-database.context.js';

const asOrgScope = (organizationPublicId: string) =>
  createPrincipalDatabaseScope({ organizationPublicId, source: 'token' });
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

describe('withPrincipalDatabaseContext checkout accounting (organization scopes)', () => {
  beforeEach(() => {
    resetOrganizationRlsCheckoutCountForTests();
  });

  afterEach(() => {
    resetOrganizationRlsCheckoutCountForTests();
  });

  it('pins ALS so getRequestDatabase returns the same handle passed to the callback', async () => {
    await withPrincipalDatabaseContext(asOrgScope('org_public_test'), async (databaseHandle) => {
      expect(getRequestDatabase()).toBe(databaseHandle);
      expect(databaseHandle).toBe(mockTransactionHandle);
    });

    expect(mockExecute).toHaveBeenCalled();
    expect(getRequestDatabase()).not.toBe(mockTransactionHandle);
  });

  it('counts a pooled checkout for the unit of work and releases it afterwards', async () => {
    expect(getActiveOrganizationRlsCheckoutCount()).toBe(0);

    await withPrincipalDatabaseContext(asOrgScope('org_public_checkout'), async () => {
      expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);
    });

    expect(getActiveOrganizationRlsCheckoutCount()).toBe(0);
  });

  it('does not open a second checkout when the same organization is reused in a nested context', async () => {
    await withPrincipalDatabaseContext(asOrgScope('org_public_nested'), async () => {
      expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);
      await withPrincipalDatabaseContext(asOrgScope('org_public_nested'), async () => {
        expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);
      });
      expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);
    });

    expect(getActiveOrganizationRlsCheckoutCount()).toBe(0);
  });

  it('reports a scoped_context hold-time sample to the registered observer', async () => {
    const samples: OrganizationRlsCheckoutHoldSample[] = [];
    registerOrganizationRlsCheckoutHoldObserver((sample) => {
      samples.push(sample);
    });

    await withPrincipalDatabaseContext(asOrgScope('org_public_hold'), async () => undefined);

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
      withPrincipalDatabaseContext(asOrgScope('org_public_throw'), async () => {
        throw new Error('unit-of-work failed');
      }),
    ).rejects.toThrow('unit-of-work failed');

    expect(getActiveOrganizationRlsCheckoutCount()).toBe(0);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.path).toBe('scoped_context');
  });
});
