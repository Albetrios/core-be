import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebauthnService } from '@/domains/auth/sub-domains/auth-webauthn/webauthn.service.js';
import { ConflictError, UnauthorizedError, ValidationError } from '@/shared/errors/index.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { WebauthnCredentialRepository } from '@/domains/auth/sub-domains/auth-webauthn/webauthn-credential.repository.js';

/**
 * The registration and authentication ceremonies were the largest no-coverage cluster in the
 * mutation run (49.62% score, 51 uncovered mutants): `generateRegistrationOptions`,
 * `verifyRegistration`, and the whole of `verifyAuthentication` were exercised only by the
 * integration suite, which Stryker's unit surface never runs. These cases pin the ceremony
 * decisions at the unit layer — the challenge/user binding, the credential material handed to
 * the verifier, the counter update, and the refusal arms.
 */

const { consumeChallengeMock, createChallengeMock } = vi.hoisted(() => ({
  consumeChallengeMock: vi.fn(),
  createChallengeMock: vi.fn().mockResolvedValue('challenge-token'),
}));

vi.mock('@/domains/auth/sub-domains/auth-webauthn/webauthn-challenge.js', () => ({
  createWebauthnChallenge: createChallengeMock,
  consumeWebauthnChallenge: consumeChallengeMock,
}));

const { generateRegistrationOptionsMock, verifyRegistrationMock, verifyAuthenticationMock } =
  vi.hoisted(() => ({
    generateRegistrationOptionsMock: vi.fn(),
    verifyRegistrationMock: vi.fn(),
    verifyAuthenticationMock: vi.fn(),
  }));

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: generateRegistrationOptionsMock,
  verifyRegistrationResponse: verifyRegistrationMock,
  verifyAuthenticationResponse: verifyAuthenticationMock,
}));

const { completeFirstFactorAuthMock } = vi.hoisted(() => ({
  completeFirstFactorAuthMock: vi.fn().mockResolvedValue({ access_token: 'jwt', session: 'sid' }),
}));

