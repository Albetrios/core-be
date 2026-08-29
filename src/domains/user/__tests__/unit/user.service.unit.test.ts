import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/shared/errors/index.js';
import { GLOBAL_ROLES } from '@/shared/constants/roles.constants.js';
import { UserService } from '@/domains/user/user.service.js';
import type { UserRepository } from '@/domains/user/user.repository.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';
import { env } from '@/shared/config/env.config.js';
import { ensurePersonalOrganizationPublicId } from '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js';
import {
  PRINCIPAL_SCOPE,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
    withAppDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

/**
 * UserService wraps repository calls in `withAppDatabaseContext (user scope)` /
 * `withMaintenanceDatabaseContext` (see `softDeleteUserWithOffboarding`, `updatePassword`,
 * `updateMfaEnabled`, admin listing). Those helpers open a real `database.transaction()` and would
 * hang in pure unit tests with mocked repositories. Run the inner callback directly so the test
 * exercises service logic without touching Postgres. Matches the pattern in
 * `src/domains/auth/__tests__/unit/auth.service.unit.test.ts`.
 */

vi.mock('@/shared/utils/infrastructure/postgres-error.util.js', () => ({
  runInsertWithPublicIdentifierRetry: async (operation: () => Promise<unknown>) => operation(),
}));

// getMe resolves the caller's personal organization via this tenancy helper (its own DB context);
// stub it so the pure unit test does not touch Postgres.
vi.mock('@/domains/tenancy/sub-domains/organization/resolve-active-organization.js', () => ({
  resolvePersonalOrganizationPublicId: vi.fn().mockResolvedValue(undefined),
  resolveDefaultActiveOrganizationPublicId: vi.fn().mockResolvedValue(undefined),
  findUserActiveOrganizationPublicId: vi.fn().mockResolvedValue(undefined),
  // getMe now self-heals via ensurePersonalOrganizationPublicId (provisions on demand when
  // personal is enabled and the org is missing); stub it so the pure unit test stays DB-free.
  ensurePersonalOrganizationPublicId: vi.fn().mockResolvedValue(undefined),
}));

// route-#1: control whether the admin-mutation target resolves as a protected super-admin.
const resolveGlobalRoleForEmailMock = vi.fn().mockReturnValue(undefined);
vi.mock('@/shared/utils/auth/global-admin-role.util.js', () => ({
  resolveGlobalRoleForEmail: (...args: unknown[]) => resolveGlobalRoleForEmailMock(...args),
}));

const userRow = {
  id: 1,
  public_id: generatePublicId('user'),
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
};

const asUserScope = (userPublicId: string) =>
  PRINCIPAL_SCOPE.REQUEST({
    userPublicId,
    organizationPublicId: 'org_scope_test',
  }) as UserPrincipalDatabaseScope;

describe('UserService', () => {
  const repository = {
    findByEmail: vi.fn().mockResolvedValue(userRow),
    findByPublicId: vi.fn().mockResolvedValue(userRow),
    findById: vi.fn().mockResolvedValue(userRow),
    update: vi.fn().mockResolvedValue(userRow),
    updatePassword: vi.fn().mockResolvedValue(userRow),
    updateLoginAttempt: vi.fn().mockResolvedValue(userRow),
    updateEmailVerified: vi.fn().mockResolvedValue(userRow),
    updateMfaEnabled: vi.fn().mockResolvedValue(userRow),
    insertOAuthUser: vi.fn().mockResolvedValue(userRow),
    softDelete: vi.fn().mockResolvedValue(userRow),
    markDeletionStarted: vi.fn().mockResolvedValue(userRow),
    findMany: vi.fn().mockResolvedValue({
      items: [userRow],
      total: null,
      limit: 20,
      has_more: false,
      next_cursor: null,
    }),
    adminUpdate: vi.fn().mockResolvedValue(userRow),
    suspend: vi.fn().mockResolvedValue({ ...userRow, suspended_at: new Date() }),
    unsuspend: vi.fn().mockResolvedValue(userRow),
    markOnboardingComplete: vi.fn().mockResolvedValue(userRow),
  } as unknown as UserRepository;

  const objectStorage = createObjectStoragePortMock();
  const service = new UserService(repository, objectStorage);

  beforeEach(() => {
    vi.clearAllMocks();
    resolveGlobalRoleForEmailMock.mockReturnValue(undefined);
    vi.mocked(repository.findByPublicId).mockResolvedValue(userRow as never);
    vi.mocked(repository.softDelete).mockResolvedValue(userRow as never);
    vi.mocked(repository.markDeletionStarted).mockResolvedValue(userRow as never);
    vi.mocked(repository.update).mockResolvedValue(userRow as never);
    service.wireOffboardingServices({
      authSessionService: {
        revokeAllSessions: vi.fn().mockResolvedValue(undefined),
      } as never,
      authMethodService: {
        revokeAllForUser: vi.fn().mockResolvedValue(undefined),
        invalidateAllVerificationTokensForUser: vi.fn().mockResolvedValue(undefined),
      } as never,
      uploadService: {
        tombstoneAllByUserId: vi.fn().mockResolvedValue(0),
        assertKeyConfirmed: vi.fn().mockResolvedValue(undefined),
        assertKeyConfirmedForOwner: vi.fn().mockResolvedValue(undefined),
      } as never,
      userDataExportService: {
        deleteAllExportsForUser: vi.fn().mockResolvedValue(undefined),
      } as never,
      organizationOwnership: {
        countOrganizationsOwnedByUser: vi.fn().mockResolvedValue(0),
      } as never,
    });
  });

  it('findByEmail returns user record', async () => {
    const result = await service.findByEmail('user@example.com');
    expect(result?.email).toBe('user@example.com');
  });

  describe('findOrCreateInvitedByEmail (invite resurrection guard)', () => {
    it('returns the existing LIVE user and mints nothing', async () => {
      vi.mocked(repository.findByEmail).mockResolvedValueOnce(userRow as never);

      const result = await service.findOrCreateInvitedByEmail({ email: 'user@example.com' });

      expect(result).toBe(userRow);
      expect(repository.insertOAuthUser).not.toHaveBeenCalled();
    });

    it('mints a FRESH passwordless account when the email belongs to a soft-deleted (offboarded) user', async () => {
      // A tombstoned account must NOT be resurrected into an active org membership with its old
      // public_id — that would re-attach an offboarded identity. The guard is `&& !existing.deleted_at`;
      // if it ever regressed to `if (existing) return existing`, the deleted row would be reused.
      vi.mocked(repository.findByEmail).mockResolvedValueOnce({
        ...userRow,
        deleted_at: new Date(),
      } as never);

      await service.findOrCreateInvitedByEmail({ email: 'user@example.com' });

      expect(repository.insertOAuthUser).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ email: 'user@example.com', is_email_verified: false }),
      );
    });

    it('mints a passwordless account when no user exists for the invited email', async () => {
      vi.mocked(repository.findByEmail).mockResolvedValueOnce(null as never);

      await service.findOrCreateInvitedByEmail({ email: 'brand-new@example.com' });

      expect(repository.insertOAuthUser).toHaveBeenCalled();
    });
  });

  it('requireUserRecordByPublicId returns active user', async () => {
    const result = await service.requireUserRecordByPublicId(userRow.public_id);
    expect(result.public_id).toBe(userRow.public_id);
  });

  it('requireUserRecordByPublicId throws for deleted user', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...userRow,
      deleted_at: new Date(),
    } as never);
    await expect(service.requireUserRecordByPublicId(userRow.public_id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('updateMfaEnabled updates flag', async () => {
    await service.updateMfaEnabled(userRow.public_id, true);
    expect(repository.updateMfaEnabled).toHaveBeenCalledWith(userRow.public_id, true);
  });

  it('getMe and updateMe return serialized user', async () => {
    const me = await service.getMe(asUserScope(userRow.public_id));
    expect(me.id).toBe(userRow.public_id);
    await service.updateMe(asUserScope(userRow.public_id), { first_name: 'Updated' });
    expect(repository.update).toHaveBeenCalled();
  });

  it('getMe reports a null personal_organization_id and skips provisioning when personal orgs are disabled', async () => {
    // The disabled branch must short-circuit — no on-demand provisioning — and report null, so a
    // deployment with personal orgs off never dead-ends on a self-heal that cannot run.
    const original = env.PERSONAL_ORGANIZATION_ENABLED;
    env.PERSONAL_ORGANIZATION_ENABLED = false;
    try {
      const me = await service.getMe(asUserScope(userRow.public_id));
      expect(me.personal_organization_id).toBeNull();
      expect(ensurePersonalOrganizationPublicId).not.toHaveBeenCalled();
    } finally {
      env.PERSONAL_ORGANIZATION_ENABLED = original;
    }
  });

  it('getMe surfaces the on-demand provisioned personal_organization_id when personal orgs are enabled', async () => {
    const original = env.PERSONAL_ORGANIZATION_ENABLED;
    env.PERSONAL_ORGANIZATION_ENABLED = true;
    try {
      vi.mocked(ensurePersonalOrganizationPublicId).mockResolvedValueOnce('org_personalxxxxxxxxxx');
      const me = await service.getMe(asUserScope(userRow.public_id));
      expect(me.personal_organization_id).toBe('org_personalxxxxxxxxxx');
      expect(ensurePersonalOrganizationPublicId).toHaveBeenCalledWith(userRow.id);
    } finally {
      env.PERSONAL_ORGANIZATION_ENABLED = original;
    }
  });

  it('completeOnboarding stamps the flag and returns the fresh self profile', async () => {
    const me = await service.completeOnboarding(asUserScope(userRow.public_id));
    expect(repository.markOnboardingComplete).toHaveBeenCalledWith(userRow.public_id);
    expect(me.id).toBe(userRow.public_id);
  });

  it('uploadAvatar stores the key and returns a signed read URL (USER-10)', async () => {
    const avatarKey = `avatars/${userRow.public_id}/avatar.png`;
    vi.mocked(repository.update).mockResolvedValue({
      ...userRow,
      avatar_url: avatarKey,
    } as never);
    const result = await service.uploadAvatar(userRow.public_id, {
      avatar_key: avatarKey,
    });
    // The raw object KEY is persisted…
    expect(repository.update).toHaveBeenCalledWith(userRow.public_id, {
      avatar_url: avatarKey,
    });
    // …but the response carries a short-lived signed read URL, never the raw key.
    expect(result.avatar_url).toBe('https://presigned.example/download');
  });

  it('uploadAvatar rejects keys outside avatars prefix', async () => {
    await expect(
      service.uploadAvatar(userRow.public_id, {
        avatar_key: 'wrong/prefix.png',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('uploadAvatar rejects when the upload has not been confirmed', async () => {
    service.wireOffboardingServices({
      authSessionService: { revokeAllSessions: vi.fn() } as never,
      authMethodService: {
        revokeAllForUser: vi.fn(),
        invalidateAllVerificationTokensForUser: vi.fn().mockResolvedValue(undefined),
      } as never,
      uploadService: {
        tombstoneAllByUserId: vi.fn().mockResolvedValue(0),
        assertKeyConfirmedForOwner: vi
          .fn()
          .mockRejectedValue(new ValidationError('errors:validation.uploadNotConfirmed')),
      } as never,
      userDataExportService: { deleteAllExportsForUser: vi.fn() } as never,
    });
    const avatarKey = `avatars/${userRow.public_id}/avatar.png`;
    await expect(
      service.uploadAvatar(userRow.public_id, { avatar_key: avatarKey }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('deleteMe runs offboarding when dependencies attached', async () => {
    const authSessionService = {
      revokeAllSessions: vi.fn().mockResolvedValue(undefined),
    };
    const authMethodService = {
      revokeAllForUser: vi.fn().mockResolvedValue(undefined),
      invalidateAllVerificationTokensForUser: vi.fn().mockResolvedValue(undefined),
    };
    const uploadService = {
      tombstoneAllByUserId: vi.fn().mockResolvedValue(0),
    };
    service.wireOffboardingServices({
      authSessionService: authSessionService as never,
      authMethodService: authMethodService as never,
      uploadService: uploadService as never,
      userDataExportService: {
        deleteAllExportsForUser: vi.fn().mockResolvedValue(undefined),
      } as never,
    });
    await service.deleteMe(userRow.public_id);
    expect(repository.softDelete).toHaveBeenCalledWith(userRow.public_id);
  });

  it('route-audit-#2: deleteMe is blocked when the user still owns organizations', async () => {
    service.wireOffboardingServices({
      authSessionService: { revokeAllSessions: vi.fn() } as never,
      authMethodService: {
        revokeAllForUser: vi.fn(),
        invalidateAllVerificationTokensForUser: vi.fn(),
      } as never,
      uploadService: { tombstoneAllByUserId: vi.fn() } as never,
      userDataExportService: { deleteAllExportsForUser: vi.fn() } as never,
      organizationOwnership: {
        countOrganizationsOwnedByUser: vi.fn().mockResolvedValue(2),
      } as never,
    });

    await expect(service.deleteMe(userRow.public_id)).rejects.toBeInstanceOf(ConflictError);
    // Blocked before any mutation — no half-state.
    expect(repository.markDeletionStarted).not.toHaveBeenCalled();
    expect(repository.softDelete).not.toHaveBeenCalled();
  });

  it('route-audit-#2: deleteUser (admin) is blocked when the target still owns organizations', async () => {
    resolveGlobalRoleForEmailMock.mockReturnValue(undefined); // target is not a protected admin
    service.wireOffboardingServices({
      authSessionService: { revokeAllSessions: vi.fn() } as never,
      authMethodService: {
        revokeAllForUser: vi.fn(),
        invalidateAllVerificationTokensForUser: vi.fn(),
      } as never,
      uploadService: { tombstoneAllByUserId: vi.fn() } as never,
      userDataExportService: { deleteAllExportsForUser: vi.fn() } as never,
      organizationOwnership: {
        countOrganizationsOwnedByUser: vi.fn().mockResolvedValue(1),
      } as never,
    });

    await expect(service.deleteUser(userRow.public_id)).rejects.toBeInstanceOf(ConflictError);
    expect(repository.softDelete).not.toHaveBeenCalled();
  });

  it('deleteMe soft-deletes before avatar storage cleanup', async () => {
    const avatarKey = `avatars/${userRow.public_id}/avatar.png`;
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...userRow,
      avatar_url: avatarKey,
    } as never);
    const callOrder: string[] = [];
    vi.mocked(repository.softDelete).mockImplementation(async () => {
      callOrder.push('softDelete');
      return userRow as never;
    });
    vi.mocked(objectStorage.deleteObject).mockImplementation(async () => {
      callOrder.push('avatarDelete');
      return true;
    });
    service.wireOffboardingServices({
      authSessionService: {
        revokeAllSessions: vi.fn().mockResolvedValue(undefined),
      } as never,
      authMethodService: {
        revokeAllForUser: vi.fn().mockResolvedValue(undefined),
        invalidateAllVerificationTokensForUser: vi.fn().mockResolvedValue(undefined),
      } as never,
      uploadService: {
        tombstoneAllByUserId: vi.fn().mockResolvedValue(0),
      } as never,
      userDataExportService: {
        deleteAllExportsForUser: vi.fn().mockResolvedValue(undefined),
      } as never,
    });
    await service.deleteMe(userRow.public_id);
    expect(callOrder).toEqual(['softDelete', 'avatarDelete']);
  });

  it('listUsers, getUser, adminUpdateUser, suspend and unsuspend', async () => {
    const listed = await service.listUsers({ limit: 20 });
    expect(listed.items).toHaveLength(1);
    expect(listed.has_more).toBe(false);
    expect(listed.next_cursor).toBeNull();
    expect(listed.total).toBeNull();
    const profile = await service.getUser(userRow.public_id);
    expect(profile.id).toBe(userRow.public_id);
    await service.adminUpdateUser(userRow.public_id, { status: 'SUSPENDED' });
    await service.suspendUser(userRow.public_id);
    await service.unsuspendUser(userRow.public_id);
    expect(repository.suspend).toHaveBeenCalled();
  });

  it('suspendUser revokes all of the user sessions (bug 31)', async () => {
    const revokeAllSessions = vi.fn().mockResolvedValue(undefined);
    service.wireOffboardingServices({
      authSessionService: { revokeAllSessions } as never,
      authMethodService: {
        revokeAllForUser: vi.fn(),
        invalidateAllVerificationTokensForUser: vi.fn().mockResolvedValue(undefined),
      } as never,
      uploadService: {} as never,
      userDataExportService: {} as never,
    });
    await service.suspendUser(userRow.public_id);
    expect(revokeAllSessions).toHaveBeenCalledWith(userRow.public_id);
  });

  it('adminUpdateUser revokes sessions when status changes to a non-active state (bug 31)', async () => {
    const revokeAllSessions = vi.fn().mockResolvedValue(undefined);
    service.wireOffboardingServices({
      authSessionService: { revokeAllSessions } as never,
      authMethodService: {
        revokeAllForUser: vi.fn(),
        invalidateAllVerificationTokensForUser: vi.fn().mockResolvedValue(undefined),
      } as never,
      uploadService: {} as never,
      userDataExportService: {} as never,
    });

    await service.adminUpdateUser(userRow.public_id, { status: 'SUSPENDED' });
    expect(revokeAllSessions).toHaveBeenCalledWith(userRow.public_id);

    revokeAllSessions.mockClear();
    await service.adminUpdateUser(userRow.public_id, { status: 'ACTIVE' });
    await service.adminUpdateUser(userRow.public_id, {
      first_name: 'NoStatusChange',
    });
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it('getUser throws when user is missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(service.getUser(userRow.public_id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleteAvatar clears avatar url', async () => {
    const result = await service.deleteAvatar(userRow.public_id);
    expect(repository.update).toHaveBeenCalledWith(userRow.public_id, {
      avatar_url: null,
    });
    expect(result.id).toBe(userRow.public_id);
  });

  it('uploadAvatar rejects missing storage object', async () => {
    vi.mocked(objectStorage.headObject).mockResolvedValueOnce(null);
    const avatarKey = `avatars/${userRow.public_id}/missing.png`;
    await expect(
      service.uploadAvatar(userRow.public_id, { avatar_key: avatarKey }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('uploadAvatar rejects invalid content type from storage metadata', async () => {
    vi.mocked(objectStorage.headObject).mockResolvedValueOnce({
      contentType: 'application/pdf',
      contentLength: 10,
    });
    const avatarKey = `avatars/${userRow.public_id}/avatar.png`;
    await expect(
      service.uploadAvatar(userRow.public_id, { avatar_key: avatarKey }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('updateMe can set avatar from storage key (stored as key, returned as signed URL)', async () => {
    const avatarKey = `avatars/${userRow.public_id}/avatar.png`;
    vi.mocked(repository.update).mockResolvedValue({
      ...userRow,
      avatar_url: avatarKey,
    } as never);
    const result = await service.updateMe(asUserScope(userRow.public_id), {
      avatar_key: avatarKey,
      first_name: 'New',
    });
    expect(result.avatar_url).toBe('https://presigned.example/download');
  });

  it('updateMe throws when repository update returns null', async () => {
    vi.mocked(repository.update).mockResolvedValue(null);
    await expect(
      service.updateMe(asUserScope(userRow.public_id), { first_name: 'Missing' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleteMe skips offboarding when dependencies are not attached', async () => {
    const standaloneService = new UserService(repository, createObjectStoragePortMock());
    vi.mocked(repository.findByPublicId).mockResolvedValue(userRow as never);
    await standaloneService.deleteMe(userRow.public_id);
    expect(repository.softDelete).toHaveBeenCalledWith(userRow.public_id);
  });

  it('createFromOAuth, updatePassword, and resolveInternalId delegate to repository', async () => {
    await service.createFromOAuth({
      email: 'oauth@example.com',
      is_email_verified: true,
    });
    expect(repository.insertOAuthUser).toHaveBeenCalled();
    await service.updatePassword(userRow.public_id, 'new-hash');
    expect(repository.updatePassword).toHaveBeenCalledWith(userRow.public_id, 'new-hash');
    const internalId = await service.resolveInternalIdByPublicId(userRow.public_id);
    expect(internalId).toBe(1);
    vi.mocked(repository.findByPublicId).mockResolvedValueOnce(null);
    expect(await service.resolveInternalIdByPublicId('missing')).toBeNull();
  });

  it('getMe throws when user is deleted', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...userRow,
      deleted_at: new Date(),
    } as never);
    await expect(service.getMe(asUserScope(userRow.public_id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('adminUpdateUser and suspendUser throw when repository returns null', async () => {
    vi.mocked(repository.adminUpdate).mockResolvedValue(null);
    vi.mocked(repository.suspend).mockResolvedValue(null);
    await expect(
      service.adminUpdateUser(userRow.public_id, { status: 'SUSPENDED' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.suspendUser(userRow.public_id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('unsuspendUser throws when repository returns null', async () => {
    vi.mocked(repository.unsuspend).mockResolvedValue(null);
    await expect(service.unsuspendUser(userRow.public_id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleteMe throws when soft delete fails after offboarding', async () => {
    vi.mocked(repository.softDelete).mockResolvedValue(null);
    await expect(service.deleteMe(userRow.public_id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleteMe skips avatar cleanup when user has no avatar', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...userRow,
      avatar_url: null,
    } as never);
    const authSessionService = {
      revokeAllSessions: vi.fn().mockResolvedValue(undefined),
    };
    const authMethodService = {
      revokeAllForUser: vi.fn().mockResolvedValue(undefined),
      invalidateAllVerificationTokensForUser: vi.fn().mockResolvedValue(undefined),
    };
    const uploadService = {
      tombstoneAllByUserId: vi.fn().mockResolvedValue(0),
    };
    service.wireOffboardingServices({
      authSessionService: authSessionService as never,
      authMethodService: authMethodService as never,
      uploadService: uploadService as never,
      userDataExportService: {
        deleteAllExportsForUser: vi.fn().mockResolvedValue(undefined),
      } as never,
    });
    await service.deleteMe(userRow.public_id);
    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('requireUserRecordByPublicId throws when user is missing', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue(null);
    await expect(service.requireUserRecordByPublicId('missing')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('deleteMe clears avatar storage when offboarding dependencies are attached', async () => {
    const avatarKey = `avatars/${userRow.public_id}/avatar.png`;
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...userRow,
      avatar_url: avatarKey,
    } as never);
    const authSessionService = {
      revokeAllSessions: vi.fn().mockResolvedValue(undefined),
    };
    const authMethodService = {
      revokeAllForUser: vi.fn().mockResolvedValue(undefined),
      invalidateAllVerificationTokensForUser: vi.fn().mockResolvedValue(undefined),
    };
    const uploadService = {
      tombstoneAllByUserId: vi.fn().mockResolvedValue(0),
    };
    service.wireOffboardingServices({
      authSessionService: authSessionService as never,
      authMethodService: authMethodService as never,
      uploadService: uploadService as never,
      userDataExportService: {
        deleteAllExportsForUser: vi.fn().mockResolvedValue(undefined),
      } as never,
    });
    await service.deleteMe(userRow.public_id);
    expect(repository.update).toHaveBeenCalledWith(userRow.public_id, {
      avatar_url: null,
    });
  });

  it('deleteAvatar throws when repository update returns null', async () => {
    vi.mocked(repository.update).mockResolvedValue(null);
    await expect(service.deleteAvatar(userRow.public_id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleteUser runs offboarding path', async () => {
    const authSessionService = {
      revokeAllSessions: vi.fn().mockResolvedValue(undefined),
    };
    const authMethodService = {
      revokeAllForUser: vi.fn().mockResolvedValue(undefined),
      invalidateAllVerificationTokensForUser: vi.fn().mockResolvedValue(undefined),
    };
    const uploadService = {
      tombstoneAllByUserId: vi.fn().mockResolvedValue(0),
    };
    service.wireOffboardingServices({
      authSessionService: authSessionService as never,
      authMethodService: authMethodService as never,
      uploadService: uploadService as never,
      userDataExportService: {
        deleteAllExportsForUser: vi.fn().mockResolvedValue(undefined),
      } as never,
    });
    await service.deleteUser(userRow.public_id);
    expect(repository.softDelete).toHaveBeenCalled();
  });

  it('findById delegates to repository', async () => {
    await service.findById(42);
    expect(repository.findById).toHaveBeenCalledWith(42);
  });

  it('updateMe rejects avatar keys outside the user prefix', async () => {
    await expect(
      service.updateMe(asUserScope(userRow.public_id), { avatar_key: 'wrong/prefix.png' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('findUserRecordByPublicId and login helpers delegate to repository', async () => {
    const record = await service.findUserRecordByPublicId(userRow.public_id);
    expect(record?.public_id).toBe(userRow.public_id);
    await service.updateLoginAttempt(userRow.public_id, 2, null);
    expect(repository.updateLoginAttempt).toHaveBeenCalledWith(userRow.public_id, 2, null);
    await service.updateEmailVerified(userRow.public_id);
    expect(repository.updateEmailVerified).toHaveBeenCalledWith(userRow.public_id);
  });

  it('deleteMe skips avatar cleanup when key is outside user prefix', async () => {
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...userRow,
      avatar_url: 'other-prefix/avatar.png',
    } as never);
    const authSessionService = {
      revokeAllSessions: vi.fn().mockResolvedValue(undefined),
    };
    const authMethodService = {
      revokeAllForUser: vi.fn().mockResolvedValue(undefined),
      invalidateAllVerificationTokensForUser: vi.fn().mockResolvedValue(undefined),
    };
    const uploadService = {
      tombstoneAllByUserId: vi.fn().mockResolvedValue(0),
    };
    service.wireOffboardingServices({
      authSessionService: authSessionService as never,
      authMethodService: authMethodService as never,
      uploadService: uploadService as never,
      userDataExportService: {
        deleteAllExportsForUser: vi.fn().mockResolvedValue(undefined),
      } as never,
    });
    await service.deleteMe(userRow.public_id);
    expect(objectStorage.deleteObject).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalledWith(userRow.public_id, {
      avatar_url: null,
    });
  });

  it('deleteMe logs when avatar object deletion fails', async () => {
    const avatarKey = `avatars/${userRow.public_id}/avatar.png`;
    vi.mocked(repository.findByPublicId).mockResolvedValue({
      ...userRow,
      avatar_url: avatarKey,
    } as never);
    vi.mocked(objectStorage.deleteObject).mockResolvedValueOnce(false);
    const authSessionService = {
      revokeAllSessions: vi.fn().mockResolvedValue(undefined),
    };
    const authMethodService = {
      revokeAllForUser: vi.fn().mockResolvedValue(undefined),
      invalidateAllVerificationTokensForUser: vi.fn().mockResolvedValue(undefined),
    };
    const uploadService = {
      tombstoneAllByUserId: vi.fn().mockResolvedValue(0),
    };
    service.wireOffboardingServices({
      authSessionService: authSessionService as never,
      authMethodService: authMethodService as never,
      uploadService: uploadService as never,
      userDataExportService: {
        deleteAllExportsForUser: vi.fn().mockResolvedValue(undefined),
      } as never,
    });
    await service.deleteMe(userRow.public_id);
    expect(repository.update).toHaveBeenCalledWith(userRow.public_id, {
      avatar_url: null,
    });
  });

  it('uploadAvatar accepts objects without contentType metadata', async () => {
    vi.mocked(objectStorage.headObject).mockResolvedValueOnce({
      contentType: undefined,
      contentLength: 100,
    });
    const avatarKey = `avatars/${userRow.public_id}/avatar.png`;
    await service.uploadAvatar(userRow.public_id, { avatar_key: avatarKey });
    expect(repository.update).toHaveBeenCalled();
  });

  describe('protected super-admin guard (route-#1)', () => {
    it('suspendUser refuses a target whose email is a global super-admin', async () => {
      resolveGlobalRoleForEmailMock.mockReturnValue(GLOBAL_ROLES.SUPER_ADMIN);
      await expect(service.suspendUser(userRow.public_id)).rejects.toBeInstanceOf(ForbiddenError);
      expect(repository.suspend).not.toHaveBeenCalled();
    });

    it('deleteUser refuses a target whose email is a global super-admin', async () => {
      resolveGlobalRoleForEmailMock.mockReturnValue(GLOBAL_ROLES.SUPER_ADMIN);
      await expect(service.deleteUser(userRow.public_id)).rejects.toBeInstanceOf(ForbiddenError);
      expect(repository.softDelete).not.toHaveBeenCalled();
    });

    it('adminUpdateUser refuses to deactivate a protected super-admin', async () => {
      resolveGlobalRoleForEmailMock.mockReturnValue(GLOBAL_ROLES.SUPER_ADMIN);
      await expect(
        service.adminUpdateUser(userRow.public_id, { status: 'SUSPENDED' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(repository.adminUpdate).not.toHaveBeenCalled();
    });

    it('suspendUser proceeds for a normal (non-admin) target', async () => {
      // default mock returns undefined → not a protected admin
      vi.mocked(repository.suspend).mockResolvedValue({
        ...userRow,
        suspended_at: new Date(),
      } as never);
      await service.suspendUser(userRow.public_id);
      expect(repository.suspend).toHaveBeenCalledWith(userRow.public_id);
    });
  });
});
