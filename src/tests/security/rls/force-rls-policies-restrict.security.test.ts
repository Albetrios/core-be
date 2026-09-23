import { describe, expect, it } from 'vitest';
import { sql } from '@/infrastructure/database/connection.js';
import { EXPECTED_FORCE_RLS_TABLES } from '@/tests/helpers/rls-matrix.helper.js';

/**
 * `schema-rls-parity.global.test.ts` asserts that a table **declares** FORCE RLS. It does not
 * assert that the table's policies restrict anything — and those are different properties.
 *
 * `auth.verification_tokens` sat in the FORCE RLS list for months carrying one policy,
 * `TO public USING (true) WITH CHECK (true)`. FORCE RLS was on in name only: any role reaching
 * the table could read or tamper with every password-reset and email-OTP hash, and isolation
 * rested entirely on the application remembering to scope by `user_id` in SQL. Nothing flagged
 * it, because the only question being asked was "is force RLS declared".
 *
 * This asks the question that matters: a FORCE RLS table must not grant unrestricted access to
 * `public`. A wide `USING (true)` is fine when it is scoped to the runtime role — that is the
 * established `*_deny_all` + `*_app_access` pair — but never to `public`.
 */

type LivePolicy = {
  schemaname: string;
  tablename: string;
  policyname: string;
  roles: string;
  qual: string | null;
  with_check: string | null;
};

/** A qualifier that filters nothing — `true`, or absent (which Postgres treats as permitting). */
function permitsEverything(clause: string | null): boolean {
  if (clause === null) return true;
  return clause.trim().toLowerCase() === 'true';
}

describe('FORCE RLS tables must carry policies that actually restrict', () => {
  it('no FORCE RLS table grants unrestricted access to PUBLIC', async () => {
    const policies = await sql<LivePolicy[]>`
      SELECT schemaname, tablename, policyname, roles::text AS roles, qual, with_check
      FROM pg_policies
      ORDER BY schemaname, tablename, policyname
    `;

    const forceRlsKeys = new Set(
      EXPECTED_FORCE_RLS_TABLES.map((table) => `${table.schemaName}.${table.tableName}`),
    );

    const unrestricted = policies
      .filter((policy) => forceRlsKeys.has(`${policy.schemaname}.${policy.tablename}`))
      // `{public}` is the role list Postgres reports for a `TO PUBLIC` policy.
      .filter((policy) => policy.roles === '{public}')
      .filter((policy) => permitsEverything(policy.qual) && permitsEverything(policy.with_check))
      .map((policy) => `${policy.schemaname}.${policy.tablename} → ${policy.policyname}`);

    expect(unrestricted).toEqual([]);
  });
});
