import { describe, expect, it, vi } from 'vitest';

const executeMock = vi.fn().mockResolvedValue(undefined);
const transactionMock = vi.fn();

vi.mock('@/infrastructure/database/connection.js', () => ({
  database: {
    transaction: (...arguments_: unknown[]) => transactionMock(...arguments_),
  },
}));

import { withGlobalRetentionCleanupDatabaseContext } from '@/infrastructure/database/contexts/retention-database.context.js';

describe('withGlobalRetentionCleanupDatabaseContext', () => {
  it('sets app.global_retention_cleanup and passes a delegating scope-guarded handle to the callback', async () => {
    const databaseHandle = { execute: executeMock };

    transactionMock.mockImplementation(
      async (callback: (transaction: unknown) => Promise<unknown>) => callback(databaseHandle),
    );

    const result = await withGlobalRetentionCleanupDatabaseContext(async (handle) => {
      // The callback handle is a scope-guarded proxy — calls delegate to the transaction handle.
      await handle.execute('SELECT 1' as never);
      return 'ok';
    });

    expect(result).toBe('ok');
    // statement timeout + GUC set_config + the callback's own execute all hit the raw handle.
    expect(executeMock).toHaveBeenCalledWith('SELECT 1');
  });

  it('invalidates the callback handle once the context has ended', async () => {
    const databaseHandle = { execute: executeMock };
    transactionMock.mockImplementation(
      async (callback: (transaction: unknown) => Promise<unknown>) => callback(databaseHandle),
    );

    let escapedHandle:
      | Parameters<Parameters<typeof withGlobalRetentionCleanupDatabaseContext>[0]>[0]
      | undefined;
    await withGlobalRetentionCleanupDatabaseContext(async (handle) => {
      escapedHandle = handle;
    });

    expect(() => escapedHandle?.execute('SELECT 1' as never)).toThrow(
      /Database handle used after its context ended/,
    );
  });
});
