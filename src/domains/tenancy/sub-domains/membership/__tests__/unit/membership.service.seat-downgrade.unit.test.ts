import { describe, it, expect, vi, beforeEach } from 'vitest';

const invalidatePermissionsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/domains/tenancy/sub-domains/permission/permission-cache.service.js', () => ({
  invalidatePermissions: invalidatePermissionsMock,
  invalidateOrganizationPermissions: vi.fn().mockResolvedValue(undefined),
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
    withPrincipalDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

import { MembershipService } from '@/domains/tenancy/sub-domains/membership/membership.service.js';
import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

/**
 * `suspendExcessActiveMembersToFitCeiling` (REQ-4 F2) is billing's post-downgrade entry point: when
 * a plan change lowers the seat ceiling below the live active-member count, it suspends the excess.
 * It had ZERO test references repo-wide. The load-bearing invariants — excess = used - ceiling, the
 * OWNER is never suspended (self-lockout), and each suspended member's permission cache is purged —
 * were entirely unasserted, so a bug could silently over/under-suspend or lock the owner out.
 */
const _asScope = (organizationPublicId: string) =>
  createPrincipalDatabaseScope({
    organizationPublicId,
    source: 'token',
  }) as OrganizationPrincipalDatabaseScope;

describe('MembershipService.suspendExcessActiveMembersToFitCeiling (F2 downgrade enforcement)', () => {
  const organizationRecord = { id: 1, public_id: 'org_public', owner_user_id: 99 };
  const requireOrganizationRecordByPublicId = vi.fn().mockResolvedValue(organizationRecord);
  const resolveUserPublicIdByInternalId = vi.fn(async (id: number) => `user_${id}`);
  const countActiveByOrganization = vi.fn();
  const suspendExcessActiveMembers = vi.fn();

  const organizationService = {
    requireOrganizationRecordByPublicId,
    resolveUserPublicIdByInternalId,
  } as never;
  const membershipRepository = {
    countActiveByOrganization,
    suspendExcessActiveMembers,
  } as never;

  // Only args 1 (organizationService) and 4 (membershipRepository) are exercised by this method;
  // the rest are required-but-unused here, so minimal stubs.
  const service = new MembershipService(
    organizationService,
    {} as never,
    {} as never,
    membershipRepository,
    {} as never,
    {} as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    requireOrganizationRecordByPublicId.mockResolvedValue(organizationRecord);
    resolveUserPublicIdByInternalId.mockImplementation(async (id: number) => `user_${id}`);
  });

  it('suspends exactly the excess active members, passes the owner so it is never suspended, and purges each one’s permission cache', async () => {
    countActiveByOrganization.mockResolvedValue(6);
    suspendExcessActiveMembers.mockResolvedValue([11, 12]);

    const suspendedCount = await service.suspendExcessActiveMembersToFitCeiling({
      organizationPublicId: 'org_public',
      ceiling: 4,
    });

    expect(suspendExcessActiveMembers).toHaveBeenCalledWith({
      organization_id: 1,
      owner_user_id: 99, // forwarded so the repository excludes the owner — no self-lockout
      suspend_count: 2, // excess = 6 active - 4 ceiling
    });
    expect(suspendedCount).toBe(2);
    // Post-commit: each suspended member's permission cache is purged so a concurrent recompute
    // cannot re-cache the pre-suspension permission set.
    expect(invalidatePermissionsMock).toHaveBeenCalledWith('user_11', 'org_public');
    expect(invalidatePermissionsMock).toHaveBeenCalledWith('user_12', 'org_public');
  });

  it('is a no-op when the active members already fit the ceiling (excess <= 0)', async () => {
    countActiveByOrganization.mockResolvedValue(4);

    const suspendedCount = await service.suspendExcessActiveMembersToFitCeiling({
      organizationPublicId: 'org_public',
      ceiling: 4,
    });

    expect(suspendExcessActiveMembers).not.toHaveBeenCalled();
    expect(invalidatePermissionsMock).not.toHaveBeenCalled();
    expect(suspendedCount).toBe(0);
  });
});
