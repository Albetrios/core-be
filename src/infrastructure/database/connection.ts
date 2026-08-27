import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { THIRTY_SECONDS_MS } from '@/shared/constants/ttl.constants.js';
import { env } from '@/shared/config/env.config.js';
import { getShutdownTimeoutMs } from '@/infrastructure/queue/worker-runtime/shutdown-timing.util.js';
import {
  isNeonPoolerConnection,
  isStrictDatabaseTlsVerification,
  parseSslMode,
} from '@/infrastructure/database/utils/connection-url.util.js';

import {
  DEFAULT_DATABASE_POOL_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS,
  DEFAULT_DATABASE_POOL_MAX,
  DEFAULT_DATABASE_POOL_MAX_LIFETIME_SECONDS,
} from '@/infrastructure/database/pool/pool.constants.js';

export { isNeonPoolerConnection };
export { DEFAULT_DATABASE_POOL_MAX };

/**
 * Builds the postgres.js client options from `DATABASE_URL` + env: SSL mode parsed from
 * the URL (and tightened by `DATABASE_SSL_REJECT_UNAUTHORIZED`), per-connection
 * `statement_timeout` / `idle_in_transaction_session_timeout` / `lock_timeout`, pool sizing, and a
 * Neon-pooler-aware `prepare: false` toggle.
 */
export function buildPostgresOptions(databaseUrl: string) {
  const sslMode = parseSslMode(databaseUrl);
  const strictVerification = isStrictDatabaseTlsVerification({
    databaseUrl,
    rejectUnauthorizedOverride: env.DATABASE_SSL_REJECT_UNAUTHORIZED,
  });

  const sslEnabled = sslMode === 'disable' ? false : sslMode !== null || env.DATABASE_SSL_ENABLED;

  const ssl = sslEnabled ? { rejectUnauthorized: strictVerification } : false;

  /**
   * HTTP handlers use scoped RLS contexts (short transactions per unit-of-work), so the
   * connection-level `statement_timeout` must cap runaway queries on autocommit paths
   * (default 5s via `DATABASE_HTTP_STATEMENT_TIMEOUT_MS`).
   */
  const connectionStatementTimeoutMs =
    env.DATABASE_HTTP_STATEMENT_TIMEOUT_MS > 0
      ? env.DATABASE_HTTP_STATEMENT_TIMEOUT_MS
      : (env.DATABASE_STATEMENT_TIMEOUT_MS ?? THIRTY_SECONDS_MS);
  const idleInTransactionTimeoutMs =
    env.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS ?? THIRTY_SECONDS_MS;

  /**
   * The three timeouts catch three different failures and do not substitute for one another:
   * `statement_timeout` a runaway query, `idle_in_transaction_session_timeout` an abandoned
   * transaction, and `lock_timeout` a statement waiting behind someone else's lock. A lock waiter
   * is neither idle nor executing, so without `lock_timeout` it holds its pooled connection for an
   * unbounded wait and concurrent waiters turn lock contention into pool exhaustion.
   */
  const connectionParameters: Record<string, string> = {
    statement_timeout: String(connectionStatementTimeoutMs),
    idle_in_transaction_session_timeout: String(idleInTransactionTimeoutMs),
    lock_timeout: String(env.DATABASE_LOCK_TIMEOUT_MS),
  };

  return {
    max: env.DATABASE_POOL_MAX,
    idle_timeout:
      env.DATABASE_POOL_IDLE_TIMEOUT_SECONDS ?? DEFAULT_DATABASE_POOL_IDLE_TIMEOUT_SECONDS,
    connect_timeout:
      env.DATABASE_POOL_CONNECT_TIMEOUT_SECONDS ?? DEFAULT_DATABASE_POOL_CONNECT_TIMEOUT_SECONDS,
    max_lifetime:
      env.DATABASE_POOL_MAX_LIFETIME_SECONDS ?? DEFAULT_DATABASE_POOL_MAX_LIFETIME_SECONDS,
    ssl,
    connection: connectionParameters,
    ...(isNeonPoolerConnection(databaseUrl) ? { prepare: false as const } : {}),
  };
}

/**
 * postgres.js pools TCP connections per process. Managed Postgres (Neon, Railway) may close
 * idle connections around ~5 minutes — if you see sporadic ECONNRESET, validate provider
 * keepalive / proxy settings.
 */
export const sql = postgres(env.DATABASE_URL, buildPostgresOptions(env.DATABASE_URL));

/**
 * Process-wide Drizzle handle bound to the {@link sql} postgres.js pool — the
 * default database accessor for repositories and ad-hoc queries when no
 * request/worker context has pinned a transaction-scoped handle in ALS.
 */
export const database = drizzle(sql);

let maintenanceSql: ReturnType<typeof postgres> | undefined;
let maintenanceDatabaseHandle: ReturnType<typeof drizzle> | undefined;

/**
 * Drizzle handle for maintenance (RLS-bypass) database contexts. When
 * `DATABASE_MAINTENANCE_URL` is set, this is a separate lazily-created pool
 * connecting as the dedicated `core_be_maintenance` role; when unset (the
 * default), it is the shared {@link database} pool — identical to historical
 * behavior.
 *
 * @remarks
 * - **Notes:** the split exists so bypass authority can eventually be gated at
 *   the CONNECTION level (`current_user = 'core_be_maintenance'` policy arms),
 *   not only via `app.*` GUCs. Provisioning steps:
 *   `docs/deployment/runbooks/maintenance-database-role.md`. The lazy pool uses
 *   the same tuned {@link buildPostgresOptions} as the primary pool.
 */
export function getMaintenanceDatabase(): ReturnType<typeof drizzle> {
  if (!env.DATABASE_MAINTENANCE_URL) {
    return database;
  }
  if (maintenanceDatabaseHandle === undefined) {
    maintenanceSql = postgres(
      env.DATABASE_MAINTENANCE_URL,
      buildPostgresOptions(env.DATABASE_MAINTENANCE_URL),
    );
    maintenanceDatabaseHandle = drizzle(maintenanceSql);
  }
  return maintenanceDatabaseHandle;
}

/**
 * Drains the postgres.js pool and waits up to the shared shutdown drain budget
 * (`SHUTDOWN_TIMEOUT_MS`, 15s default) for in-flight queries before terminating.
 * Called from the shutdown middleware.
 *
 * @remarks
 * Uses {@link getShutdownTimeoutMs} (not its own 30s default) so the database
 * drain budget is always ≤ the force-exit watchdog (drain budget + buffer). A
 * larger local default could let the watchdog kill the drain mid-flight, severing
 * in-flight queries instead of letting them finish.
 */
export async function closeDatabase(): Promise<void> {
  const timeout = getShutdownTimeoutMs();
  await sql.end({ timeout });
  if (maintenanceSql !== undefined) {
    await maintenanceSql.end({ timeout });
    maintenanceSql = undefined;
    maintenanceDatabaseHandle = undefined;
  }
}
