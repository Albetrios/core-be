import { describe, expect, it, vi } from 'vitest';

// audit #40: findActiveByKeyPrefix bounds the per-request constant-time compare loop. Mock the
// request database so the SECURITY DEFINER resolver returns more candidates than the cap.
const dbMocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock(
  '@/infrastructure/database/contexts/database-context-runtime.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      getRequestDatabase: () => ({ execute: dbMocks.execute }),
      // The key-prefix resolver goes through the context-free accessor: same mock handle.
      getContextFreeDatabase: () => ({ execute: dbMocks.execute }),
    };
  },
);

import { OrganizationApiKeyRepository } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.repository.js';

function resolverRow(index: number) {
  return {
    public_id: `apikey_${index}`,
    organization_id: 1,
    organization_public_id: 'org_public',
    key_hash: `hash_${index}`,
    scopes: '[]',
    status: 'active',
    expires_at: null,
  };
}

describe('OrganizationApiKeyRepository.findActiveByKeyPrefix — prefix cap (audit #40)', () => {
  it('returns at most 16 candidates even when the resolver yields more', async () => {
    dbMocks.execute.mockResolvedValue({
      rows: Array.from({ length: 17 }, (_, index) => resolverRow(index)),
    });

    const repository = new OrganizationApiKeyRepository();
    const candidates = await repository.findActiveByKeyPrefix('abcdef0123');

    expect(candidates).toHaveLength(16);
  });

  it('returns all candidates when under the cap', async () => {
    dbMocks.execute.mockResolvedValue({
      rows: Array.from({ length: 3 }, (_, index) => resolverRow(index)),
    });

    const repository = new OrganizationApiKeyRepository();
    const candidates = await repository.findActiveByKeyPrefix('abcdef0123');

    expect(candidates).toHaveLength(3);
  });
});
