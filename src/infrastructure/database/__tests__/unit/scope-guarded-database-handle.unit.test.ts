import { describe, expect, it, vi } from 'vitest';
import { createScopeGuardedDatabaseHandle } from '@/infrastructure/database/contexts/scope-guarded-database-handle.util.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/request-database.context.js';
import { WorkerDatabaseContextError } from '@/infrastructure/database/contexts/worker-database.context.error.js';

describe('createScopeGuardedDatabaseHandle', () => {
  const buildRawHandle = () => {
    const execute = vi.fn().mockResolvedValue([{ ok: true }]);
    return {
      raw: { execute, marker: 'raw-handle' } as unknown as RequestScopedPostgresDatabase,
      execute,
    };
  };

  it('delegates property access and method calls to the raw handle before disposal', async () => {
    const { raw, execute } = buildRawHandle();
    const guard = createScopeGuardedDatabaseHandle(raw);

    await guard.databaseHandle.execute('SELECT 1' as never);

    expect(execute).toHaveBeenCalledWith('SELECT 1');
    expect((guard.databaseHandle as unknown as { marker: string }).marker).toBe('raw-handle');
  });

  it('throws WorkerDatabaseContextError on any property access after dispose', () => {
    const { raw } = buildRawHandle();
    const guard = createScopeGuardedDatabaseHandle(raw);

    guard.dispose();

    expect(() => guard.databaseHandle.execute('SELECT 1' as never)).toThrow(
      WorkerDatabaseContextError,
    );
    expect(() => (guard.databaseHandle as unknown as { marker: string }).marker).toThrow(
      /Database handle used after its context ended/,
    );
  });

  it('stays await-safe after dispose (`then` access does not throw)', async () => {
    const { raw } = buildRawHandle();
    const guard = createScopeGuardedDatabaseHandle(raw);

    guard.dispose();

    // Awaiting the proxy inspects `.then` — must resolve to the proxy itself, not throw.
    await expect(Promise.resolve(guard.databaseHandle)).resolves.toBeDefined();
  });
});
