import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserService } from '@/domains/user/user.service.js';
import type { UserRepository } from '@/domains/user/user.repository.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';
import { buildUserAvatarKeyPrefix } from '@/domains/upload/upload.constants.js';
import { ValidationError, NotFoundError } from '@/shared/errors/index.js';
import {
  createPrincipalDatabaseScope,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';

vi.mock(
  '@/infrastructure/database/contexts/maintenance-database.context.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const inner = vi.fn((callback: () => Promise<unknown>) => callback()) as unknown as (
      ...parameters: unknown[]
    ) => unknown;
    return {
      ...actual,
      withMaintenanceDatabaseContext: vi.fn((_scope: unknown, ...parameters: unknown[]) =>
        inner(...parameters),
      ),
    };
  },
);

/**
 * Avatar attach / replace / detach and the reclamation of the object left behind.
 *
 * Replacing an avatar has to delete the previous S3 object — the code comments call an orphan
 * here a "storage leak / incomplete GDPR erasure". Equally, it must NOT delete when the key is
 * unchanged (that would erase the avatar the user just kept) and must never touch a key outside
 * the caller's own prefix. None of those branches were covered: they were the single largest
 * cluster of surviving mutants in `user.service.ts`.
 */

vi.mock('@/shared/utils/infrastructure/postgres-error.util.js', () => ({
  runInsertWithPublicIdentifierRetry: async (operation: () => Promise<unknown>) => operation(),
}));

vi.mock('@/domains/tenancy/sub-domains/organization/resolve-active-organization.js', () => ({
  resolvePersonalOrganizationPublicId: vi.fn().mockResolvedValue(undefined),
  resolveDefaultActiveOrganizationPublicId: vi.fn().mockResolvedValue(undefined),
  findUserActiveOrganizationPublicId: vi.fn().mockResolvedValue(undefined),
  ensurePersonalOrganizationPublicId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/shared/utils/auth/global-admin-role.util.js', () => ({
  resolveGlobalRoleForEmail: vi.fn().mockReturnValue(undefined),
}));

const { loggerWarnMock } = vi.hoisted(() => ({ loggerWarnMock: vi.fn() }));
vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: loggerWarnMock, error: vi.fn(), debug: vi.fn() },
}));

vi.mock(
  '@/infrastructure/database/contexts/principal-database.context.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      withPrincipalDatabaseContext: vi.fn(
        async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
      ),
    };
  },
);

const USER_PUBLIC_ID = generatePublicId('user');
const AVATAR_PREFIX = buildUserAvatarKeyPrefix(USER_PUBLIC_ID);
const NEW_AVATAR_KEY = `${AVATAR_PREFIX}new.png`;
const OLD_AVATAR_KEY = `${AVATAR_PREFIX}old.png`;

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    public_id: USER_PUBLIC_ID,
    email: 'user@example.com',
    first_name: 'Test',
    last_name: 'User',
    job_title: null,
    avatar_url: null,
    deleted_at: null,
    password_hash: 'hash',
    is_email_verified: true,
    mfa_enabled: false,
    global_role: 'USER',
    suspended_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

const asUserScope = (userPublicId: string) =>
  createPrincipalDatabaseScope({
    userPublicId,
    organizationPublicId: 'org_scope_test',
    source: 'token',
  }) as UserPrincipalDatabaseScope;

