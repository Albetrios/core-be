import '@/shared/config/load-env-files.js';
import { spawnSync } from 'node:child_process';

/**
 * The Postgres role the application runs as in production. Unlike the roles the harness
 * normally connects with, it is **subject to row-level security**.
 */
export const APPLICATION_DATABASE_ROLE = 'core_be_app';

/**
 * The projects this lane covers.
 *
 * @remarks
 * `e2e` exercises the HTTP route surface end to end; `integration` exercises services, workers
 * and repositories directly — where the upload offboarding sweep read zero rows for months and
 * where organization-scoped upload writes 404'd. Both are where a missing database context goes
 * silent. `security` is left out on purpose: its RLS suites already opt into `core_be_app` per
 * statement, which is the stronger assertion for policies themselves.
 *
 * Three integration suites skip themselves under this lane (`describe.runIf`, keyed on
 * `TEST_DATABASE_ROLE`) because they test infrastructure owned by a role other than the
 * application: `transaction-rollback`, `migrations-forward` and `full-seed`. Each states why.
 */
const DEFAULT_PROJECTS = ['--project', 'e2e', '--project', 'integration'];

/**
 * Runs Vitest with the pool under test opened as {@link APPLICATION_DATABASE_ROLE}.
 *
 * @remarks
 * - **Why:** every other lane connects with a role that BYPASSES RLS — Compose creates
 *   `POSTGRES_USER: core` as a superuser and the local operator role carries `rolbypassrls`. A
 *   path that reaches a FORCE RLS table without a database context therefore matches no policy
 *   arm, reads zero rows, and reports success, while returning nothing in production. That is
 *   how organization and account deletion came to erase no uploads with every check green.
 * - **Algorithm:** sets `TEST_DATABASE_ROLE`, which `src/tests/setup.ts` applies AFTER env
 *   loading and after its own operator-handle swap. It is deliberately not a rewritten
 *   `DATABASE_URL`: the child re-loads the machine-local env file with `override: true`, which
 *   would clobber an injected URL and silently put the lane back on the bypassing role — green,
 *   and proving nothing.
 * - **Failure modes:** exits non-zero when Vitest fails. A failure here that passes on the
 *   normal lane is the interesting case: it means the code, or the fixture, depends on
 *   bypassing RLS.
 * - **Side effects:** spawns a child process; leaves the ambient environment untouched.
 */
export function runVitestAsApplicationRole(vitestArguments: readonly string[]): number {
  const projectArguments = vitestArguments.length > 0 ? vitestArguments : DEFAULT_PROJECTS;
  const result = spawnSync('pnpm', ['vitest', 'run', ...projectArguments], {
    stdio: 'inherit',
    env: { ...process.env, TEST_DATABASE_ROLE: APPLICATION_DATABASE_ROLE },
  });
  return result.status ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runVitestAsApplicationRole(process.argv.slice(2)));
}
