import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError, NotFoundError } from '@/shared/errors/index.js';

vi.mock('@/domains/tenancy/sub-domains/permission/permission-cache.service.js', () => ({
  invalidateOrganizationPermissions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/domains/tenancy/sub-domains/permission/assert-grantable-permissions.util.js', () => ({
  assertCallerCanGrantPermissionCodes: vi.fn().mockResolvedValue(undefined),
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

import { MemberRolePermissionService } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.service.js';
import type { OrganizationRepository } from '@/domains/tenancy/sub-domains/organization/organization.repository.js';
import type { MemberRoleRepository } from '@/domains/tenancy/sub-domains/member-roles/member-role.repository.js';
import type { MemberRolePermissionRepository } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.repository.js';
import type { MembershipRepository } from '@/domains/tenancy/sub-domains/membership/membership.repository.js';
import { invalidateOrganizationPermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import {
  PRINCIPAL_SCOPE,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

/**
 * Regression for sec-T2 (High): a holder of `ROLE_MANAGE` must NOT be able to wipe (or modify)
 * the permission set on the role currently assigned to the organization's owner. Such a write
 * would strip every permission for everyone holding that role — including the owner —
 * locking them out of every PERM-gated route until `/transfer-ownership` is invoked.
 *
 * The defense-in-depth fix is at the PUT-service layer (the audit's recommended location):
 * resolve `organization.owner_user_id` → owner's active membership → owner's role; if it
 * matches the target role, refuse with 403.
 */
const asScope = (organizationPublicId: string) =>
  PRINCIPAL_SCOPE.REQUEST({
    organizationPublicId,
  }) as OrganizationPrincipalDatabaseScope;

describe('MemberRolePermissionService.put — owner-role protection (sec-T2)', () => {
  const ownerRole = { id: 7, public_id: 'role_owner', name: 'Admin' };
  const nonOwnerRole = { id: 8, public_id: 'role_member', name: 'Member' };

  const organization = {
    id: 1,
    public_id: 'org_public',
    owner_user_id: 99,
  };

  const organizationRepository = {
    findByPublicId: vi.fn().mockResolvedValue(organization),
    resolveUserIdByPublicId: vi.fn().mockResolvedValue(99),
  } as unknown as OrganizationRepository;

  const memberRoleRepository = {
    findByPublicId: vi.fn(),
  } as unknown as MemberRoleRepository;

  const memberRolePermissionRepository = {
    replace: vi.fn().mockResolvedValue([{ permission_code: 'tenancy:read' }]),
    findByRoleId: vi.fn().mockResolvedValue([]),
  } as unknown as MemberRolePermissionRepository;

  const membershipRepository = {
    findByUserAndOrganization: vi.fn(),
  } as unknown as MembershipRepository;

  const authorizationService = {
    resolveUserOrganizationPermissions: vi.fn().mockResolvedValue([]),
  };
  const permissionRepository = { findAll: vi.fn().mockResolvedValue([]) };

  const service = new MemberRolePermissionService(
    organizationRepository,
    memberRoleRepository,
    memberRolePermissionRepository,
    authorizationService as never,
    permissionRepository as never,
    membershipRepository,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(organizationRepository.findByPublicId).mockResolvedValue(organization as never);
    vi.mocked(organizationRepository.resolveUserIdByPublicId).mockResolvedValue(99);
    vi.mocked(memberRolePermissionRepository.replace).mockResolvedValue([
      { permission_code: 'tenancy:read' },
    ] as never);
  });

  it('refuses to PUT permissions on the role currently assigned to the organization owner', async () => {
    vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(ownerRole as never);
    vi.mocked(membershipRepository.findByUserAndOrganization).mockResolvedValue({
      id: 42,
      public_id: 'mem_owner',
      user_id: organization.owner_user_id,
      organization_id: organization.id,
      role_id: ownerRole.id,
      status: 'ACTIVE',
    } as never);

    await expect(
      service.put(
        asScope('org_public'),
        ownerRole.public_id,
        { permission_codes: [] },
        'requester_public',
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(memberRolePermissionRepository.replace).not.toHaveBeenCalled();
    expect(invalidateOrganizationPermissions).not.toHaveBeenCalled();
  });

  it('refuses ANY PUT against the owner role, not only empty arrays (defense in depth)', async () => {
    vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(ownerRole as never);
    vi.mocked(membershipRepository.findByUserAndOrganization).mockResolvedValue({
      id: 42,
      public_id: 'mem_owner',
      user_id: organization.owner_user_id,
      organization_id: organization.id,
      role_id: ownerRole.id,
      status: 'ACTIVE',
    } as never);

    await expect(
      service.put(
        asScope('org_public'),
        ownerRole.public_id,
        { permission_codes: ['tenancy:read'] },
        'requester_public',
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(memberRolePermissionRepository.replace).not.toHaveBeenCalled();
  });

  it('allows PUT against a non-owner role (control case — normal flow still works)', async () => {
    vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(nonOwnerRole as never);
    vi.mocked(membershipRepository.findByUserAndOrganization).mockResolvedValue({
      id: 42,
      public_id: 'mem_owner',
      user_id: organization.owner_user_id,
      organization_id: organization.id,
      role_id: ownerRole.id,
      status: 'ACTIVE',
    } as never);

    const result = await service.put(
      asScope('org_public'),
      nonOwnerRole.public_id,
      { permission_codes: ['tenancy:read'] },
      'requester_public',
    );

    expect(memberRolePermissionRepository.replace).toHaveBeenCalledWith(
      nonOwnerRole.id,
      ['tenancy:read'],
      99,
    );
    expect(invalidateOrganizationPermissions).toHaveBeenCalledWith('org_public');
    expect(result).toEqual([{ permission_code: 'tenancy:read' }]);
  });

  it('throws NotFoundError when the owner has no active membership (data-integrity guard)', async () => {
    vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(ownerRole as never);
    vi.mocked(membershipRepository.findByUserAndOrganization).mockResolvedValue(null);

    await expect(
      service.put(
        asScope('org_public'),
        ownerRole.public_id,
        { permission_codes: ['tenancy:read'] },
        'requester_public',
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(memberRolePermissionRepository.replace).not.toHaveBeenCalled();
  });
});
