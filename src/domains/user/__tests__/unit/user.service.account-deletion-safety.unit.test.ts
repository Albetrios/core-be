import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserService } from '@/domains/user/user.service.js';
import type { UserRepository } from '@/domains/user/user.repository.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';

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

vi.mock('@/shared/utils/infrastructure/postgres-error.util.js', () => ({
  runInsertWithPublicIdentifierRetry: async (operation: () => Promise<unknown>) => operation(),
}));

/**
 * Regressions for sec-U1 + sec-U8 (High): account-deletion safety.
 *
 * - **sec-U1:** soft-deleting a user must invalidate every outstanding verification token
 *   (magic-link, password-reset, email-verify, email-change). Without this, a 15-minute
 *   magic-link issued seconds before deletion can mint a session for the "deleted" user.
 *
 * - **sec-U8:** session/credential revocation must complete BEFORE the data-export and
 *   upload purge steps. The original ordering ran `deleteAllExportsForUser` before
 *   `revokeAllSessions`, leaving a race window where a concurrent `POST /me/data-export`
 *   from a still-valid bearer could create an orphan PENDING export row that survives
 *   offboarding.
 */
describe('UserService.softDeleteUserWithOffboarding — sec-U1 + sec-U8', () => {
  const userRow = {
    id: 7,
    public_id: generatePublicId('user'),
    email: 'leaving@example.com',
    first_name: 'Leaving',
    last_name: 'User',
    avatar_url: null,
    deleted_at: null,
    deletion_started_at: null,
    password_hash: 'hash',
    is_email_verified: true,
    mfa_enabled: false,
    global_role: 'USER',
    suspended_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const repository = {
    findByPublicId: vi.fn().mockResolvedValue(userRow),
    softDelete: vi.fn().mockResolvedValue(userRow),
    markDeletionStarted: vi.fn().mockResolvedValue(userRow),
    update: vi.fn().mockResolvedValue(userRow),
  } as unknown as UserRepository;

  const objectStorage = createObjectStoragePortMock();
  const service = new UserService(repository, objectStorage);

  // Track every offboarding side-effect in order so we can assert revoke-before-purge.
  let callOrder: string[];
  let offboarding: {
    authSessionService: { revokeAllSessions: ReturnType<typeof vi.fn> };
    authMethodService: {
      revokeAllForUser: ReturnType<typeof vi.fn>;
      invalidateAllVerificationTokensForUser: ReturnType<typeof vi.fn>;
    };
    uploadService: { tombstoneAllByUserId: ReturnType<typeof vi.fn> };
    userDataExportService: { deleteAllExportsForUser: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    callOrder = [];
    vi.mocked(repository.findByPublicId).mockResolvedValue(userRow as never);
    vi.mocked(repository.softDelete).mockImplementation(async () => {
      callOrder.push('softDelete');
      return userRow as never;
    });
    vi.mocked(repository.markDeletionStarted).mockResolvedValue(userRow as never);

    offboarding = {
      authSessionService: {
        revokeAllSessions: vi.fn(async () => {
          callOrder.push('revokeAllSessions');
        }),
      },
      authMethodService: {
        revokeAllForUser: vi.fn(async () => {
          callOrder.push('revokeAllForUser');
        }),
        invalidateAllVerificationTokensForUser: vi.fn(async () => {
          callOrder.push('invalidateAllVerificationTokensForUser');
        }),
      },
      uploadService: {
        tombstoneAllByUserId: vi.fn(async () => {
          callOrder.push('tombstoneAllByUserId');
          return 0;
        }),
      },
      userDataExportService: {
        deleteAllExportsForUser: vi.fn(async () => {
          callOrder.push('deleteAllExportsForUser');
        }),
      },
    };

    service.wireOffboardingServices({
      authSessionService: offboarding.authSessionService as never,
      authMethodService: offboarding.authMethodService as never,
      uploadService: offboarding.uploadService as never,
      userDataExportService: offboarding.userDataExportService as never,
    });
  });

  it('invalidates every outstanding verification token for the user (sec-U1)', async () => {
    await service.deleteMe(userRow.public_id);

    expect(
      offboarding.authMethodService.invalidateAllVerificationTokensForUser,
    ).toHaveBeenCalledWith(userRow.public_id);
  });

  it('revokes sessions + auth methods BEFORE purging exports / uploads (sec-U8)', async () => {
    await service.deleteMe(userRow.public_id);

    const revokeAllSessionsIndex = callOrder.indexOf('revokeAllSessions');
    const revokeAllForUserIndex = callOrder.indexOf('revokeAllForUser');
    const deleteAllExportsIndex = callOrder.indexOf('deleteAllExportsForUser');
    const tombstoneAllUploadsIndex = callOrder.indexOf('tombstoneAllByUserId');

    expect(revokeAllSessionsIndex).toBeGreaterThanOrEqual(0);
    expect(revokeAllForUserIndex).toBeGreaterThanOrEqual(0);
    expect(deleteAllExportsIndex).toBeGreaterThanOrEqual(0);
    expect(tombstoneAllUploadsIndex).toBeGreaterThanOrEqual(0);

    // Revoke MUST happen before purge — otherwise a concurrent request from a still-valid
    // bearer can race the purge and produce an orphan PENDING export / upload row.
    expect(revokeAllSessionsIndex).toBeLessThan(deleteAllExportsIndex);
    expect(revokeAllSessionsIndex).toBeLessThan(tombstoneAllUploadsIndex);
    expect(revokeAllForUserIndex).toBeLessThan(deleteAllExportsIndex);
  });

  it('invalidates verification tokens BEFORE softDelete so a stale token cannot re-auth', async () => {
    await service.deleteMe(userRow.public_id);

    const invalidateIndex = callOrder.indexOf('invalidateAllVerificationTokensForUser');
    const softDeleteIndex = callOrder.indexOf('softDelete');

    expect(invalidateIndex).toBeGreaterThanOrEqual(0);
    expect(softDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(invalidateIndex).toBeLessThan(softDeleteIndex);
  });

  it('still soft-deletes the user as the final DB step (existing contract preserved)', async () => {
    await service.deleteMe(userRow.public_id);

    expect(callOrder).toContain('softDelete');
    // softDelete must be the last DB-state mutation that happens in the offboarding sequence
    // (S3 avatar deletion may follow, but no DB write should).
    const softDeleteIndex = callOrder.indexOf('softDelete');
    const laterDbSteps = callOrder
      .slice(softDeleteIndex + 1)
      .filter(
        (step) =>
          step === 'revokeAllSessions' ||
          step === 'revokeAllForUser' ||
          step === 'invalidateAllVerificationTokensForUser' ||
          step === 'deleteAllExportsForUser',
      );
    expect(laterDbSteps).toEqual([]);
  });
});
