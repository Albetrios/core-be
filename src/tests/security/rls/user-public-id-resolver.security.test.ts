import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import {
  grantCoreBeAppRoleForTests,
  executeAsCoreBeAppUser,
} from '@/tests/helpers/rls-matrix.helper.js';

/**
 * Regression guard for the batch user-public-id resolver used by the membership serializer.
 *
 * The membership list/get serializer must emit user PUBLIC ids, but those reads run under
 * ORG-only context (no `app.current_user_public_id`), and `auth.users` is FORCE RLS self-scoped. A plain
 * join would therefore match ZERO rows under the non-superuser `core_be_app` role (invisible under
 * the local/CI superuser). `auth.resolve_user_public_ids_by_ids` is a SECURITY DEFINER batch
 * resolver that bypasses RLS by ownership. This test runs as `core_be_app` precisely because the
 * default superuser would hide the bug; it fails if the resolver is dropped or the serializer
 * reverts to a plain join.
 */
function rowsFromResult(result: unknown): { id: number | string; public_id: string }[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
    id: number | string;
    public_id: string;
  }[];
}

describe('Security: user public-id batch resolver under FORCE RLS', () => {
  beforeAll(async () => {
    await grantCoreBeAppRoleForTests();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('resolves a batch of user public ids under core_be_app with NO user context', async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();

    const resolved = await executeAsCoreBeAppUser(null, async (transaction) => {
      const result = await transaction.execute(
        drizzleSql`SELECT id, public_id FROM auth.resolve_user_public_ids_by_ids(ARRAY[${userA.id}, ${userB.id}]::bigint[])`,
      );
      return rowsFromResult(result);
    });

    const publicIdByInternalId = new Map(resolved.map((row) => [Number(row.id), row.public_id]));
    expect(publicIdByInternalId.get(userA.id)).toBe(userA.public_id);
    expect(publicIdByInternalId.get(userB.id)).toBe(userB.public_id);
  });

  it('a raw join to auth.users under core_be_app (no user context) returns zero rows (documents the bug)', async () => {
    const user = await createTestUser();

    const rawRows = await executeAsCoreBeAppUser(null, async (transaction) => {
      const result = await transaction.execute(
        drizzleSql`SELECT public_id FROM auth.users WHERE id = ${user.id}`,
      );
      return rowsFromResult(result);
    });

    expect(rawRows).toHaveLength(0);
  });
});
