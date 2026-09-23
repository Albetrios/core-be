import '@/shared/config/load-env-files.js';
import { spawnSync } from 'node:child_process';

/**
 * The Postgres role the application actually runs as in production. Unlike the roles the test
 * harness normally connects with, it is **subject to RLS**.
 */
const APPLICATION_DATABASE_ROLE = 'core_be_app';

/**
 * Rewrites a Postgres connection URL so the session opens as {@link APPLICATION_DATABASE_ROLE}.
 *
 * @remarks
 * Uses libpq's `options=-c role=…`, which Postgres applies at connection time — so every
 * statement on that connection, including ones inside the app's own transactions, is
 * RLS-subject. No `ALTER ROLE` and no superuser needed, which matters because the harness
 * role cannot grant itself anything.
 */
export function withApplicationDatabaseRole(connectionUrl: string): string {
  const url = new URL(connectionUrl);
  url.searchParams.set('options', `-c role=${APPLICATION_DATABASE_ROLE}`);
  return url.toString();
}

/**
 * Runs Vitest against a connection that does **not** bypass RLS.
 *
 * @remarks
 * - **Why:** the roles the suites normally use bypass row-level security — Compose creates
 *   `POSTGRES_USER: core` as a superuser, and the local operator role carries `rolbypassrls`.
 *   Anything that depends on a policy matching is therefore untested by default: it returns
 *   rows in dev and CI and returns nothing in production. That is precisely how offboarding
 *   came to erase no uploads while reporting success, with every check green.
 * - **Algorithm:** loads the environment, rewrites `DATABASE_URL` to open as the application
 *   role, and execs `vitest run` with the caller's arguments.
 * - **Failure modes:** exits non-zero when `DATABASE_URL` is absent or Vitest fails. A failure
 *   under this runner that passes normally is the interesting case — it means the code depends
 *   on bypassing RLS.
 * - **Side effects:** spawns a child process; leaves the ambient environment untouched.
 */
export function runVitestAsApplicationRole(vitestArguments: readonly string[]): number {
  const connectionUrl = process.env.DATABASE_URL;
  if (!connectionUrl) {
    console.error('DATABASE_URL is not set — cannot run the RLS-subject lane.');
    return 1;
  }

  const result = spawnSync('pnpm', ['vitest', 'run', ...vitestArguments], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: withApplicationDatabaseRole(connectionUrl) },
  });
  return result.status ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runVitestAsApplicationRole(process.argv.slice(2)));
}
