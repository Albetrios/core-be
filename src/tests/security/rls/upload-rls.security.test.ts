import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql as drizzleSql, eq } from 'drizzle-orm';
import { sql } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { database } from '@/infrastructure/database/connection.js';
import { uploads } from '@/domains/upload/upload.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import {
  executeAsCoreBeAppTenant,
  executeAsCoreBeAppUser,
} from '@/tests/helpers/rls-matrix.helper.js';

/** Flattens an error and its `.cause` chain to one string so the postgres SQLSTATE is matchable. */
function flattenErrorChain(error: unknown): string {
  let text = '';
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current; depth += 1) {
    text += String(current);
    current = (current as { cause?: unknown }).cause;
  }
  return text;
}

/** Org-scoped upload row (organization_id set) — needs organization RLS context to INSERT. */
function buildOrgUploadValues(userId: number, organizationId: number) {
  return {
    public_id: generatePublicId('upload'),
    user_id: userId,
    organization_id: organizationId,
    file_name: 'logo.png',
    file_key: `organization-logos/${generatePublicId('upload')}/logo.png`,
    mime_type: 'image/png',
    file_size: 1024,
    storage_provider: 's3' as const,
    bucket: 'test-bucket',
    status: 'PENDING' as const,
  };
}

/** User-scoped upload row (organization_id NULL) — owner-access policy under user context. */
function buildUserUploadValues(userId: number) {
  return {
    public_id: generatePublicId('upload'),
    user_id: userId,
    organization_id: null,
    file_name: 'avatar.png',
    file_key: `avatars/${generatePublicId('upload')}/avatar.png`,
    mime_type: 'image/png',
    file_size: 1024,
    storage_provider: 's3' as const,
    bucket: 'test-bucket',
    status: 'PENDING' as const,
  };
}

describe('Security: Upload RLS', () => {
  beforeAll(async () => {
    await sql`GRANT core_be_app TO CURRENT_USER`.catch(() => undefined);
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('should hide other tenants org-scoped uploads when app.current_organization_public_id is set', async () => {
    const rlsRows = await sql<{ relrowsecurity: boolean }[]>`
      SELECT c.relrowsecurity
      FROM pg_class c
      INNER JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'upload' AND c.relname = 'uploads'
    `;
    expect(
      rlsRows[0]?.relrowsecurity,
      'Apply migrations including 20260517000001_upload_rls.sql',
    ).toBe(true);

    const ownerA = await createTestUser();
    const ownerB = await createTestUser();
    const organizationA = await createTestOrganization({ ownerUserId: ownerA.id });
    const organizationB = await createTestOrganization({ ownerUserId: ownerB.id });

    const uploadPublicIdA = generatePublicId('upload');
    const uploadPublicIdB = generatePublicId('upload');

    await database.insert(uploads).values({
      public_id: uploadPublicIdA,
      user_id: ownerA.id,
      organization_id: organizationA.id,
      file_name: 'logo-a.png',
      file_key: 'organization-logos/org-a/logo.png',
      mime_type: 'image/png',
      file_size: 1024,
      storage_provider: 's3',
      bucket: 'test-bucket',
      status: 'PENDING',
    });
    await database.insert(uploads).values({
      public_id: uploadPublicIdB,
      user_id: ownerB.id,
      organization_id: organizationB.id,
      file_name: 'logo-b.png',
      file_key: 'organization-logos/org-b/logo.png',
      mime_type: 'image/png',
      file_size: 1024,
      storage_provider: 's3',
      bucket: 'test-bucket',
      status: 'PENDING',
    });

    const visibleForA = await database.transaction(async (transaction) => {
      await transaction.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
      await transaction.execute(
        drizzleSql`SELECT set_config('app.current_organization_public_id', ${organizationA.public_id}, true)`,
      );
      return transaction
        .select()
        .from(uploads)
        .where(eq(uploads.organization_id, organizationA.id));
    });

    expect(visibleForA).toHaveLength(1);
    expect(visibleForA[0]?.public_id).toBe(uploadPublicIdA);

    const crossTenantAttempt = await database.transaction(async (transaction) => {
      await transaction.execute(drizzleSql`SET LOCAL ROLE core_be_app`);
      await transaction.execute(
        drizzleSql`SELECT set_config('app.current_organization_public_id', ${organizationA.public_id}, true)`,
      );
      return transaction
        .select()
        .from(uploads)
        .where(eq(uploads.organization_id, organizationB.id));
    });

    expect(crossTenantAttempt).toHaveLength(0);
  });

  it('sec-r7/M4: REJECTS an org-scoped upload INSERT under USER context (the production bug)', async () => {
    // As core_be_app (FORCE RLS, like production) with ONLY app.current_user_public_id set — exactly what
    // withAppDatabaseContext (user scope) does — inserting an ORG-scoped upload row is rejected: the
    // uploads_tenant_isolation WITH CHECK needs app.current_organization_public_id, and uploads_owner_access
    // only covers organization_id IS NULL. The upload service used to reserve org slots under user
    // context, so every org-logo / org-file upload 500'd in production (tests as superuser hid it).
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    let caught: unknown;
    try {
      await executeAsCoreBeAppUser(owner.public_id, (transaction) =>
        transaction.insert(uploads).values(buildOrgUploadValues(owner.id, organization.id)),
      );
    } catch (error) {
      caught = error;
    }
    // postgres-js surfaces the RLS WITH CHECK violation as the `.cause` under drizzle's wrapper.
    expect(flattenErrorChain(caught)).toMatch(/row-level security/i);

    // Nothing was written.
    const rows = await database
      .select()
      .from(uploads)
      .where(eq(uploads.organization_id, organization.id));
    expect(rows).toHaveLength(0);
  });

  it('sec-r7/M4: ACCEPTS the same org-scoped upload INSERT under ORGANIZATION context (the fix)', async () => {
    // The fix reserves org slots under withAppDatabaseContext, which sets
    // app.current_organization_public_id — so the tenant-isolation WITH CHECK is satisfied.
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });

    await executeAsCoreBeAppTenant(organization.public_id, (transaction) =>
      transaction.insert(uploads).values(buildOrgUploadValues(owner.id, organization.id)),
    );

    const rows = await database
      .select()
      .from(uploads)
      .where(eq(uploads.organization_id, organization.id));
    expect(rows).toHaveLength(1);
  });

  it('sec-r7/M4: still ACCEPTS a user-scoped (NULL-org) upload INSERT under USER context', async () => {
    // Regression guard: avatars and other personal uploads keep working under user context via
    // the owner-access policy — the fix only reroutes ORG-scoped uploads.
    const owner = await createTestUser();

    await executeAsCoreBeAppUser(owner.public_id, (transaction) =>
      transaction.insert(uploads).values(buildUserUploadValues(owner.id)),
    );

    const rows = await database.select().from(uploads).where(eq(uploads.user_id, owner.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organization_id).toBeNull();
  });
});
