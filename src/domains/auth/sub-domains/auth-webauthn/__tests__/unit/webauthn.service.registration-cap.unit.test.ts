import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError } from '@/shared/errors/index.js';
import { WEBAUTHN_RP_NAME_DEFAULT } from '@/shared/constants/project-identity.constants.js';
import { MAX_WEBAUTHN_CREDENTIALS_PER_USER } from '@/shared/constants/security.constants.js';
import { WebauthnService } from '@/domains/auth/sub-domains/auth-webauthn/webauthn.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { WebauthnCredentialRepository } from '@/domains/auth/sub-domains/auth-webauthn/webauthn-credential.repository.js';

// Run the registration verify without a real DB transaction.
vi.mock('@/infrastructure/database/contexts/user-database.context.js', () => ({
  withUserDatabaseContext: vi.fn((_userPublicId: string, callback: () => Promise<unknown>) =>
    callback(),
  ),
}));

// Stub the challenge consume so the test never touches Redis.
vi.mock('@/domains/auth/sub-domains/auth-webauthn/webauthn-challenge.js', () => ({
  consumeWebauthnChallenge: vi
    .fn()
    .mockResolvedValue({ user_public_id: 'usr_abcdefghijklmnopqrstu', challenge: 'chal' }),
  createWebauthnChallenge: vi.fn(),
}));

vi.mock('@/domains/auth/sub-domains/auth-webauthn/webauthn.config.js', () => ({
  resolveWebauthnExpectedOrigin: vi.fn(() => 'https://app.example.com'),
  resolveWebauthnRelyingPartyId: vi.fn(() => 'app.example.com'),
  resolveWebauthnRelyingPartyName: vi.fn(() => WEBAUTHN_RP_NAME_DEFAULT),
}));

vi.mock('@/domains/auth/sub-domains/auth-webauthn/webauthn.validator.js', () => ({
  validateWebauthnRegisterVerify: vi.fn((body: unknown) => body),
  validateWebauthnAuthenticateOptions: vi.fn((body: unknown) => body),
  validateWebauthnAuthenticateVerify: vi.fn((body: unknown) => body),
}));

vi.mock('@simplewebauthn/server', () => ({
  verifyRegistrationResponse: vi.fn().mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: {
        id: 'new-credential-id',
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ['internal'],
      },
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
    },
  }),
  verifyAuthenticationResponse: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
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

const user = { id: 7, public_id: 'usr_abcdefghijklmnopqrstu', status: 'ACTIVE', deleted_at: null };

/**
 * Regression for the per-user passkey cap: registering a new passkey must refuse once the user holds
 * MAX_WEBAUTHN_CREDENTIALS_PER_USER active credentials. The count + insert run under the per-user
 * advisory lock so concurrent registrations cannot overshoot.
 */
describe('WebauthnService.verifyRegistration — per-user passkey cap', () => {
  const userService = {
    requireUserRecordByPublicId: vi.fn().mockResolvedValue(user),
  } as unknown as UserService;

  const credentialRepository = {
    acquireCreationQuotaLock: vi.fn().mockResolvedValue(undefined),
    countActiveByUserId: vi.fn().mockResolvedValue(0),
    createCredential: vi.fn().mockResolvedValue({ credential_id: 'new-credential-id' }),
  } as unknown as WebauthnCredentialRepository;

  const service = new WebauthnService(
    userService,
    {} as never,
    credentialRepository,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const body = { challenge_token: 'tok', response: {} };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(userService.requireUserRecordByPublicId).mockResolvedValue(user as never);
    vi.mocked(credentialRepository.countActiveByUserId).mockResolvedValue(0);
  });

  it('registers a passkey when under the cap (lock taken, then insert)', async () => {
    const result = await service.verifyRegistration(
      user.public_id,
      body,
      'https://app.example.com',
    );
    expect(result.verified).toBe(true);
    expect(credentialRepository.acquireCreationQuotaLock).toHaveBeenCalledWith(user.id);
    expect(credentialRepository.createCredential).toHaveBeenCalledTimes(1);
  });

  it('rejects registration once the per-user passkey cap is reached', async () => {
    vi.mocked(credentialRepository.countActiveByUserId).mockResolvedValue(
      MAX_WEBAUTHN_CREDENTIALS_PER_USER,
    );
    await expect(
      service.verifyRegistration(user.public_id, body, 'https://app.example.com'),
    ).rejects.toBeInstanceOf(ConflictError);
    // The lock is taken before the count, and no credential is persisted at the cap.
    expect(credentialRepository.acquireCreationQuotaLock).toHaveBeenCalledWith(user.id);
    expect(credentialRepository.createCredential).not.toHaveBeenCalled();
  });
});
