import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { buildPostgresOptions, database, sql } from '@/infrastructure/database/connection.js';

let operatorSql: ReturnType<typeof postgres> | undefined;
let operatorDatabaseHandle: ReturnType<typeof drizzle> | undefined;

/**
 * `DATABASE_OPERATOR_URL`, when it points somewhere other than the pool under test.
 *
 * @remarks
 * The two only diverge under `pnpm test:rls-role`, where `src/tests/setup.ts` re-opens
 * `DATABASE_URL` as the RLS-subject `core_be_app` role and keeps the operator URL for the
 * harness. Everywhere else they are the same connection — locally `setup.ts` already points
 * `DATABASE_URL` at the operator, and CI connects as the superuser directly — so there is no
 * second pool to open.
 */
function distinctOperatorUrl(): string | undefined {
  const operatorUrl = process.env.DATABASE_OPERATOR_URL;
  if (!operatorUrl || operatorUrl === process.env.DATABASE_URL) return undefined;
  return operatorUrl;
}

/**
 * Raw postgres.js client on the operator connection, for harness work the application role may
 * not do.
 *
 * @remarks
 * Same shape as `getMaintenanceDatabase()` in `connection.ts`: a lazily-created pool on a
 * separate URL, built with the same {@link buildPostgresOptions}, falling back to the shared
 * {@link sql} when no distinct URL is configured. So outside the RLS lane this returns the
 * existing client and nothing changes. Used for `cleanupDatabase`'s TRUNCATE, which has no
 * Drizzle equivalent.
 */
export function getOperatorSql(): ReturnType<typeof postgres> {
  const operatorUrl = distinctOperatorUrl();
  if (!operatorUrl) return sql;
  if (operatorSql === undefined) {
    operatorSql = postgres(operatorUrl, buildPostgresOptions(operatorUrl));
  }
  return operatorSql;
}

/**
 * Drizzle handle on the operator connection, for fixture setup.
 *
 * @remarks
 * - **Why:** under `pnpm test:rls-role` the pool under test is `core_be_app`, which is subject
 *   to row-level security. Fixtures seed preconditions — often deliberately cross-tenant ones —
 *   and the harness truncates every table between suites; neither is something the application
 *   role may do. Seed on the operator, assert through the application's own pool.
 * - **Algorithm:** mirrors `getMaintenanceDatabase()` — the shared {@link database} when there
 *   is no distinct operator URL, otherwise a lazily-created Drizzle handle over
 *   {@link getOperatorSql}.
 * - **Notes:** the two root factories, `user.factory.ts` and `organization.factory.ts`,
 *   deliberately insert through the application's own context instead — for the tables every
 *   other fixture hangs off, "can this row be created the way production creates it" is itself
 *   worth asserting.
 */
export function getOperatorDatabase(): ReturnType<typeof drizzle> {
  if (!distinctOperatorUrl()) return database;
  if (operatorDatabaseHandle === undefined) {
    operatorDatabaseHandle = drizzle(getOperatorSql());
  }
  return operatorDatabaseHandle;
}
