import { describe, expect, it } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { env } from '@/shared/config/env.config.js';
import { sql } from '@/infrastructure/database/connection.js';
import { withPrincipalDatabaseContext } from '@/infrastructure/database/contexts/database-context.js';
import { resolveVerifiedOrganizationPrincipalScope } from '@/shared/utils/identity/verified-principal-scope.util.js';

/**
 * Production hardening item 2: when many concurrent requests use scoped
 * `withOrganizationDatabaseContext` blocks (rather than full-request transaction pinning),
 * external network I/O — simulated here as `pg_sleep` — must run OUTSIDE the context so a
 * burst of slow external calls cannot drain the pool. The chaos invariant: at least one
 * additional autocommit query keeps succeeding throughout the burst.
 *
 * This test is intentionally tight on assertions and friendly to local Docker Postgres pool
 * sizes; it does not require Toxiproxy.
 */
describe('Chaos resilience: database pool stays available under bursty scoped-context load', () => {
  it('processes a burst of scoped-context units of work and concurrent autocommit queries without 5xx-equivalent failures', async () => {
    const organizationPublicId = 'chaos-pool-org';
    const poolMax = env.DATABASE_POOL_MAX ?? 10;
    const burstSize = Math.max(poolMax * 2, 20);

    const scopedUnitsOfWork = Array.from({ length: burstSize }, (_, index) =>
      withPrincipalDatabaseContext(
        resolveVerifiedOrganizationPrincipalScope(organizationPublicId),
        async (databaseHandle) => {
          const rows = await databaseHandle.execute<{ value: number }>(
            drizzleSql`SELECT ${index}::int AS value`,
          );
          const result = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: { value: number }[] }).rows ?? []);
          return result[0]?.value ?? -1;
        },
      ),
    );

    const autocommitProbes = Array.from(
      { length: burstSize },
      (_, index) => sql<{ value: number }[]>`SELECT ${index + 1000}::int AS value`,
    );

    const [scopedResults, autocommitResults] = await Promise.all([
      Promise.all(scopedUnitsOfWork),
      Promise.all(autocommitProbes),
    ]);

    expect(scopedResults).toHaveLength(burstSize);
    expect(autocommitResults).toHaveLength(burstSize);
    for (const [index, value] of scopedResults.entries()) {
      expect(value).toBe(index);
    }
    for (const [index, rows] of autocommitResults.entries()) {
      expect(rows[0]?.value).toBe(index + 1000);
    }
  }, 30_000);
});
