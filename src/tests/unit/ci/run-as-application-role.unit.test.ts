import { describe, expect, it } from 'vitest';
import { withApplicationDatabaseRole } from '@tooling/vitest/run-as-application-role.js';

/**
 * The suites normally connect with roles that **bypass** row-level security — Compose creates
 * `POSTGRES_USER: core` as a superuser and the local operator role carries `rolbypassrls`. So
 * anything relying on a policy matching is untested by default: rows come back in dev and CI
 * and vanish in production. `pnpm test:rls-role` exists to close that, and it only closes it if
 * the URL rewrite actually lands — a silently malformed option would run the whole lane on the
 * bypassing role again and report a reassuring green.
 */
describe('withApplicationDatabaseRole', () => {
  it('adds the libpq role option that makes the session RLS-subject', () => {
    const rewritten = withApplicationDatabaseRole('postgresql://user:pw@localhost:5432/core');

    // libpq applies `options` at connection time, so every statement on the connection —
    // including ones inside the application's own transactions — runs as this role.
    expect(new URL(rewritten).searchParams.get('options')).toBe('-c role=core_be_app');
  });

  it('preserves the host, database and credentials it was given', () => {
    const rewritten = new URL(
      withApplicationDatabaseRole('postgresql://user:pw@db.internal:6432/core'),
    );

    expect(rewritten.hostname).toBe('db.internal');
    expect(rewritten.port).toBe('6432');
    expect(rewritten.pathname).toBe('/core');
    expect(rewritten.username).toBe('user');
  });

  it('keeps existing query parameters and overrides only a previous role option', () => {
    const rewritten = new URL(
      withApplicationDatabaseRole(
        'postgresql://user:pw@localhost:5432/core?sslmode=require&options=-c+role%3Dsomeone_else',
      ),
    );

    // Dropping `sslmode` would quietly downgrade the connection; leaving a stale role option
    // would run the lane as the wrong role, which is the failure this whole lane exists to
    // avoid.
    expect(rewritten.searchParams.get('sslmode')).toBe('require');
    expect(rewritten.searchParams.get('options')).toBe('-c role=core_be_app');
  });
});
