import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/infrastructure/cache/redis.client.js', () => ({
  redisConnection: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    scan: vi.fn(),
  },
}));

import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import type { PermissionRepository } from '@/domains/tenancy/sub-domains/permission/permission.repository.js';

// The service paths under test run inside the real principal wrapper, which
// opens a `database.transaction()` — passthrough so no Postgres is needed
// (CI's unit/contract lanes run without a database service).
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

describe('AuthorizationService', () => {
  const permissionRepository = {
    findPermissionCodesForUserInOrganization: vi
      .fn()
      .mockResolvedValue(['organization:read', 'organization:manage']),
  } as unknown as PermissionRepository;

  const authorizationService = new AuthorizationService(permissionRepository);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cached permissions without hitting the database', async () => {
    // Version key holds an integer; the data key holds the JSON codes — mock per-key so the
    // version reader parses '0' rather than choking on the codes array.
    vi.mocked(redisConnection.get).mockImplementation(async (key) =>
      String(key).startsWith('perm:org:') ? '0' : JSON.stringify(['organization:read']),
    );
    const codes = await authorizationService.resolveUserOrganizationPermissions(
      'user_public',
      'org_public',
    );
    expect(codes).toEqual(['organization:read']);
    expect(permissionRepository.findPermissionCodesForUserInOrganization).not.toHaveBeenCalled();
  });

  it('recomputes and caches permissions on cache miss', async () => {
    vi.mocked(redisConnection.get).mockResolvedValue(null);
    vi.mocked(redisConnection.set).mockResolvedValue('OK');
    vi.mocked(redisConnection.del).mockResolvedValue(1);
    const codes = await authorizationService.resolveUserOrganizationPermissions(
      'user_public',
      'org_public',
    );
    expect(codes).toEqual(['organization:read', 'organization:manage']);
    expect(permissionRepository.findPermissionCodesForUserInOrganization).toHaveBeenCalled();
    expect(redisConnection.set).toHaveBeenCalled();
  });

  it('sec-r5-L3: resolveUserOrganizationPermissionsFromDatabase bypasses the cache (no read, no write)', async () => {
    // A fresh cache value is present — the DB-direct path must ignore it and hit the join,
    // and must not read or write Redis.
    vi.mocked(redisConnection.get).mockResolvedValue(JSON.stringify(['stale:cached']));
    const codes = await authorizationService.resolveUserOrganizationPermissionsFromDatabase(
      'user_public',
      'org_public',
    );
    expect(codes).toEqual(['organization:read', 'organization:manage']);
    expect(permissionRepository.findPermissionCodesForUserInOrganization).toHaveBeenCalled();
    expect(redisConnection.get).not.toHaveBeenCalled();
    expect(redisConnection.set).not.toHaveBeenCalled();
  });
});
