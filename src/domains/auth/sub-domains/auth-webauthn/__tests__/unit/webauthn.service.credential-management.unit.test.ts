import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError, NotFoundError, UnauthorizedError } from '@/shared/errors/index.js';
import { WebauthnService } from '@/domains/auth/sub-domains/auth-webauthn/webauthn.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { WebauthnCredentialRepository } from '@/domains/auth/sub-domains/auth-webauthn/webauthn-credential.repository.js';

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

const user = { id: 7, public_id: 'usr_abcdefghijklmnopqrstu' };

function buildCredential(publicId: string, id: number) {
  return {
    id,
    public_id: publicId,
    user_id: user.id,
    credential_id: `raw-${id}`,
    public_key: 'key',
    counter: 0,
    device_type: 'multiDevice',
    backed_up: true,
    transports: ['internal'],
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    last_used_at: null,
    revoked_at: null,
  };
}

describe('WebauthnService — passkey management (sec-r5-M3)', () => {
  const userService = {
    requireUserRecordByPublicId: vi.fn().mockResolvedValue(user),
  } as unknown as UserService;

  const credentialRepository = {
    listActiveByUserId: vi.fn(),
    revokeByUserId: vi.fn().mockResolvedValue(undefined),
  } as unknown as WebauthnCredentialRepository;

  const authMethodService = {
    acquireCredentialMutationLock: vi.fn().mockResolvedValue(undefined),
    hasLoginCapableMethod: vi.fn().mockResolvedValue(true),
  } as unknown as AuthMethodService;

  const service = new WebauthnService(
    userService,
    {} as never,
    credentialRepository,
    {} as never,
    {} as never,
    {} as never,
    authMethodService,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(user as never);
    vi.mocked(authMethodService.hasLoginCapableMethod).mockResolvedValue(true);
  });

  describe('listCredentials', () => {
    it('serializes active passkeys without exposing credential material or internal ids', async () => {
      vi.mocked(credentialRepository.listActiveByUserId).mockResolvedValue([
        buildCredential('wac_aaaaaaaaaaaaaaaaaaaaa', 1),
      ] as never);

      const result = await service.listCredentials(user.public_id);

      expect(result).toEqual([
        {
          id: 'wac_aaaaaaaaaaaaaaaaaaaaa',
          device_type: 'multiDevice',
          backed_up: true,
          transports: ['internal'],
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          last_used_at: null,
        },
      ]);
      // Never leak the raw blob / public key / counter / numeric id / user_id.
      expect(JSON.stringify(result)).not.toContain('raw-1');
      expect(JSON.stringify(result)).not.toContain('public_key');
      expect(JSON.stringify(result)).not.toContain('user_id');
    });

    it('rejects when the user record is missing', async () => {
      vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(null as never);
      await expect(service.listCredentials(user.public_id)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    });
  });

  describe('revokeCredential', () => {
    it('revokes a passkey by public id when others remain (wires revokeByUserId)', async () => {
      vi.mocked(credentialRepository.listActiveByUserId).mockResolvedValue([
        buildCredential('wac_aaaaaaaaaaaaaaaaaaaaa', 1),
        buildCredential('wac_bbbbbbbbbbbbbbbbbbbbb', 2),
      ] as never);

      await service.revokeCredential(user.public_id, 'wac_aaaaaaaaaaaaaaaaaaaaa');

      expect(authMethodService.acquireCredentialMutationLock).toHaveBeenCalledWith(user.id);
      expect(credentialRepository.revokeByUserId).toHaveBeenCalledWith(user.id, 1);
      // More than one passkey remained, so the login-capability check is skipped.
      expect(authMethodService.hasLoginCapableMethod).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the passkey is not owned / not active', async () => {
      vi.mocked(credentialRepository.listActiveByUserId).mockResolvedValue([
        buildCredential('wac_aaaaaaaaaaaaaaaaaaaaa', 1),
      ] as never);

      await expect(
        service.revokeCredential(user.public_id, 'wac_zzzzzzzzzzzzzzzzzzzzz'),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(credentialRepository.revokeByUserId).not.toHaveBeenCalled();
    });

    it('refuses to revoke the last passkey for a passkey-only user (lockout guard)', async () => {
      vi.mocked(credentialRepository.listActiveByUserId).mockResolvedValue([
        buildCredential('wac_aaaaaaaaaaaaaaaaaaaaa', 1),
      ] as never);
      vi.mocked(authMethodService.hasLoginCapableMethod).mockResolvedValue(false);

      await expect(
        service.revokeCredential(user.public_id, 'wac_aaaaaaaaaaaaaaaaaaaaa'),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(credentialRepository.revokeByUserId).not.toHaveBeenCalled();
    });

    it('allows revoking the last passkey when the user has another login method', async () => {
      vi.mocked(credentialRepository.listActiveByUserId).mockResolvedValue([
        buildCredential('wac_aaaaaaaaaaaaaaaaaaaaa', 1),
      ] as never);
      vi.mocked(authMethodService.hasLoginCapableMethod).mockResolvedValue(true);

      await service.revokeCredential(user.public_id, 'wac_aaaaaaaaaaaaaaaaaaaaa');

      expect(authMethodService.hasLoginCapableMethod).toHaveBeenCalledWith(user.public_id);
      expect(credentialRepository.revokeByUserId).toHaveBeenCalledWith(user.id, 1);
    });
  });
});
