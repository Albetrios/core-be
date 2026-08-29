import { sql as drizzleSql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { database } from '@/infrastructure/database/connection.js';

/**
 * Role-taxonomy locks (migration 20260827050000): five named roles with one
 * semantic each, `core_be_owner` owning every app table, and SECURITY DEFINER
 * functions deliberately NOT owned by it (a non-exempt definer owner is bound by
 * FORCE RLS and every resolver would silently return zero rows).
 */
async function queryRows<T extends Record<string, unknown>>(
  statement: ReturnType<typeof drizzleSql>,
): Promise<T[]> {
  const result = await database.execute<T>(statement);
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

describe('role taxonomy (owner / operator / migrator / app / maintenance)', () => {
  it('all five roles exist; none of the runtime/DDL roles is superuser or BYPASSRLS', async () => {
    const rows = await queryRows<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      drizzleSql`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'core_be%' ORDER BY rolname`,
    );
    const names = rows.map((row) => row.rolname);
    expect(names).toEqual([
      'core_be_app',
      'core_be_maintenance',
      'core_be_migrator',
      'core_be_operator',
      'core_be_owner',
    ]);
    for (const row of rows) {
      expect(row.rolsuper, `${row.rolname} must never be superuser`).toBe(false);
      if (row.rolname !== 'core_be_operator') {
        // Operator MAY carry BYPASSRLS locally (fixture power); every other role is
        // strictly RLS-subject — the boot guards additionally enforce this for the
        // two runtime URLs.
        expect(row.rolbypassrls, `${row.rolname} must never be BYPASSRLS`).toBe(false);
      }
    }
  });

  it('core_be_owner owns every table in the six app schemas (drift lock)', async () => {
    const rows = await queryRows<{ schemaname: string; tablename: string; tableowner: string }>(
      drizzleSql`SELECT schemaname, tablename, tableowner FROM pg_tables
                 WHERE schemaname IN ('auth','tenancy','billing','notify','audit','upload')
                   AND tableowner <> 'core_be_owner'`,
    );
    expect(
      rows.map((row) => `${row.schemaname}.${row.tablename} (${row.tableowner})`),
      'New tables must end with ALTER TABLE ... OWNER TO core_be_owner in their migration.',
    ).toEqual([]);
  });

  it('migrator and operator are owner members; app and maintenance are NOT', async () => {
    const rows = await queryRows<{ role: string; is_member: boolean }>(
      drizzleSql`SELECT r.rolname AS role, pg_has_role(r.rolname, 'core_be_owner', 'member') AS is_member
                 FROM pg_roles r WHERE r.rolname IN ('core_be_migrator','core_be_operator','core_be_app','core_be_maintenance')`,
    );
    const byRole = new Map(rows.map((row) => [row.role, row.is_member]));
    expect(byRole.get('core_be_migrator')).toBe(true);
    expect(byRole.get('core_be_operator')).toBe(true);
    expect(byRole.get('core_be_app')).toBe(false);
    expect(byRole.get('core_be_maintenance')).toBe(false);
  });

  it('SECURITY DEFINER resolver functions are NOT owned by core_be_owner (non-exempt definer would zero them out)', async () => {
    const rows = await queryRows<{ proname: string; owner: string }>(
      drizzleSql`SELECT p.proname, pg_get_userbyid(p.proowner) AS owner
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE p.prosecdef AND n.nspname IN ('auth','tenancy','billing','notify','audit','upload')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.owner, `${row.proname} definer owner`).not.toBe('core_be_owner');
    }
  });
});