vi.mock('@/domains/auth/shared/complete-first-factor-auth.js', () => ({
  completeFirstFactorAuth: completeFirstFactorAuthMock,
}));

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Blanket maintenance passthrough: services this suite touches (directly or via
    // cross-domain imports) may enter maintenance contexts (tombstoning, admin reads) —
    // the real wrapper opens a database.transaction() and CI's unit lane has no Postgres.
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
    withAppDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

const ACTIVE_USER = {
  id: 7,
  public_id: 'usr_a1b2c3d4e5f6g7h8i9j0k',
  email: 'owner@example.com',
  status: 'ACTIVE',
  deleted_at: null,
  is_email_verified: true,
  is_mfa_enabled: false,
};

const STORED_CREDENTIAL = {
  user_id: 7,
  credential_id: 'cred-abc',
  public_key: Buffer.from('public-key-bytes').toString('base64url'),
  counter: 41,
  transports: ['internal'],
};

function buildService(overrides: { user?: unknown; credential?: unknown; listActive?: unknown[] }) {
  const userService = {
    requireUserRecordByPublicId: vi.fn().mockResolvedValue(overrides.user ?? ACTIVE_USER),
  } as unknown as UserService;
  const credentialRepository = {
    findActiveByCredentialId: vi
      .fn()
      .mockResolvedValue('credential' in overrides ? overrides.credential : STORED_CREDENTIAL),
    listActiveByUserId: vi.fn().mockResolvedValue(overrides.listActive ?? []),
    updateCounter: vi.fn().mockResolvedValue(undefined),
    acquireCreationQuotaLock: vi.fn().mockResolvedValue(undefined),
    countActiveByUserId: vi.fn().mockResolvedValue(0),
    createCredential: vi.fn().mockResolvedValue({ credential_id: 'cred-new' }),
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
  return { service, userService, credentialRepository };
}

function authenticationBody(userHandle?: string) {
  return {
    challenge_token: 'a'.repeat(64),
    response: {
      id: 'cred-abc',
      rawId: 'cred-abc',
      type: 'public-key',
      clientDataJSON: 'client-data',
      response: {
        ...(userHandle !== undefined ? { userHandle } : {}),
        clientDataJSON: 'client-data',
        authenticatorData: 'auth-data',
        signature: 'sig',
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createChallengeMock.mockResolvedValue('challenge-token');
  completeFirstFactorAuthMock.mockResolvedValue({ access_token: 'jwt', session: 'sid' });
  consumeChallengeMock.mockResolvedValue({
    user_public_id: ACTIVE_USER.public_id,
    challenge: 'expected-challenge',
  });
  verifyAuthenticationMock.mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 42 },
  });
});

describe('WebauthnService.verifyAuthentication', () => {
  it('completes the ceremony: verifier gets the STORED credential material, the counter advances, and the session mint receives the user', async () => {
    const { service, credentialRepository } = buildService({});

    const result = await service.verifyAuthentication(
      authenticationBody(),
      '203.0.113.7',
      undefined,
      'agent/1.0',
    );

    // The challenge must be consumed from the AUTHENTICATION namespace — a registration
    // challenge replayed here would otherwise mint a session.
    expect(consumeChallengeMock).toHaveBeenCalledWith(
      expect.anything(),
      'a'.repeat(64),
      'authentication',
    );

    // The verifier is fed the stored credential, not anything client-supplied: decoded
    // public key bytes, the persisted counter, and user verification required.
    const verifierArgs = verifyAuthenticationMock.mock.calls[0]?.[0] as {
      expectedChallenge: string;
      requireUserVerification: boolean;
      credential: { id: string; publicKey: Buffer; counter: number };
    };
    expect(verifierArgs.expectedChallenge).toBe('expected-challenge');
    expect(verifierArgs.requireUserVerification).toBe(true);
    expect(verifierArgs.credential.id).toBe('cred-abc');
    expect(verifierArgs.credential.counter).toBe(41);
    expect(Buffer.from(verifierArgs.credential.publicKey).toString('utf8')).toBe(
      'public-key-bytes',
    );

    // Clone-detection depends on the persisted counter advancing to the verifier's value.
    expect(credentialRepository.updateCounter).toHaveBeenCalledWith('cred-abc', 42);

    // The session is minted for the challenged user with the personal-org self-heal arm on.
    const completion = completeFirstFactorAuthMock.mock.calls[0]?.[0] as {
      user: { public_id: string; email: string };
      ensurePersonalOrganizationOnMiss: boolean;
      ipAddress: string;
      userAgent?: string;
    };
    expect(completion.user.public_id).toBe(ACTIVE_USER.public_id);
    expect(completion.ensurePersonalOrganizationOnMiss).toBe(true);
    expect(completion.ipAddress).toBe('203.0.113.7');
    expect(completion.userAgent).toBe('agent/1.0');
    expect(result).toEqual({ access_token: 'jwt', session: 'sid' });
  });

  it('accepts a resident-credential userHandle that decodes to the challenged user', async () => {
    const { service } = buildService({});
    const handle = Buffer.from(ACTIVE_USER.public_id, 'utf8').toString('base64url');

    await expect(
      service.verifyAuthentication(authenticationBody(handle), '203.0.113.7'),
    ).resolves.toBeDefined();
  });

  it('rejects a userHandle for a DIFFERENT user before any credential lookup (account-confusion pin)', async () => {
    const { service, credentialRepository } = buildService({});
    const foreignHandle = Buffer.from('usr_zzzzzzzzzzzzzzzzzzzzz', 'utf8').toString('base64url');

    await expect(
      service.verifyAuthentication(authenticationBody(foreignHandle), '203.0.113.7'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(credentialRepository.findActiveByCredentialId).not.toHaveBeenCalled();
    expect(completeFirstFactorAuthMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown credential id without reaching the verifier', async () => {
    const { service } = buildService({ credential: null });

    await expect(
      service.verifyAuthentication(authenticationBody(), '203.0.113.7'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(verifyAuthenticationMock).not.toHaveBeenCalled();
  });

  it('rejects when the credential belongs to a different user than the challenge resolved', async () => {
    const { service } = buildService({ credential: { ...STORED_CREDENTIAL, user_id: 999 } });

    await expect(
      service.verifyAuthentication(authenticationBody(), '203.0.113.7'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(verifyAuthenticationMock).not.toHaveBeenCalled();
  });

  it('rejects a suspended user before the signature is ever verified (sec-U1)', async () => {
    const { service } = buildService({ user: { ...ACTIVE_USER, status: 'SUSPENDED' } });

    await expect(
      service.verifyAuthentication(authenticationBody(), '203.0.113.7'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(verifyAuthenticationMock).not.toHaveBeenCalled();
    expect(completeFirstFactorAuthMock).not.toHaveBeenCalled();
  });

  it('a failed signature verification mints no session and never advances the counter', async () => {
    verifyAuthenticationMock.mockResolvedValue({ verified: false });
    const { service, credentialRepository } = buildService({});

    await expect(
      service.verifyAuthentication(authenticationBody(), '203.0.113.7'),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(credentialRepository.updateCounter).not.toHaveBeenCalled();
    expect(completeFirstFactorAuthMock).not.toHaveBeenCalled();
  });
});

describe('WebauthnService.generateRegistrationOptions', () => {
  beforeEach(() => {
    generateRegistrationOptionsMock.mockResolvedValue({ challenge: 'reg-challenge' });
  });

  it('builds options from the user identity and stores the challenge in the REGISTRATION namespace', async () => {
    const { service } = buildService({
      listActive: [{ credential_id: 'cred-existing', transports: ['usb'] }],
    });

    const result = await service.generateRegistrationOptions(ACTIVE_USER.public_id);

    const options = generateRegistrationOptionsMock.mock.calls[0]?.[0] as {
      userID: Buffer;
      userName: string;
      excludeCredentials: Array<{ id: string }>;
      authenticatorSelection: { userVerification: string };
    };
    // userID = utf8(public_id) is what the authenticate-time userHandle guard decodes against.
    expect(options.userID.toString('utf8')).toBe(ACTIVE_USER.public_id);
    expect(options.userName).toBe(ACTIVE_USER.email);
    // Existing passkeys are excluded so the browser does not double-enroll.
    expect(options.excludeCredentials.map((c) => c.id)).toEqual(['cred-existing']);
    // sec-r4-A2: enrollment must demand UV, matching requireUserVerification at verify time.
    expect(options.authenticatorSelection.userVerification).toBe('required');

    expect(createChallengeMock).toHaveBeenCalledWith(
      expect.anything(),
      'registration',
      ACTIVE_USER.public_id,
      'reg-challenge',
    );
    expect(result.challenge_token).toBe('challenge-token');
  });

  it('refuses enrollment for an unverified email (pre-hijacking guard) before any challenge exists', async () => {
    const { service } = buildService({ user: { ...ACTIVE_USER, is_email_verified: false } });

    await expect(service.generateRegistrationOptions(ACTIVE_USER.public_id)).rejects.toThrowError();
    expect(createChallengeMock).not.toHaveBeenCalled();
  });
});

describe('WebauthnService.verifyRegistration', () => {
  const registrationBody = {
    challenge_token: 'b'.repeat(64),
    response: {
      id: 'cred-new',
      rawId: 'cred-new',
      type: 'public-key',
      clientDataJSON: 'client-data',
      response: { clientDataJSON: 'client-data', attestationObject: 'attestation' },
    },
  };

  beforeEach(() => {
    verifyRegistrationMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred-new',
          publicKey: Buffer.from('new-public-key'),
          counter: 0,
          transports: ['internal'],
        },
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    });
  });

  it('persists the verified credential with base64url key material and reports its id', async () => {
    const { service, credentialRepository } = buildService({});

    const result = await service.verifyRegistration(ACTIVE_USER.public_id, registrationBody);

    expect(consumeChallengeMock).toHaveBeenCalledWith(
      expect.anything(),
      'b'.repeat(64),
      'registration',
    );
    const created = vi.mocked(credentialRepository.createCredential).mock.calls[0]?.[0] as {
      user_id: number;
      credential_id: string;
      public_key: string;
      counter: number;
      backed_up: boolean;
    };
    expect(created.user_id).toBe(ACTIVE_USER.id);
    expect(created.credential_id).toBe('cred-new');
    expect(Buffer.from(created.public_key, 'base64url').toString('utf8')).toBe('new-public-key');
    expect(created.counter).toBe(0);
    expect(created.backed_up).toBe(true);
    expect(result).toEqual({ verified: true, credential_id: 'cred-new' });
  });

  it('rejects a challenge minted for a different user without touching the verifier', async () => {
    consumeChallengeMock.mockResolvedValue({
      user_public_id: 'usr_zzzzzzzzzzzzzzzzzzzzz',
      challenge: 'expected-challenge',
    });
    const { service, credentialRepository } = buildService({});

    await expect(
      service.verifyRegistration(ACTIVE_USER.public_id, registrationBody),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(verifyRegistrationMock).not.toHaveBeenCalled();
    expect(credentialRepository.createCredential).not.toHaveBeenCalled();
  });

  it('a failed attestation stores nothing and surfaces a ValidationError', async () => {
    verifyRegistrationMock.mockResolvedValue({ verified: false });
    const { service, credentialRepository } = buildService({});

    await expect(
      service.verifyRegistration(ACTIVE_USER.public_id, registrationBody),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(credentialRepository.createCredential).not.toHaveBeenCalled();
  });

  it('maps a replayed credential id (unique violation) to a clean 409', async () => {
    const { service, credentialRepository } = buildService({});
    vi.mocked(credentialRepository.createCredential).mockRejectedValue(
      Object.assign(new Error('duplicate key'), { code: '23505' }),
    );

    await expect(
      service.verifyRegistration(ACTIVE_USER.public_id, registrationBody),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
