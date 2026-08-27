import { describe, it, expect, vi } from 'vitest';
import { ConfigurationError } from '@/shared/errors/index.js';

vi.mock('@/infrastructure/cache/redis.client.js', () => ({
  redisConnection: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    scan: vi.fn(),
  },
}));

import {
  configureAuthorization,
  resolveUserOrganizationPermissions,
} from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import type { PermissionRepository } from '@/domains/tenancy/sub-domains/permission/permission.repository.js';

// The service paths under test run inside the real principal wrapper, which
// opens a `database.transaction()` — passthrough so no Postgres is needed
// (CI's unit/contract lanes run without a database service).
vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withPrincipalDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

/**
 * Mutation-guided coverage for the function-style authorization entry point and its
 * configuration guard. The existing `authorization.service.unit.test.ts` constructs an
 * `AuthorizationService` at module load, which pre-wires the module-level repository singleton —
 * so the unconfigured path and the standalone function export were never exercised (scoped Stryker
 * surfaced no-coverage/surviving mutants on the `getPermissionRepository` guard,
 * `configureAuthorization`, and `resolveUserOrganizationPermissions`). This file constructs nothing
 * at load, so the singleton starts null and these behaviours can be pinned.
 */
describe('authorization.service configuration + function-style export', () => {
  // Runs first, before configureAuthorization: the singleton is null, so the guard must fire.
  it('resolveUserOrganizationPermissions throws ConfigurationError before configuration', async () => {
    await expect(
      resolveUserOrganizationPermissions('user_public', 'org_public'),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('resolves via the function-style export once configureAuthorization has wired the repository', async () => {
    const repository = {
      findPermissionCodesForUserInOrganization: vi.fn().mockResolvedValue(['organization:read']),
    } as unknown as PermissionRepository;
    configureAuthorization(repository);
    vi.mocked(redisConnection.get).mockResolvedValue(null);
    vi.mocked(redisConnection.set).mockResolvedValue('OK');

    const codes = await resolveUserOrganizationPermissions('user_public', 'org_public');

    expect(codes).toEqual(['organization:read']);
    expect(repository.findPermissionCodesForUserInOrganization).toHaveBeenCalledTimes(1);
  });
});
