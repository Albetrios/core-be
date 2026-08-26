import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/maintenance-database.context.js';
import { getRequestDatabase } from '@/infrastructure/database/contexts/request-database.context.js';
import { withOrganizationContext } from '@/infrastructure/database/contexts/tenant-database.context.js';
import { withSystemTableRetentionContext } from '@/infrastructure/database/contexts/retention-database.context.js';
import { WorkerDatabaseContextError } from '@/infrastructure/database/contexts/worker-database.context.error.js';
import {
  assertWorkerDatabaseContext,
  assertWorkerForceRlsTableAccess,
  getWorkerDatabaseContext,
  isWorkerRuntime,
  runWithWorkerDatabaseContext,
  withSystemTableWorkerContext,
} from '@/infrastructure/database/contexts/worker-database.context.js';

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

describe('worker database context', () => {
  const originalRuntime = process.env.CORE_BE_RUNTIME;

  afterEach(() => {
    if (originalRuntime === undefined) {
      delete process.env.CORE_BE_RUNTIME;
    } else {
      process.env.CORE_BE_RUNTIME = originalRuntime;
    }
  });

  it('isWorkerRuntime returns true when CORE_BE_RUNTIME is worker', () => {
    process.env.CORE_BE_RUNTIME = 'worker';
    expect(isWorkerRuntime()).toBe(true);
  });

  it('assertWorkerDatabaseContext throws in worker runtime without pinned context', () => {
    process.env.CORE_BE_RUNTIME = 'worker';
    expect(() => assertWorkerDatabaseContext()).toThrow(WorkerDatabaseContextError);
  });

  it('getRequestDatabase throws in worker runtime without pinned context', () => {
    process.env.CORE_BE_RUNTIME = 'worker';
    expect(() => getRequestDatabase()).toThrow(WorkerDatabaseContextError);
  });

  it('withOrganizationContext sets organization worker context kind', async () => {
    process.env.CORE_BE_RUNTIME = 'worker';
    await withOrganizationContext('org_public_test', async () => {
      expect(getWorkerDatabaseContext()?.kind).toBe('organization');
      expect(getWorkerDatabaseContext()?.organizationPublicId).toBe('org_public_test');
    });
  });

  it('withMaintenanceDatabaseContext sets global_retention_cleanup kind', async () => {
    process.env.CORE_BE_RUNTIME = 'worker';
    await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_retention_cleanup, async () => {
      expect(getWorkerDatabaseContext()?.kind).toBe('global_retention_cleanup');
    });
  });

  it('withSystemTableWorkerContext sets system_table kind in worker runtime', async () => {
    process.env.CORE_BE_RUNTIME = 'worker';
    await withSystemTableWorkerContext(async () => {
      expect(getWorkerDatabaseContext()?.kind).toBe('system_table');
      expect(() => getRequestDatabase()).not.toThrow();
    });
  });

  it('assertWorkerForceRlsTableAccess rejects system_table for FORCE RLS tables', async () => {
    process.env.CORE_BE_RUNTIME = 'worker';
    await runWithWorkerDatabaseContext({ kind: 'system_table' }, async () => {
      expect(() =>
        assertWorkerForceRlsTableAccess({ schemaName: 'billing', tableName: 'subscriptions' }),
      ).toThrow(WorkerDatabaseContextError);
    });
  });

  it('assertWorkerForceRlsTableAccess allows organization context for tenant tables', async () => {
    process.env.CORE_BE_RUNTIME = 'worker';
    await withOrganizationContext('org_public_test', async () => {
      expect(() =>
        assertWorkerForceRlsTableAccess({ schemaName: 'billing', tableName: 'subscriptions' }),
      ).not.toThrow();
    });
  });

  it('sec-new-Q4: withSystemTableRetentionContext sets system_table kind in worker runtime', async () => {
    process.env.CORE_BE_RUNTIME = 'worker';
    await withSystemTableRetentionContext(async () => {
      expect(getWorkerDatabaseContext()?.kind).toBe('system_table');
      expect(() => getRequestDatabase()).not.toThrow();
    });
  });

  it('sec-new-Q4: withSystemTableRetentionContext opens a transaction and applies statement timeout', async () => {
    process.env.CORE_BE_RUNTIME = 'worker';
    const { database: mockedDatabase } = await import('@/infrastructure/database/connection.js');
    mockExecute.mockClear();
    await withSystemTableRetentionContext(async () => {
      /* pure-DB callback */
    });
    // A transaction must be opened (so SET LOCAL statement_timeout takes effect)
    expect(mockedDatabase.transaction).toHaveBeenCalled();
    // applyWorkerStatementTimeout calls databaseHandle.execute() with the SET LOCAL statement
    expect(mockExecute).toHaveBeenCalled();
  });
});
