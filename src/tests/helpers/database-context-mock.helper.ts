import { vi } from 'vitest';

/**
 * Standard passthrough factory for `vi.mock('@/infrastructure/database/contexts/database-context.js', …)`
 * in pure unit suites — stubs BOTH wrappers a service graph can reach so no test ever
 * opens a real `database.transaction()` (CI's unit/contract lanes run without Postgres).
 *
 * @remarks
 * - **Usage:**
 *   ```ts
 *   vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) =>
 *     mockDatabaseContexts(await importOriginal<Record<string, unknown>>()),
 *   );
 *   ```
 * - **Notes:** this failure class recurred three times (a suite stubbed only the
 *   principal wrapper, spread `...actual`, and a cross-domain import then ran the REAL
 *   maintenance wrapper — green locally against the OrbStack listener, ECONNREFUSED in
 *   CI). One helper, both wrappers, structurally closed. Suites that assert on wrapper
 *   calls can still spread their own overrides after this factory's fields.
 */
export function mockDatabaseContexts(actual: Record<string, unknown>): Record<string, unknown> {
  return {
    ...actual,
    withPrincipalDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
    withSessionDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
}
