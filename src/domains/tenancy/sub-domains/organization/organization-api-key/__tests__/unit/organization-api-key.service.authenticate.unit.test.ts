import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrganizationApiKeyService } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.service.js';
import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

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
    withPrincipalDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

const _asScope = (organizationPublicId: string) =>
  createPrincipalDatabaseScope({
    organizationPublicId,
    source: 'request',
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
    // The resolver already returned the org public id, so we never read it back via the repo.
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
});
