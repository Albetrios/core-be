import { describe, expect, it } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { database } from '@/infrastructure/database/connection.js';

/**
 * B-track groundwork: the dedicated maintenance role exists after migrations,
 * stays NOLOGIN until an operator provisions it (runbook:
 * docs/deployment/runbooks/maintenance-database-role.md), and carries the
 * data-plane grants bypass workers need.
 */
describe('core_be_maintenance role (migration 20260827010000)', () => {
  it('exists, is NOLOGIN by default, and holds data-plane grants', async () => {
    const rows = await database.execute<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      can_select_sessions: boolean;
      can_delete_logs: boolean;
    }>(
      drizzleSql`
        SELECT r.rolcanlogin,
               r.rolsuper,
               r.rolbypassrls,
               has_table_privilege('core_be_maintenance', 'auth.sessions', 'SELECT') AS can_select_sessions,
               has_table_privilege('core_be_maintenance', 'audit.logs', 'DELETE') AS can_delete_logs
        FROM pg_roles r
        WHERE r.rolname = 'core_be_maintenance'
      `,
    );
    const resultRows = Array.isArray(rows)
      ? rows
      : ((rows as { rows?: Record<string, boolean>[] }).rows ?? []);
    expect(resultRows).toHaveLength(1);
    const role = resultRows[0] as Record<string, boolean>;
    // NOLOGIN until per-environment provisioning; never superuser / BYPASSRLS —
    // the role must stay SUBJECT to RLS so bypass arms remain policy-governed.
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
    expect(role.can_select_sessions).toBe(true);
    expect(role.can_delete_logs).toBe(true);
  });
});
