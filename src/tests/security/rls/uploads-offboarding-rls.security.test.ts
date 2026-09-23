import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { database, sql } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { grantCoreBeAppRoleForTests } from '@/tests/helpers/rls-matrix.helper.js';

/**
 * Offboarding erases uploads through `UploadService.tombstoneAllBy{User,Organization}Id`, and
 * those statements reach `upload.uploads` — a FORCE RLS table whose every policy arm is
 * GUC-gated. They previously ran with **no database context at all**, so in production they
 * matched nothing: the keyset read returned zero rows, no S3 object was deleted, the
 * soft-delete updated zero rows, and organization / account deletion reported success while
 * every upload row and object survived indefinitely. That is a GDPR Article 17 failure.
 *
 * It was invisible everywhere it was tested. Compose creates `POSTGRES_USER: core` as a
 * superuser, and the local operator role carries `rolbypassrls` — both bypass RLS, so the rows
 * came back in dev and CI and only vanished where it mattered.
 *
 * This suite pins the invariant the fix rests on, as `core_be_app` (the production role, which
 * is RLS-subject):
 *
 *   1. with NO GUC set, an upload row is invisible — the exact production failure;
 *   2. under the `app.global_retention_cleanup` arm the offboarding sweep now uses, the same
 *      row is both readable and tombstonable;
 *   3. that arm covers organization-scoped AND user-scoped (`organization_id IS NULL`) rows,
 *      because `uploads_owner_access` alone cannot see the former and the tenant arm alone
 *      cannot see the latter.
 */

type SeededUploads = {
  organizationScopedId: number;
  userScopedId: number;
};

async function runAsApplicationRole<T>(
  guc: { name: string; value: string } | null,
  callback: (transaction: typeof database) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
    if (guc) {
      await transaction.execute(drizzleSql`SELECT set_config(${guc.name}, ${guc.value}, true)`);
    }
    return callback(transaction as unknown as typeof database);
  });
}

async function countVisibleUploads(transaction: typeof database): Promise<number> {
  const result = await transaction.execute(
    drizzleSql`SELECT count(*)::int AS count FROM upload.uploads WHERE deleted_at IS NULL`,
  );
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
    count: number;
  }[];
  return Number(rows[0]?.count ?? 0);
}

describe('uploads offboarding RLS (as core_be_app — the production role)', () => {
  let seeded: SeededUploads;

  beforeAll(async () => {
    await cleanupDatabase();
    await grantCoreBeAppRoleForTests();

    // Seeded through the privileged harness connection; the assertions below all run as
    // `core_be_app`, which is subject to RLS.
    const seedEmail = 'uploads-rls@example.test';
    const [user] = await sql<{ id: number }[]>`
      INSERT INTO auth.users (public_id, email, email_hash, is_email_verified)
      VALUES (
        'usr_uploadsrlsseeduser01',
        ${seedEmail},
        ${createHash('sha256').update(seedEmail).digest('hex')},
        true
      )
      RETURNING id
    `;
    const [organization] = await sql<{ id: number }[]>`
      INSERT INTO tenancy.organizations (public_id, name, slug, owner_user_id, type)
      VALUES ('org_uploadsrlsseedorg001', 'Uploads RLS', 'uploads-rls', ${user!.id}, 'TEAM')
      RETURNING id
    `;
    const [organizationScoped] = await sql<{ id: number }[]>`
      INSERT INTO upload.uploads
        (public_id, user_id, organization_id, file_name, file_key, mime_type, file_size, bucket, status)
      VALUES ('upl_uploadsrlsorgscoped1', ${user!.id}, ${organization!.id},
              'org.png', 'uploads/org.png', 'image/png', 10, 'test-bucket', 'UPLOADED')
      RETURNING id
    `;
    const [userScoped] = await sql<{ id: number }[]>`
      INSERT INTO upload.uploads
        (public_id, user_id, organization_id, file_name, file_key, mime_type, file_size, bucket, status)
      VALUES ('upl_uploadsrlsuserscoped', ${user!.id}, NULL,
              'me.png', 'uploads/me.png', 'image/png', 10, 'test-bucket', 'UPLOADED')
      RETURNING id
    `;

    seeded = {
      organizationScopedId: Number(organizationScoped!.id),
      userScopedId: Number(userScoped!.id),
    };
  });

  it('sees NOTHING with no GUC set — the silent-erasure failure the offboarding sweep had', async () => {
    const visible = await runAsApplicationRole(null, countVisibleUploads);

    // This is the whole bug in one assertion: the sweep read this same zero and concluded there
    // was nothing to erase.
    expect(visible).toBe(0);
  });

  it('hides an ORGANIZATION-scoped upload from a user-scoped context', async () => {
    // `uploads_owner_access` is `organization_id IS NULL AND user_id = <user GUC>`, so arming
    // only the user GUC can never reach an organization-scoped row — the tenant arm needs the
    // organization GUC, which a user scope does not set. Any read path that arms only the user
    // scope therefore 404s every organization-scoped upload, including organization logos.
    const visible = await runAsApplicationRole(
      { name: 'app.current_user_public_id', value: 'usr_uploadsrlsseeduser01' },
      countVisibleUploads,
    );

    // The user's own upload is reachable; the organization-scoped one is not.
    expect(visible).toBe(1);
  });

  it('reads and tombstones both scopes under the retention arm the sweep now runs in', async () => {
    const visibleUnderRetention = await runAsApplicationRole(
      { name: 'app.global_retention_cleanup', value: 'true' },
      countVisibleUploads,
    );

    // Organization-scoped and user-scoped alike — neither the tenant arm nor the owner arm
    // covers both, which is why the sweep needs this one.
    expect(visibleUnderRetention).toBe(2);

    const tombstoned = await runAsApplicationRole(
      { name: 'app.global_retention_cleanup', value: 'true' },
      async (transaction) => {
        const result = await transaction.execute(
          drizzleSql`UPDATE upload.uploads SET deleted_at = now()
                     WHERE id IN (${seeded.organizationScopedId}, ${seeded.userScopedId})
                       AND deleted_at IS NULL
                     RETURNING id`,
        );
        const rows = (
          Array.isArray(result) ? result : (result as { rows: unknown[] }).rows
        ) as unknown[];
        return rows.length;
      },
    );

    // The UPDATE has to satisfy WITH CHECK as well as USING — migration
    // 20260827030000 added the retention arm to WITH CHECK for exactly this.
    expect(tombstoned).toBe(2);
  });
});
