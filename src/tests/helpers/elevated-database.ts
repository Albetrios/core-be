import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * A database handle that is deliberately **not** subject to row-level security, for the parts
 * of the harness that cannot work under it.
 *
 * @remarks
 * `pnpm test:rls-role` opens the application pool as `core_be_app`, which is RLS-subject — that
 * is the whole point, because otherwise a path that reaches a FORCE RLS table without a
 * database context reads rows in tests and none in production. But the harness itself needs
 * elevation for things the application never does: `TRUNCATE`ing every table between suites,
 * and seeding deliberately cross-tenant fixtures that no single tenant context could create.
 *
 * So the two are split. `src/tests/setup.ts` stashes the pre-rewrite URL here before pointing
 * `DATABASE_URL` at the application role; fixtures and cleanup use this handle, application
 * code uses the pool under test. Without the split the suites die on
 * `permission denied for table users` inside `cleanupDatabase` before asserting anything.
 *
 * Outside that lane there is nothing to split, so this resolves to the ordinary
 * `DATABASE_URL` and behaves exactly as before.
 */
let elevatedClient: ReturnType<typeof postgres> | undefined;

/** The environment variable `src/tests/setup.ts` stashes the pre-role-rewrite URL in. */
export const ELEVATED_DATABASE_URL_VARIABLE = 'TEST_ELEVATED_DATABASE_URL';

/**
 * Resolves the connection string harness fixtures and cleanup should use.
 *
 * @remarks
 * Falls back to `DATABASE_URL` when no role rewrite is in play, so ordinary runs are unchanged.
 */
export function resolveElevatedDatabaseUrl(): string {
  const stashed = process.env[ELEVATED_DATABASE_URL_VARIABLE];
  const fallback = process.env.DATABASE_URL;
  const resolved = stashed ?? fallback;
  if (!resolved) {
    throw new Error(
      `Neither ${ELEVATED_DATABASE_URL_VARIABLE} nor DATABASE_URL is set — the test harness has no database handle.`,
    );
  }
  return resolved;
}

/**
 * The lazily-created elevated postgres.js client for harness fixtures and cleanup.
 *
 * @remarks
 * Deliberately a separate pool from `connection.ts`'s: that one is the pool **under test** and
 * may be RLS-subject. Small `max` because this handle only ever runs setup and teardown.
 */
export function getElevatedSql(): ReturnType<typeof postgres> {
  if (!elevatedClient) {
    elevatedClient = postgres(resolveElevatedDatabaseUrl(), { max: 4, onnotice: () => {} });
  }
  return elevatedClient;
}

/** Closes the elevated pool, if one was opened. */
export async function closeElevatedSql(): Promise<void> {
  if (!elevatedClient) return;
  const client = elevatedClient;
  elevatedClient = undefined;
  await client.end({ timeout: 5 });
}

let elevatedDatabaseHandle: ReturnType<typeof drizzle> | undefined;

/**
 * A Drizzle handle over {@link getElevatedSql}, for fixture factories.
 *
 * @remarks
 * Fixtures seed *preconditions*, they are not the code under test. Seeding a leaf row through
 * whichever tenant context would satisfy its policy adds ceremony to every factory and tests
 * the factory rather than the application. So fixtures seed with privilege and the assertions
 * run through the application's own pool, which under `pnpm test:rls-role` is RLS-subject —
 * seed elevated, assert as the app.
 *
 * The two root factories (`user.factory.ts`, `organization.factory.ts`) deliberately do NOT use
 * this: they insert through the same context the application uses, because "can this row be
 * created the way production creates it" is itself worth asserting for the two tables every
 * other fixture hangs off.
 */
export function getElevatedDatabase(): ReturnType<typeof drizzle> {
  if (!elevatedDatabaseHandle) {
    elevatedDatabaseHandle = drizzle(getElevatedSql());
  }
  return elevatedDatabaseHandle;
}
