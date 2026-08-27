import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRequestDatabase } from '@/infrastructure/database/contexts/request-database.context.js';
import {
  createPrincipalDatabaseScope,
  withPrincipalDatabaseContext,
} from '@/infrastructure/database/contexts/principal-database.context.js';
import { withOrganizationDatabaseContext } from '@/infrastructure/database/contexts/organization-database.context.js';
import {
  getActiveOrganizationRlsCheckoutCount,
  resetOrganizationRlsCheckoutCountForTests,
} from '@/infrastructure/database/pool/organization-rls-checkout-counter.js';
import { ConfigurationError } from '@/shared/errors/index.js';

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

/** Renders the SQL text of every set_config statement executed so far. */
function executedSqlTexts(): string[] {
  return mockExecute.mock.calls.map((call) => {
    const statement = call[0] as { queryChunks?: unknown[] } | string;
    if (typeof statement === 'string') return statement;
    return JSON.stringify(statement.queryChunks ?? statement);
  });
}

describe('withPrincipalDatabaseContext', () => {
  beforeEach(() => {
    mockExecute.mockClear();
    resetOrganizationRlsCheckoutCountForTests();
  });

  it('sets BOTH identity GUCs in one statement for a user+organization scope', async () => {
    const scope = createPrincipalDatabaseScope({
      userPublicId: 'usr_a',
      organizationPublicId: 'org_x',
      source: 'token',
    });

    await withPrincipalDatabaseContext(scope, async () => undefined);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sqlText] = executedSqlTexts();
    expect(sqlText).toContain('app.current_user_id');
    expect(sqlText).toContain('app.current_organization_id');
  });

  it('sets only the organization GUC for an org-only (API-key) scope', async () => {
    const scope = createPrincipalDatabaseScope({ organizationPublicId: 'org_x', source: 'token' });

    await withPrincipalDatabaseContext(scope, async () => undefined);

    const [sqlText] = executedSqlTexts();
    expect(sqlText).toContain('app.current_organization_id');
    expect(sqlText).not.toContain('app.current_user_id');
  });

  it('sets only the user GUC for a user-only scope', async () => {
    const scope = createPrincipalDatabaseScope({ userPublicId: 'usr_a', source: 'token' });

    await withPrincipalDatabaseContext(scope, async () => undefined);

    const [sqlText] = executedSqlTexts();
    expect(sqlText).toContain('app.current_user_id');
    expect(sqlText).not.toContain('app.current_organization_id');
  });

  it('never emits any GUC key beyond the two identity keys (bypass ceiling)', async () => {
    const scope = createPrincipalDatabaseScope({
      userPublicId: 'usr_a',
      organizationPublicId: 'org_x',
      source: 'token',
    });

    await withPrincipalDatabaseContext(scope, async (handle) => {
      // Only the wrapper's own set_config is inspected — the callback issues none.
      void handle;
    });

    for (const sqlText of executedSqlTexts()) {
      expect(sqlText).not.toMatch(
        /global_admin|global_retention_cleanup|session_retention_cleanup|audit_outbox_drain|system_audit_insert/,
      );
    }
  });

  it('does not lift statement/lock timeouts outside worker runtime (HTTP caps stay)', async () => {
    delete process.env.CORE_BE_RUNTIME;
    const scope = createPrincipalDatabaseScope({ organizationPublicId: 'org_x', source: 'token' });

    await withPrincipalDatabaseContext(scope, async () => undefined);

    for (const sqlText of executedSqlTexts()) {
      expect(sqlText).not.toMatch(/statement_timeout|lock_timeout/);
    }
  });

  it('lifts statement/lock timeouts to the worker budget in worker runtime (job scopes)', async () => {
    process.env.CORE_BE_RUNTIME = 'worker';
    try {
      const scope = createPrincipalDatabaseScope({ organizationPublicId: 'org_x', source: 'job' });
      await withPrincipalDatabaseContext(scope, async () => undefined);
      const combined = executedSqlTexts().join(' ');
      expect(combined).toMatch(/statement_timeout/);
      expect(combined).toMatch(/lock_timeout/);
    } finally {
      delete process.env.CORE_BE_RUNTIME;
    }
  });

  it('pins ALS so getRequestDatabase resolves to the same handle inside the callback', async () => {
    const scope = createPrincipalDatabaseScope({ organizationPublicId: 'org_x', source: 'token' });

    await withPrincipalDatabaseContext(scope, async (databaseHandle) => {
      expect(getRequestDatabase()).toBe(databaseHandle);
    });
  });

  it('reuses an already-pinned organization transaction and layers the user GUC onto it', async () => {
    const scope = createPrincipalDatabaseScope({
      userPublicId: 'usr_a',
      organizationPublicId: 'org_x',
      source: 'token',
    });

    await withOrganizationDatabaseContext('org_x', async (outerHandle) => {
      mockExecute.mockClear();
      expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);

      await withPrincipalDatabaseContext(scope, async (innerHandle) => {
        expect(innerHandle).toBe(outerHandle);
        // no second checkout — the pinned transaction is shared
        expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);
      });

      // exactly one extra statement: layering app.current_user_id onto the outer handle
      const sqlTexts = executedSqlTexts();
      expect(sqlTexts).toHaveLength(1);
      expect(sqlTexts[0]).toContain('app.current_user_id');
    });
  });

  it('user-only scopes reuse ANY pinned handle and layer only the user GUC (FK atomicity)', async () => {
    const orgScope = createPrincipalDatabaseScope({
      organizationPublicId: 'org_x',
      source: 'token',
    });
    const userOnly = createPrincipalDatabaseScope({
      userPublicId: 'usr_a',
      source: 'provisioning',
    });

    await withPrincipalDatabaseContext(orgScope, async (outerHandle) => {
      mockExecute.mockClear();
      await withPrincipalDatabaseContext(userOnly, async (innerHandle) => {
        // Same transaction handle — no second pool checkout, atomic with the outer trx.
        expect(innerHandle).toBe(outerHandle);
      });
      const sqlTexts = executedSqlTexts();
      expect(sqlTexts).toHaveLength(1);
      expect(sqlTexts[0]).toContain('app.current_user_id');
      // The pinned session's org GUC is never rewritten by a user-only scope.
      expect(sqlTexts[0]).not.toContain('app.current_organization_id');
    });
  });

  it('an org-bearing scope for a DIFFERENT org opens its own transaction (second checkout)', async () => {
    const orgScope = createPrincipalDatabaseScope({
      organizationPublicId: 'org_x',
      source: 'token',
    });
    const otherOrg = createPrincipalDatabaseScope({
      organizationPublicId: 'org_y',
      source: 'token',
    });

    await withPrincipalDatabaseContext(orgScope, async () => {
      expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);
      await withPrincipalDatabaseContext(otherOrg, async () => {
        // Cross-org nesting must NOT reuse — a fresh transaction takes a second checkout.
        expect(getActiveOrganizationRlsCheckoutCount()).toBe(2);
      });
      expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);
    });
  });

  it('counts one organization checkout for a fresh org-bearing scope and releases it', async () => {
    const scope = createPrincipalDatabaseScope({ organizationPublicId: 'org_x', source: 'token' });

    await withPrincipalDatabaseContext(scope, async () => {
      expect(getActiveOrganizationRlsCheckoutCount()).toBe(1);
    });
    expect(getActiveOrganizationRlsCheckoutCount()).toBe(0);
  });

  it('propagates callback errors (transaction rollback path) and still releases the checkout', async () => {
    const scope = createPrincipalDatabaseScope({ organizationPublicId: 'org_x', source: 'token' });

    await expect(
      withPrincipalDatabaseContext(scope, async () => {
        throw new Error('unit-of-work failed');
      }),
    ).rejects.toThrow('unit-of-work failed');
    expect(getActiveOrganizationRlsCheckoutCount()).toBe(0);
  });
});

describe('createPrincipalDatabaseScope', () => {
  it('throws ConfigurationError for an empty scope', () => {
    expect(() => createPrincipalDatabaseScope({ source: 'token' })).toThrow(ConfigurationError);
  });
});
