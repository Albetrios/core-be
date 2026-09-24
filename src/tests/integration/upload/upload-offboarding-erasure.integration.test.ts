import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from '@/infrastructure/database/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { UploadRepository } from '@/domains/upload/upload.repository.js';
import { UploadService } from '@/domains/upload/upload.service.js';
import type { ObjectStoragePort } from '@/infrastructure/storage/object-storage.port.js';

/**
 * Offboarding's whole job is erasure, and **nothing asserted it happened against a real
 * database**. Every existing reference to `tombstoneAllBy{User,Organization}Id` lives in a unit
 * test that mocks the repository, so the repository's answer was supplied by the test rather
 * than by Postgres. That is how organization and account deletion came to tombstone nothing for
 * months while reporting success: `upload.uploads` is FORCE RLS with GUC-gated policy arms, the
 * sweep ran with no database context, it matched no arm, and `UPDATE … RETURNING` reported zero
 * rows — which a mocked repository can never reproduce.
 *
 * This is the assertion that was missing. It uses the real repository against real rows, so the
 * count it checks is Postgres's, and under `pnpm test:rls-role` — where the connection is the
 * RLS-subject `core_be_app` role — it fails on the unfixed code and passes on the fixed code.
 * Run on the ordinary harness role it passes either way, which is exactly why the role lane and
 * this assertion are both needed: neither catches the bug alone.
 */

const storageStub = {
  deleteObject: vi.fn().mockResolvedValue(true),
  createPresignedUploadUrl: vi.fn(),
  headObject: vi.fn(),
  getObjectUrl: vi.fn(),
} as unknown as ObjectStoragePort;

type Seeded = { userId: number; organizationId: number };

async function seed(): Promise<Seeded> {
  const email = 'offboarding-erasure@example.test';
  const [user] = await sql<{ id: number }[]>`
    INSERT INTO auth.users (public_id, email, email_hash, is_email_verified)
    VALUES ('usr_offboarderasureuser1', ${email},
            ${createHash('sha256').update(email).digest('hex')}, true)
    RETURNING id
  `;
  const [organization] = await sql<{ id: number }[]>`
    INSERT INTO tenancy.organizations (public_id, name, slug, owner_user_id, type)
    VALUES ('org_offboarderasureorg01', 'Offboard Erasure', 'offboard-erasure', ${user!.id}, 'TEAM')
    RETURNING id
  `;
  const userId = Number(user!.id);
  const organizationId = Number(organization!.id);

  // Two organization-scoped uploads and two personal ones — the two policy arms are disjoint,
  // so a sweep that can only see one of them is still a failure.
  for (const [index, orgId] of [organizationId, organizationId, null, null].entries()) {
    await sql`
      INSERT INTO upload.uploads
        (public_id, user_id, organization_id, file_name, file_key, mime_type, file_size, bucket, status)
      VALUES (${`upl_offboarderasure${String(index).padStart(5, '0')}`}, ${userId}, ${orgId},
              ${`f${index}.png`}, ${`uploads/f${index}.png`}, 'image/png', 10, 'test-bucket', 'UPLOADED')
    `;
  }
  return { userId, organizationId };
}

async function countLiveUploads(): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM upload.uploads WHERE deleted_at IS NULL
  `;
  return Number(row!.count);
}

function buildService(): UploadService {
  // Only the repository and storage participate in the tombstone paths.
  return new UploadService(
    new UploadRepository(),
    {} as never,
    {} as never,
    storageStub,
    {} as never,
  );
}

describe('Integration: offboarding actually erases uploads', () => {
  let seeded: Seeded;

  beforeEach(async () => {
    await cleanupDatabase();
    seeded = await seed();
    vi.mocked(storageStub.deleteObject).mockClear();
  });

  it('tombstones every organization-scoped upload when an organization is deleted', async () => {
    expect(await countLiveUploads()).toBe(4);

    const tombstoned = await buildService().tombstoneAllByOrganizationId(seeded.organizationId);

    // The number Postgres actually updated — not a number a mock handed back.
    expect(tombstoned).toBe(2);
    expect(await countLiveUploads()).toBe(2);
    // And the objects behind them were asked to be deleted, rather than silently skipped
    // because the keyset read returned nothing.
    expect(storageStub.deleteObject).toHaveBeenCalledTimes(2);
  });

  it('tombstones every upload a user owns when the account is deleted', async () => {
    const tombstoned = await buildService().tombstoneAllByUserId(seeded.userId);

    // All four: the user owns the personal uploads and the organization-scoped ones alike.
    expect(tombstoned).toBe(4);
    expect(await countLiveUploads()).toBe(0);
    expect(storageStub.deleteObject).toHaveBeenCalledTimes(4);
  });
});