describe('UserService — avatar lifecycle', () => {
  const repository = {
    findByPublicId: vi.fn(),
    update: vi.fn(),
  } as unknown as UserRepository;

  const objectStorage = createObjectStoragePortMock();
  const service = new UserService(repository, objectStorage);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(repository.findByPublicId).mockResolvedValue(userRow() as never);
    vi.mocked(repository.update).mockResolvedValue(userRow() as never);
    vi.mocked(objectStorage.deleteObject).mockResolvedValue(true);
    service.wireOffboardingServices({
      uploadService: {
        assertKeyConfirmed: vi.fn().mockResolvedValue(undefined),
        assertKeyConfirmedForOwner: vi.fn().mockResolvedValue(undefined),
        tombstoneAllByUserId: vi.fn().mockResolvedValue(0),
      } as never,
    } as never);
  });

  // ─── uploadAvatar ─────────────────────────────────────────────

  it('reclaims the previous object when the avatar is replaced', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(
      userRow({ avatar_url: OLD_AVATAR_KEY }) as never,
    );

    await service.uploadAvatar(USER_PUBLIC_ID, { avatar_key: NEW_AVATAR_KEY });

    expect(repository.update).toHaveBeenCalledWith(USER_PUBLIC_ID, {
      avatar_url: NEW_AVATAR_KEY,
    });
    expect(objectStorage.deleteObject).toHaveBeenCalledWith(OLD_AVATAR_KEY);
  });

  it('does not delete anything when the user had no previous avatar', async () => {
    await service.uploadAvatar(USER_PUBLIC_ID, { avatar_key: NEW_AVATAR_KEY });

    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
  });

  it('does not delete the object when the same key is re-attached', async () => {
    // Re-attaching the current key must be a no-op for storage — deleting here would erase the
    // avatar the user just kept.
    vi.mocked(repository.findByPublicId).mockResolvedValue(
      userRow({ avatar_url: NEW_AVATAR_KEY }) as never,
    );

    await service.uploadAvatar(USER_PUBLIC_ID, { avatar_key: NEW_AVATAR_KEY });

    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
  });

  it('rejects an avatar key outside the caller own prefix', async () => {
    const foreignKey = `${buildUserAvatarKeyPrefix(generatePublicId('user'))}someone-else.png`;

    await expect(
      service.uploadAvatar(USER_PUBLIC_ID, { avatar_key: foreignKey }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('warns but still succeeds when storage refuses to delete the replaced object', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(
      userRow({ avatar_url: OLD_AVATAR_KEY }) as never,
    );
    vi.mocked(objectStorage.deleteObject).mockResolvedValue(false);

    await service.uploadAvatar(USER_PUBLIC_ID, { avatar_key: NEW_AVATAR_KEY });

    expect(loggerWarnMock).toHaveBeenCalledWith(
      { publicId: USER_PUBLIC_ID, avatarKey: OLD_AVATAR_KEY },
      'user.avatar.deleteFailed',
    );
  });

  // ─── updateMe with avatar_key ─────────────────────────────────

  it('updateMe reclaims the previous object when the avatar changes', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(
      userRow({ avatar_url: OLD_AVATAR_KEY }) as never,
    );

    await service.updateMe(asUserScope(USER_PUBLIC_ID), {
      first_name: 'Renamed',
      avatar_key: NEW_AVATAR_KEY,
    });

    expect(repository.update).toHaveBeenCalledWith(
      USER_PUBLIC_ID,
      expect.objectContaining({ first_name: 'Renamed', avatar_url: NEW_AVATAR_KEY }),
    );
    expect(objectStorage.deleteObject).toHaveBeenCalledWith(OLD_AVATAR_KEY);
  });

  it('updateMe leaves storage alone when the request carries no avatar_key', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(
      userRow({ avatar_url: OLD_AVATAR_KEY }) as never,
    );

    await service.updateMe(asUserScope(USER_PUBLIC_ID), { first_name: 'Renamed' });

    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
    // avatar_url must not be written at all — omitting the key means "leave it as it is".
    expect(repository.update).toHaveBeenCalledWith(
      USER_PUBLIC_ID,
      expect.not.objectContaining({ avatar_url: expect.anything() }),
    );
  });

  it('updateMe does not delete when the same avatar key is resubmitted', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(
      userRow({ avatar_url: NEW_AVATAR_KEY }) as never,
    );

    await service.updateMe(asUserScope(USER_PUBLIC_ID), { avatar_key: NEW_AVATAR_KEY });

    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
  });

  // ─── deleteAvatar ─────────────────────────────────────────────

  it('deleteAvatar reclaims the object before clearing the column', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(
      userRow({ avatar_url: OLD_AVATAR_KEY }) as never,
    );

    await service.deleteAvatar(USER_PUBLIC_ID);

    expect(objectStorage.deleteObject).toHaveBeenCalledWith(OLD_AVATAR_KEY);
    expect(repository.update).toHaveBeenCalledWith(USER_PUBLIC_ID, { avatar_url: null });
  });

  it('deleteAvatar is a no-op for storage when no avatar is set', async () => {
    await service.deleteAvatar(USER_PUBLIC_ID);

    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledWith(USER_PUBLIC_ID, { avatar_url: null });
  });

  it('deleteAvatar never deletes a key outside the user own prefix', async () => {
    // Defence in depth: a stored value that does not match the caller's prefix (data drift or a
    // tampered row) must not turn into a delete against someone else's object.
    vi.mocked(repository.findByPublicId).mockResolvedValue(
      userRow({ avatar_url: 'avatars/another-user/photo.png' }) as never,
    );

    await service.deleteAvatar(USER_PUBLIC_ID);

    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
  });

  it('deleteAvatar throws for a soft-deleted user', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(
      userRow({ deleted_at: new Date() }) as never,
    );

    await expect(service.deleteAvatar(USER_PUBLIC_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});
