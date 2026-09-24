import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

/**
 * Data migrations run as `core_be_migrator`, a member of `core_be_owner`, and FORCE ROW LEVEL
 * SECURITY binds table owners — so the migrator is RLS-subject on data, by design
 * (20260827050000_role_taxonomy_owner_operator_migrator). A migration that writes a FORCE RLS
 * table therefore matches no policy arm and is rejected, and because the runner stops at the
 * first failure, every later migration is blocked behind it.
 *
 * `20260921000000_team_owner_notify_permissions_backfill` was the first data migration after the
 * migrator became RLS-subject and hit exactly that. It passed hosted — the provider owner bypasses
 * RLS — and failed wherever the migrator does not. The fix lifts FORCE for the duration of the
 * migration's transaction, restoring the owner's exemption, and re-applies it before commit.
 *
 * This proves the fix on real rows rather than an empty table, as `core_be_owner` itself:
 *   1. without the bracket, the same statements are rejected by RLS — the original failure;
 *   2. with it, the grants land for every TEAM Owner role and FORCE is back on afterwards;
 *   3. PERSONAL owners and non-Owner roles are untouched.
 *
 * Every case runs inside a transaction that is rolled back, so nothing here outlives the test.
 */

const MIGRATION_PATH = 'migrations/20260921000000_team_owner_notify_permissions_backfill.sql';
const ROLLBACK = new Error('rollback-sentinel');

type Seeded = { teamOwnerRoleId: number; personalOwnerRoleId: number; teamMemberRoleId: number };

function migrationStatements({ withForceBracket }: { withForceBracket: boolean }): string[] {
  return readFileSync(MIGRATION_PATH, 'utf8')
    .split(/\n--> statement-breakpoint\s*\n?/g)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .filter((statement) => withForceBracket || !/ROW LEVEL SECURITY;\s*$/.test(statement));
}

async function seed(): Promise<Seeded> {
  const email = 'data-migration-owner@example.test';
  const [user] = await sql<{ id: number }[]>`
    INSERT INTO auth.users (public_id, email, email_hash, is_email_verified)
    VALUES ('usr_datamigrationowner01', ${email},
            ${createHash('sha256').update(email).digest('hex')}, true)
    RETURNING id
  `;
  const organizationRow = async (publicId: string, slug: string, type: 'TEAM' | 'PERSONAL') => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO tenancy.organizations (public_id, name, slug, owner_user_id, type)
      VALUES (${publicId}, ${slug}, ${slug}, ${user!.id}, ${type})
      RETURNING id
    `;
    return Number(row!.id);
  };
  const roleRow = async (organizationId: number, publicId: string, name: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO tenancy.roles (public_id, organization_id, name, is_system, created_by_user_id)
      VALUES (${publicId}, ${organizationId}, ${name}, true, ${user!.id})
      RETURNING id
    `;
    return Number(row!.id);
  };

  const team = await organizationRow('org_datamigrationteam001', 'data-migration-team', 'TEAM');
  const personal = await organizationRow(
    'org_datamigrationpers001',
    'data-migration-personal',
    'PERSONAL',
  );
  return {
    teamOwnerRoleId: await roleRow(team, 'mrl_datamigrationtowner1', 'Owner'),
    personalOwnerRoleId: await roleRow(personal, 'mrl_datamigrationpowner1', 'Owner'),
    teamMemberRoleId: await roleRow(team, 'mrl_datamigrationtmember', 'Member'),
  };
}

/** Runs the statements as `core_be_owner` inside a transaction that is always rolled back. */
async function runAsOwnerThenRollBack<T>(
  statements: string[],
  inspect: (transaction: typeof sql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await sql
    .begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL ROLE core_be_owner');
      for (const statement of statements) await transaction.unsafe(statement);
      await transaction.unsafe('RESET ROLE');
      result = await inspect(transaction as unknown as typeof sql);
      throw ROLLBACK;
    })
    .catch((error: unknown) => {
      if (error !== ROLLBACK) throw error;
    });
  return result as T;
}

async function webhookCodesFor(transaction: typeof sql, roleId: number): Promise<string[]> {
  const rows = await transaction<{ permission_code: string }[]>`
    SELECT permission_code FROM tenancy.role_permissions
    WHERE role_id = ${roleId} AND permission_code LIKE 'webhook:%'
    ORDER BY permission_code
  `;
  return rows.map((row) => row.permission_code);
}

describe('data migration as the RLS-subject owner role', () => {
  let seeded: Seeded;

  beforeEach(async () => {
    await cleanupDatabase();
    seeded = await seed();
  });

  it('is rejected by RLS without the FORCE bracket — the original #1180 failure', async () => {
    await expect(
      runAsOwnerThenRollBack(migrationStatements({ withForceBracket: false }), async () => null),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('grants webhook:* to every TEAM Owner role once FORCE is lifted for the transaction', async () => {
    const grants = await runAsOwnerThenRollBack(
      migrationStatements({ withForceBracket: true }),
      async (transaction) => ({
        teamOwner: await webhookCodesFor(transaction, seeded.teamOwnerRoleId),
        personalOwner: await webhookCodesFor(transaction, seeded.personalOwnerRoleId),
        teamMember: await webhookCodesFor(transaction, seeded.teamMemberRoleId),
      }),
    );

    expect(grants.teamOwner).toEqual(['webhook:manage', 'webhook:read']);
    // The backfill is scoped: PERSONAL owners and non-Owner roles must not gain anything.
    expect(grants.personalOwner).toEqual([]);
    expect(grants.teamMember).toEqual([]);
  });

  it('leaves FORCE ROW LEVEL SECURITY back on every table it lifted', async () => {
    const forced = await runAsOwnerThenRollBack(
      migrationStatements({ withForceBracket: true }),
      (transaction) =>
        transaction<{ relname: string; forced: boolean }[]>`
          SELECT relname, relforcerowsecurity AS forced FROM pg_class
          WHERE oid IN ('tenancy.permissions'::regclass, 'tenancy.role_permissions'::regclass,
                        'tenancy.roles'::regclass, 'tenancy.organizations'::regclass)
          ORDER BY relname
        `,
    );

    // Lifting FORCE is only acceptable because it is re-applied before commit. If this ever
    // came back false, the owner would stay exempt from RLS on these tables after the migration.
    expect(forced.map((row) => [row.relname, row.forced])).toEqual([
      ['organizations', true],
      ['permissions', true],
      ['role_permissions', true],
      ['roles', true],
    ]);
  });
});
