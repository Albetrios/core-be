import { count, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { LIST_TOTAL_COUNT_CAP } from '@/shared/constants/pagination.constants.js';

/** Inputs for {@link countWithCap}. */
export interface CountWithCapOptions {
  database: RequestScopedPostgresDatabase;
  table: PgTable;
  where: SQL | undefined;
  cap?: number;
}

/**
 * Counts rows matching `where` but stops scanning once `cap` rows are seen,
 * by counting over a `LIMIT cap` subquery. Used to back opt-in `include_total`
 * list responses without letting an unbounded `count(*)` scan a whole table.
 *
 * @remarks
 * - **Algorithm:** `SELECT count(*) FROM (SELECT 1 FROM table WHERE ... LIMIT cap)`.
 *   PostgreSQL halts the inner scan after `cap` qualifying rows, bounding work.
 * - **Notes:** A returned value equal to `cap` means "at least `cap`", not an
 *   exact total. The cap defaults to {@link LIST_TOTAL_COUNT_CAP}.
 * - **Side effects:** None beyond the read query.
 */
export async function countWithCap(options: CountWithCapOptions): Promise<number> {
  const { database, table, where } = options;
  const cap = options.cap ?? LIST_TOTAL_COUNT_CAP;
  const cappedSubquery = database
    .select({ marker: sql<number>`1` })
    .from(table)
    .where(where)
    .limit(cap)
    .as('capped_total');
  const rows = await database.select({ count: count() }).from(cappedSubquery);
  return rows[0]?.count ?? 0;
}
