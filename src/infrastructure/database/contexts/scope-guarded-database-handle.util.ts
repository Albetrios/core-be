import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/request-database.context.js';
import { WorkerDatabaseContextError } from '@/infrastructure/database/contexts/worker-database.context.error.js';

/**
 * A database handle whose usable lifetime is bound to its context callback, plus
 * the `dispose()` that ends it — returned by {@link createScopeGuardedDatabaseHandle}.
 */
export type ScopeGuardedDatabaseHandle = {
  /** Proxy over the transaction handle; throws {@link WorkerDatabaseContextError} after `dispose()`. */
  readonly databaseHandle: RequestScopedPostgresDatabase;
  /** Marks the scope ended — every later property access on `databaseHandle` throws. */
  readonly dispose: () => void;
};

/**
 * Wraps a transaction-scoped Drizzle handle in a proxy that throws once the owning
 * context callback has ended, so a handle stored or returned from a context callback
 * fails loudly instead of silently querying outside its transaction (and RLS GUCs).
 *
 * @remarks
 * - **Algorithm**: a `Proxy` `get` trap delegates to the raw handle until `dispose()`
 *   is called, then throws {@link WorkerDatabaseContextError} for any further property
 *   access. Method values are bound to the raw handle so drizzle internals (private
 *   fields) keep working through the proxy.
 * - **Failure modes**: after disposal, any use throws — `Symbol` properties and
 *   `then` are exempt so `await`/inspection of the proxy itself stays inert.
 * - **Side effects**: none; purely an in-process guard.
 * - **Notes**: context wrappers pass the proxied handle to callbacks and pin it in
 *   ALS, and call `dispose()` when the callback settles. Reused (non-owned) handles
 *   are never re-wrapped by inner scopes.
 */
export function createScopeGuardedDatabaseHandle(
  rawDatabaseHandle: RequestScopedPostgresDatabase,
): ScopeGuardedDatabaseHandle {
  let disposed = false;

  const databaseHandle = new Proxy(rawDatabaseHandle as object, {
    get(target, property, receiver) {
      if (disposed && typeof property !== 'symbol' && property !== 'then') {
        throw new WorkerDatabaseContextError(
          `Database handle used after its context ended (property "${String(property)}"). ` +
            'Do not store or return the databaseHandle from a context callback — run the query inside the callback instead.',
        );
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as RequestScopedPostgresDatabase;

  return {
    databaseHandle,
    dispose: () => {
      disposed = true;
    },
  };
}
