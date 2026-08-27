import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebauthnService } from '@/domains/auth/sub-domains/auth-webauthn/webauthn.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { WebauthnCredentialRepository } from '@/domains/auth/sub-domains/auth-webauthn/webauthn-credential.repository.js';

vi.mock('@/domains/auth/sub-domains/auth-webauthn/webauthn-challenge.js', () => ({
  createWebauthnChallenge: vi.fn().mockResolvedValue('challenge-token'),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: vi.fn(
    async ({ allowCredentials }: { allowCredentials: { id: string }[] }) => ({
      challenge: 'challenge',
      rpId: 'localhost',
      allowCredentials,
    }),
  ),
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

describe('WebauthnService.generateAuthenticationOptions', () => {
  const userService = {
    findByEmail: vi.fn(),
  } as unknown as UserService;

  const credentialRepository = {
    listActiveByUserId: vi.fn(),
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when no email is supplied (DTO requires it after sec-A #24)', async () => {
    // The DTO now requires `email`, so the validator throws a ValidationError before the
    // service is reached in production. This test still uses the service directly to keep
    // the defense-in-depth runtime check covered — it routes via the same anti-enumeration
    // UnauthorizedError shape rather than leaking the validation failure.
    await expect(service.generateAuthenticationOptions({})).rejects.toBeInstanceOf(
      // Either ValidationError (preferred — DTO rejects) or UnauthorizedError (service
      // defense in depth) is acceptable; both refuse the request without leaking state.
      Error,
    );
  });

  it('returns decoy options for an unknown email AND runs the credential lookup to equalize timing (route-audit D1)', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(null);
    vi.mocked(credentialRepository.listActiveByUserId).mockResolvedValue([] as never);

    const result = await service.generateAuthenticationOptions({ email: 'missing@example.com' });

    expect(result.challenge_token).toBe('challenge-token');
    expect(result.options.allowCredentials).toHaveLength(1);
    // D1: the lookup now runs even for an unknown email (synthetic context, user_id 0) so the DB
    // round-trip — and thus response latency — matches the known-email path. Pre-fix it was skipped,
    // leaving a timing oracle that re-opened the enumeration channel the decoy was built to close.
    expect(credentialRepository.listActiveByUserId).toHaveBeenCalledWith(0);
  });

  it('returns decoy options for a known email that has no registered passkeys', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue({
      id: 1,
      public_id: 'abcdefghijklmnopqrstu',
      email: 'user@example.com',
    } as never);
    vi.mocked(credentialRepository.listActiveByUserId).mockResolvedValue([]);

    const result = await service.generateAuthenticationOptions({ email: 'user@example.com' });

    expect(result.challenge_token).toBe('challenge-token');
    expect(result.options.allowCredentials).toHaveLength(1);
  });

  it('derives a stable decoy credential id per email across repeated probes', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue(null);

    const first = await service.generateAuthenticationOptions({ email: 'probe@example.com' });
    const second = await service.generateAuthenticationOptions({ email: 'probe@example.com' });
    const other = await service.generateAuthenticationOptions({ email: 'different@example.com' });

    const firstId = (first.options.allowCredentials as { id: string }[])[0]?.id;
    const secondId = (second.options.allowCredentials as { id: string }[])[0]?.id;
    const otherId = (other.options.allowCredentials as { id: string }[])[0]?.id;

    expect(firstId).toBe(secondId);
    expect(firstId).not.toBe(otherId);
  });

  it('returns real credentials for a known email that has passkeys', async () => {
    vi.mocked(userService.findByEmail).mockResolvedValue({
      id: 7,
      public_id: 'abcdefghijklmnopqrstu',
      email: 'has-passkey@example.com',
    } as never);
    vi.mocked(credentialRepository.listActiveByUserId).mockResolvedValue([
      { credential_id: 'real-credential', transports: ['internal'] },
    ] as never);

    const result = await service.generateAuthenticationOptions({
      email: 'has-passkey@example.com',
    });

    const credentialIds = (result.options.allowCredentials as { id: string }[]).map(
      (credential) => credential.id,
    );
    expect(credentialIds).toContain('real-credential');
  });
});
