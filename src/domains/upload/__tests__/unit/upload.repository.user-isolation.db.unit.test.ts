import { describe, it, expect, beforeEach } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { UploadRepository } from '@/domains/upload/upload.repository.js';

describe('UploadRepository user/organization isolation (database)', () => {
  const repository = new UploadRepository();

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('findByPublicIdForUser does not return another user\u2019s upload', async () => {
    const ownerUser = await createTestUser({ email: 'owner-isolation@example.com' });
    const otherUser = await createTestUser({ email: 'other-isolation@example.com' });

    const created = await repository.create({
      user_id: ownerUser.id,
      organization_id: null,
      file_name: 'owner-photo.png',
      file_key: `user-files/${ownerUser.id}/owner-photo.png`,
      mime_type: 'image/png',
      file_size: 1024,
      storage_provider: 's3',
      bucket: 'test-bucket',
    });

    const forOwner = await repository.findByPublicIdForUser(created.public_id, ownerUser.id);
    expect(forOwner?.public_id).toBe(created.public_id);

    const forOther = await repository.findByPublicIdForUser(created.public_id, otherUser.id);
    expect(forOther).toBeNull();
  });

  it('findByPublicIdForUser does not return soft-deleted upload', async () => {
    const ownerUser = await createTestUser({ email: 'soft-delete-isolation@example.com' });

    const created = await repository.create({
      user_id: ownerUser.id,
      organization_id: null,
      file_name: 'soft.png',
      file_key: `user-files/${ownerUser.id}/soft.png`,
      mime_type: 'image/png',
      file_size: 512,
      storage_provider: 's3',
      bucket: 'test-bucket',
    });

    const beforeDelete = await repository.findByPublicIdForUser(created.public_id, ownerUser.id);
    expect(beforeDelete?.public_id).toBe(created.public_id);

    const softDeleted = await repository.softDelete(created.public_id, ownerUser.id);
    expect(softDeleted?.deleted_at).not.toBeNull();

    const afterDelete = await repository.findByPublicIdForUser(created.public_id, ownerUser.id);
    expect(afterDelete).toBeNull();

    // sec-D12: keyset variant; production callers always paginate.
    const findActive = await repository.findActiveByUserIdAfter(ownerUser.id, 0, 100);
    expect(findActive.some((row) => row.id === created.id)).toBe(false);
  });

  it('findActiveByOrganizationIdAfter only returns uploads scoped to that organization (sec-D12)', async () => {
    const ownerUser = await createTestUser({ email: 'org-isolation@example.com' });
    const organizationA = await createTestOrganization({ ownerUserId: ownerUser.id });
    const organizationB = await createTestOrganization({ ownerUserId: ownerUser.id });

    const inOrgA = await repository.create({
      user_id: ownerUser.id,
      organization_id: organizationA.id,
      file_name: 'logo-a.png',
      file_key: `organization-files/${organizationA.id}/logo-a.png`,
      mime_type: 'image/png',
      file_size: 1024,
      storage_provider: 's3',
      bucket: 'test-bucket',
    });

    const inOrgB = await repository.create({
      user_id: ownerUser.id,
      organization_id: organizationB.id,
      file_name: 'logo-b.png',
      file_key: `organization-files/${organizationB.id}/logo-b.png`,
      mime_type: 'image/png',
      file_size: 1024,
      storage_provider: 's3',
      bucket: 'test-bucket',
    });

    const userScopedUpload = await repository.create({
      user_id: ownerUser.id,
      organization_id: null,
      file_name: 'user-only.png',
      file_key: `user-files/${ownerUser.id}/user-only.png`,
      mime_type: 'image/png',
      file_size: 512,
      storage_provider: 's3',
      bucket: 'test-bucket',
    });

    const activeInOrgA = await repository.findActiveByOrganizationIdAfter(organizationA.id, 0, 100);
    const idsInOrgA = activeInOrgA.map((row) => row.id);
    expect(idsInOrgA).toContain(inOrgA.id);
    expect(idsInOrgA).not.toContain(inOrgB.id);
    expect(idsInOrgA).not.toContain(userScopedUpload.id);

    const activeInOrgB = await repository.findActiveByOrganizationIdAfter(organizationB.id, 0, 100);
    const idsInOrgB = activeInOrgB.map((row) => row.id);
    expect(idsInOrgB).toContain(inOrgB.id);
    expect(idsInOrgB).not.toContain(inOrgA.id);
    expect(idsInOrgB).not.toContain(userScopedUpload.id);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // findByFileKey — deliberately NOT owner-scoped in SQL.
  //
  // Its two callers are `UploadService.assertKeyConfirmed` (ownership implied by
  // the key prefix) and `UploadService.assertKeyConfirmedForOwner` (sec-UP5),
  // which re-checks `user_id` / `organization_id` in application code. These two
  // cases pin that split against real Postgres: the lookup itself hands back a
  // row belonging to somebody else, so the code-level owner check is
  // load-bearing and cannot be quietly dropped as "RLS already covers it".
  // RLS does not cover it — the attach paths run under contexts where the
  // caller's own key is being validated against a row they may not own.
  // ───────────────────────────────────────────────────────────────────────────

  it('findByFileKey applies no user predicate — it returns another user’s row (sec-UP5)', async () => {
    const ownerUser = await createTestUser({ email: 'key-owner@example.com' });
    const strangerUser = await createTestUser({ email: 'key-stranger@example.com' });

    const fileKey = `user-files/${ownerUser.id}/confirmed-avatar.png`;
    const created = await repository.create({
      user_id: ownerUser.id,
      organization_id: null,
      file_name: 'confirmed-avatar.png',
      file_key: fileKey,
      mime_type: 'image/png',
      file_size: 2048,
      storage_provider: 's3',
      bucket: 'test-bucket',
      status: 'UPLOADED',
    });

    // The owner-scoped sibling lookup finds it for the owner and refuses the
    // stranger — both arms, so the null below is the user predicate doing the
    // work and not an unrelated miss.
    const scopedForOwner = await repository.findByPublicIdForUser(created.public_id, ownerUser.id);
    expect(scopedForOwner?.id).toBe(created.id);

    const scopedForStranger = await repository.findByPublicIdForUser(
      created.public_id,
      strangerUser.id,
    );
    expect(scopedForStranger).toBeNull();

    // …while the key lookup has no owner argument at all and hands the row back.
    const byKey = await repository.findByFileKey(fileKey);
    expect(byKey?.id).toBe(created.id);
    expect(byKey?.user_id).toBe(ownerUser.id);
  });

  it('findByFileKey applies no organization predicate — it returns another organization’s row (sec-UP5)', async () => {
    const ownerUser = await createTestUser({ email: 'key-organization-owner@example.com' });
    const organizationA = await createTestOrganization({ ownerUserId: ownerUser.id });
    const organizationB = await createTestOrganization({ ownerUserId: ownerUser.id });

    const fileKey = `organization-files/${organizationA.id}/confirmed-logo.png`;
    const created = await repository.create({
      user_id: ownerUser.id,
      organization_id: organizationA.id,
      file_name: 'confirmed-logo.png',
      file_key: fileKey,
      mime_type: 'image/png',
      file_size: 4096,
      storage_provider: 's3',
      bucket: 'test-bucket',
      status: 'UPLOADED',
    });

    // Organization B needs a row of its own, otherwise the exclusion below is
    // satisfied by an empty result set and proves nothing about scoping.
    const inOrganizationB = await repository.create({
      user_id: ownerUser.id,
      organization_id: organizationB.id,
      file_name: 'other-logo.png',
      file_key: `organization-files/${organizationB.id}/other-logo.png`,
      mime_type: 'image/png',
      file_size: 4096,
      storage_provider: 's3',
      bucket: 'test-bucket',
      status: 'UPLOADED',
    });

    // The organization-scoped sibling lookup returns B's row and keeps A's out…
    const scopedToOrganizationB = await repository.findActiveByOrganizationIdAfter(
      organizationB.id,
      0,
      100,
    );
    const idsScopedToOrganizationB = scopedToOrganizationB.map((row) => row.id);
    expect(idsScopedToOrganizationB).toContain(inOrganizationB.id);
    expect(idsScopedToOrganizationB).not.toContain(created.id);

    // …while the key lookup returns organization A's row to any caller, which is
    // why assertKeyConfirmedForOwner compares organization_id itself.
    const byKey = await repository.findByFileKey(fileKey);
    expect(byKey?.id).toBe(created.id);
    expect(byKey?.organization_id).toBe(organizationA.id);
  });
});
