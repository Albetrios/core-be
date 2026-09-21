import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrganizationApiKeyService } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.service.js';
import {
  PRINCIPAL_SCOPE,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

const claimLastUsedWrite = vi.fn().mockResolvedValue(true);
vi.mock(
  '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key-last-used.throttle.js',
  () => ({
    claimApiKeyLastUsedWrite: (...args: unknown[]) => claimLastUsedWrite(...args),
  }),
);

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

const _asScope = (organizationPublicId: string) =>
  PRINCIPAL_SCOPE.REQUEST({
    organizationPublicId,
  }) as OrganizationPrincipalDatabaseScope;

describe('OrganizationApiKeyService.authenticate', () => {
  const organizationRepository = {
    findById: vi.fn(),
  };

  const apiKeyRepository = {
    findActiveByKeyPrefix: vi.fn(),
    touchLastUsedAt: vi.fn().mockResolvedValue(undefined),
  };

  const service = new OrganizationApiKeyService(
    organizationRepository as never,
    apiKeyRepository as never,
    { resolveUserOrganizationPermissions: vi.fn() } as never,
    { findAll: vi.fn().mockResolvedValue([]) } as never,
  );

  // Shape returned by the tenancy.resolve_api_key_for_authentication SECURITY DEFINER resolver —
  // the owning organization public id is included so authenticate never reads tenancy.organizations.
  const candidate = {
    public_id: 'apikey_public_abc',
    organization_id: 1,
    organization_public_id: 'org_public_abc',
    key_hash: 'stored-hash',
    scopes: ['read'],
    expires_at: null,
    status: 'ACTIVE',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    claimLastUsedWrite.mockResolvedValue(true);
  });

  it('returns auth match for valid prefix + hash and touches last_used_at', async () => {
    vi.mocked(apiKeyRepository.findActiveByKeyPrefix).mockResolvedValue([candidate] as never);
    const hashCompare = vi.fn().mockReturnValue(true);

    const result = await service.authenticate('ak_prefix', 'candidate-hash', hashCompare);

    expect(result).toEqual({
      public_id: 'apikey_public_abc',
      organization_public_id: 'org_public_abc',
      scopes: ['read'],
    });
    expect(hashCompare).toHaveBeenCalledWith('stored-hash', 'candidate-hash');
    expect(apiKeyRepository.touchLastUsedAt).toHaveBeenCalledWith('apikey_public_abc');
    // The resolver already returned the organization public id, so we never read it back via the repo.
    expect(organizationRepository.findById).not.toHaveBeenCalled();
  });

  it('returns null when hash does not match any candidate', async () => {
    vi.mocked(apiKeyRepository.findActiveByKeyPrefix).mockResolvedValue([candidate] as never);
    const result = await service.authenticate('ak_prefix', 'wrong-hash', () => false);
    expect(result).toBeNull();
    expect(apiKeyRepository.touchLastUsedAt).not.toHaveBeenCalled();
  });

  it('returns null for expired api key even when hash matches', async () => {
    vi.mocked(apiKeyRepository.findActiveByKeyPrefix).mockResolvedValue([
      { ...candidate, expires_at: new Date(Date.now() - 60_000) },
    ] as never);
    const result = await service.authenticate('ak_prefix', 'candidate-hash', () => true);
    expect(result).toBeNull();
    expect(apiKeyRepository.touchLastUsedAt).not.toHaveBeenCalled();
  });

  it('returns null when no active candidates exist for prefix', async () => {
    vi.mocked(apiKeyRepository.findActiveByKeyPrefix).mockResolvedValue([]);
    const result = await service.authenticate('ak_unknown', 'hash', () => true);
    expect(result).toBeNull();
  });

  it('skips the last_used_at write when the throttle window is already claimed', async () => {
    // The point of the throttle. `touchLastUsedAt` is wrapped in `withAppDatabaseContext`, which
    // opens a transaction and holds a pooled connection — and it was the ONLY transaction an
    // authenticated API-key request opened. Skipping it here is the whole saving; the request
    // still authenticates identically.
    vi.mocked(apiKeyRepository.findActiveByKeyPrefix).mockResolvedValue([candidate] as never);
    claimLastUsedWrite.mockResolvedValue(false);

    const result = await service.authenticate('ak_prefix', 'candidate-hash', () => true);

    expect(result).toEqual({
      public_id: 'apikey_public_abc',
      organization_public_id: 'org_public_abc',
      scopes: ['read'],
    });
    expect(claimLastUsedWrite).toHaveBeenCalledWith('apikey_public_abc');
    expect(apiKeyRepository.touchLastUsedAt).not.toHaveBeenCalled();
  });

  it('never claims a throttle window for a key that failed to authenticate', async () => {
    // A claim on a rejected key would let an attacker spraying a known public id suppress the
    // legitimate holder's `last_used_at` — small, but it is free not to have.
    vi.mocked(apiKeyRepository.findActiveByKeyPrefix).mockResolvedValue([candidate] as never);
    await service.authenticate('ak_prefix', 'wrong-hash', () => false);
    expect(claimLastUsedWrite).not.toHaveBeenCalled();
  });
});
