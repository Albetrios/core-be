import { describe, expect, it } from 'vitest';
import { lintMigrationFileContent } from '@/scripts/validators/migration/lint-migrations.js';

/**
 * The migrator is RLS-subject: `core_be_migrator` is a member of `core_be_owner`, and FORCE ROW
 * LEVEL SECURITY binds table owners. A data migration that WRITES a FORCE RLS table is rejected;
 * one that READS from one is handed zero rows and succeeds having done nothing. Hosted
 * migrations run as a provider owner that bypasses RLS, so both pass there and fail only where
 * the migrator is RLS-subject.
 *
 * Both failure modes happened for real on `20260921000000_team_owner_notify_permissions_backfill`:
 * the original file was rejected outright and blocked every later migration, and the first fix
 * lifted FORCE on the two tables it wrote but not the two it read from — so it would have
 * reported success while granting nothing. These cases are those two files, in miniature.
 */

const AFTER_TAXONOMY = '29990101000000_backfill.sql';

const BACKFILL_BODY = `INSERT INTO tenancy.permissions (code, name, category)
VALUES ('webhook:read', 'View Webhooks', 'notify')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO tenancy.role_permissions (role_id, permission_code, created_by_user_id)
SELECT r.id, 'webhook:read', o.owner_user_id
FROM tenancy.roles r
INNER JOIN tenancy.organizations o ON o.id = r.organization_id
ON CONFLICT (role_id, permission_code) DO NOTHING;`;

function bracket(tables: readonly string[], body: string): string {
  const lift = tables.map((table) => `ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`);
  const reapply = tables.map((table) => `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
  return [...lift, body, ...reapply].join('\n--> statement-breakpoint\n');
}

function flaggedTables(filename: string, sql: string): string[] {
  return lintMigrationFileContent(filename, sql)
    .violations.filter(
      (violation) => violation.ruleId === 'force_rls_data_migration_without_owner_bracket',
    )
    .map((violation) => violation.message.split(':')[0] ?? '')
    .sort();
}

describe('lint-migrations: force_rls_data_migration_without_owner_bracket', () => {
  it('flags the original backfill — every FORCE RLS table it writes or reads', () => {
    expect(flaggedTables(AFTER_TAXONOMY, BACKFILL_BODY)).toEqual([
      'tenancy.organizations',
      'tenancy.permissions',
      'tenancy.role_permissions',
      'tenancy.roles',
    ]);
  });

  it('flags a bracket that covers only the tables WRITTEN — the silent zero-row fix', () => {
    const writeSideOnly = bracket(
      ['tenancy.permissions', 'tenancy.role_permissions'],
      BACKFILL_BODY,
    );

    // The INSERT would run, SELECT zero source rows through RLS, and report success having
    // granted nothing — worse than the loud rejection it replaced.
    expect(flaggedTables(AFTER_TAXONOMY, writeSideOnly)).toEqual([
      'tenancy.organizations',
      'tenancy.roles',
    ]);
  });

  it('passes once every FORCE RLS table the file touches is lifted and re-applied', () => {
    const fullBracket = bracket(
      ['tenancy.permissions', 'tenancy.role_permissions', 'tenancy.roles', 'tenancy.organizations'],
      BACKFILL_BODY,
    );
    expect(flaggedTables(AFTER_TAXONOMY, fullBracket)).toEqual([]);
  });

  it('flags a table that is lifted but never re-forced', () => {
    const liftedOnly = [
      'ALTER TABLE tenancy.permissions NO FORCE ROW LEVEL SECURITY;',
      "INSERT INTO tenancy.permissions (code, name, category) VALUES ('a:b', 'A', 'a');",
    ].join('\n--> statement-breakpoint\n');

    // Leaving FORCE off would keep the owner exempt from RLS on that table permanently.
    expect(flaggedTables(AFTER_TAXONOMY, liftedOnly)).toEqual(['tenancy.permissions']);
  });

  it('ignores migrations that predate the RLS-subject migrator', () => {
    // Those ran as a role that bypassed RLS; they are historical record, not a risk.
    expect(
      flaggedTables('20260628150000_team_owner_billing_permissions_backfill.sql', BACKFILL_BODY),
    ).toEqual([]);
  });

  it('ignores DDL-only migrations, including ones that change FORCE RLS policies', () => {
    const policyOnly = `DROP POLICY IF EXISTS permissions_deny_all ON tenancy.permissions;
--> statement-breakpoint
CREATE POLICY permissions_deny_all ON tenancy.permissions AS PERMISSIVE FOR ALL TO PUBLIC USING (false);`;
    expect(flaggedTables(AFTER_TAXONOMY, policyOnly)).toEqual([]);
  });

  it('does not count a table named only in a comment', () => {
    const commentOnly = `-- Backfills rows that tenancy.roles used to hold.
INSERT INTO notify.webhook_event_catalog (event) VALUES ('x.y');`;
    expect(flaggedTables(AFTER_TAXONOMY, commentOnly)).toEqual([]);
  });
});
