import { sql as drizzleSql } from 'drizzle-orm';
import { sql } from '@/infrastructure/database/connection.js';
import { env } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * Row returned by the boot-time `pg_roles` lookup for the current session user.
 * `rolname` is included so the safety log includes the actual login role.
 */
type SessionRoleSafetyRow = {
  readonly rolname: string;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
};

/**
 * Verifies that the runtime database role bound to `DATABASE_URL` cannot bypass
 * Row Level Security. PostgreSQL never enforces RLS (even `FORCE`d) for
 * superusers or roles with `BYPASSRLS`, so a misconfigured `DATABASE_URL` (e.g.
 * Railway's default `postgres` superuser) silently collapses tenant isolation
 * on every RLS-only read path with **zero error**.
 *
 * @remarks
 * - **Algorithm**: queries `SELECT rolname, rolsuper, rolbypassrls FROM
 *   pg_roles WHERE rolname = session_user`. If `rolsuper` or `rolbypassrls` is
 *   true the boot fails closed in hosted deployments; in local/CI it logs a
 *   loud warning so docker-compose's `postgres` superuser keeps working.
 * - **Failure modes**: throws when the lookup returns no row (defensive — the
 *   session role must be visible in `pg_roles`) or when an RLS-unsafe role is
 *   detected on a hosted deployment.
 * - **Side effects**: emits one `database.rls_safety.*` log line; never sets
 *   any session state.
 * - **Notes**: `session_user` (the actual login role) is preferred over
 *   `current_user` so a later `SET ROLE` cannot mask the underlying privilege.
 *   The application's intended runtime role is `core_be_app` (NOLOGIN, granted
 *   to a dedicated login role in production).
 */
export async function assertDatabaseRoleRlsSafety(): Promise<void> {
  const rows = await sql<SessionRoleSafetyRow[]>`
    SELECT rolname, rolsuper, rolbypassrls
    FROM pg_roles
    WHERE rolname = session_user
  `;

  const row = rows[0];
  if (!row) {
    throw new Error(
      'database.rls_safety.session_role_not_found: pg_roles returned no row for session_user. ' +
        'Verify DATABASE_URL connects with a real role that exists in pg_roles.',
    );
  }

  const { rolname, rolsuper, rolbypassrls } = row;
  if (!(rolsuper || rolbypassrls)) {
    logger.info({ rolname, rolsuper, rolbypassrls }, 'database.rls_safety.ok');
    return;
  }

  if (env.DATABASE_RLS_SAFETY_ENFORCED) {
    throw new Error(
      `database.rls_safety.unsafe_role: DATABASE_URL connects as "${rolname}" with ` +
        `rolsuper=${rolsuper} rolbypassrls=${rolbypassrls}. PostgreSQL skips Row Level Security ` +
        'for superusers and roles with BYPASSRLS, which silently collapses tenant isolation on ' +
        'every RLS-only read path. Point DATABASE_URL at a dedicated non-superuser login role ' +
        'that has been granted `core_be_app` (or make `core_be_app` LOGIN and connect as it). ' +
        'See docs/deployment/runbooks/resource-limits.md.',
    );
  }

  logger.warn(
    { rolname, rolsuper, rolbypassrls },
    'database.rls_safety.unsafe_role_local: superuser/BYPASSRLS detected on a non-hosted deployment; ' +
      'tenant isolation tests will not exercise FORCE ROW LEVEL SECURITY. Acceptable for local docker-compose ' +
      'where the default user is `postgres`; fail-closed in hosted deployments.',
  );
}

/**
 * Same RLS-safety check for the OPTIONAL maintenance pool
 * (`DATABASE_MAINTENANCE_URL` → `core_be_maintenance`). The whole point of the
 * dedicated maintenance connection is that it stays SUBJECT to RLS (bypass
 * authority comes from the policy GUC arms, and later the role arm) — a
 * superuser/BYPASSRLS maintenance URL would silently reintroduce the exempt
 * pool this role exists to eliminate.
 *
 * @remarks
 * - **Algorithm:** no-op when `DATABASE_MAINTENANCE_URL` is unset; otherwise
 *   runs the same `pg_roles` lookup through {@link getMaintenanceDatabase}'s
 *   pool and applies the same enforce/warn split as the primary check.
 * - **Failure modes:** throws on a superuser/BYPASSRLS maintenance role when
 *   `DATABASE_RLS_SAFETY_ENFORCED` is set; throws when the session role is not
 *   visible in `pg_roles`.
 * - **Side effects:** lazily opens the maintenance pool (it would be opened by
 *   the first maintenance context anyway); emits one log line.
 */
export async function assertMaintenanceDatabaseRoleRlsSafety(): Promise<void> {
  if (!env.DATABASE_MAINTENANCE_URL) {
    return;
  }
  const { getMaintenanceDatabase } = await import('@/infrastructure/database/connection.js');
  const result = await getMaintenanceDatabase().execute<SessionRoleSafetyRow>(
    drizzleSql`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = session_user`,
  );
  const rows = Array.isArray(result)
    ? (result as SessionRoleSafetyRow[])
    : ((result as { rows?: SessionRoleSafetyRow[] }).rows ?? []);
  const row = rows[0];
  if (!row) {
    throw new Error(
      'database.rls_safety.maintenance_session_role_not_found: pg_roles returned no row for the ' +
        'DATABASE_MAINTENANCE_URL session_user.',
    );
  }
  const { rolname, rolsuper, rolbypassrls } = row;
  if (!(rolsuper || rolbypassrls)) {
    logger.info({ rolname, rolsuper, rolbypassrls }, 'database.rls_safety.maintenance_ok');
    return;
  }
  if (env.DATABASE_RLS_SAFETY_ENFORCED) {
    throw new Error(
      `database.rls_safety.maintenance_unsafe_role: DATABASE_MAINTENANCE_URL connects as "${rolname}" ` +
        `with rolsuper=${rolsuper} rolbypassrls=${rolbypassrls}. The maintenance pool must stay ` +
        'SUBJECT to RLS — point it at the dedicated core_be_maintenance login role ' +
        '(docs/deployment/runbooks/maintenance-database-role.md).',
    );
  }
  logger.warn(
    { rolname, rolsuper, rolbypassrls },
    'database.rls_safety.maintenance_unsafe_role_local: superuser/BYPASSRLS maintenance role on a ' +
      'non-hosted deployment; maintenance contexts will not exercise FORCE ROW LEVEL SECURITY.',
  );
}
