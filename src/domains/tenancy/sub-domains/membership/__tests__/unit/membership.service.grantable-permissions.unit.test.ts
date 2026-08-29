import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/domains/tenancy/sub-domains/permission/permission-cache.service.js', () => ({
  invalidatePermissions: vi.fn().mockResolvedValue(undefined),
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

import { ForbiddenError } from '@/shared/errors/index.js';
import { MembershipService } from '@/domains/tenancy/sub-domains/membership/membership.service.js';
import { assertCallerCanGrantPermissionCodes } from '@/domains/tenancy/sub-domains/permission/assert-grantable-permissions.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { MemberRoleService } from '@/domains/tenancy/sub-domains/member-roles/member-role.service.js';
import type { MemberRolePermissionService } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.service.js';
import type { MembershipRepository } from '@/domains/tenancy/sub-domains/membership/membership.repository.js';
import type { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import type { PermissionRepository } from '@/domains/tenancy/sub-domains/permission/permission.repository.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { MemberInvitationService } from '@/domains/tenancy/sub-domains/membership/member-invitation/member-invitation.service.js';
import {
  PRINCIPAL_SCOPE,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

/**
 * Regression for the Critical org-takeover finding (T1).
 *
 * A `MEMBERSHIP_MANAGE` + `INVITATION_MANAGE` holder must not be able to mint an Admin (or
 * any other privileged-role) membership for a throwaway account that the caller does not
 * themselves have the right to grant. `MembershipService.create` must invoke
 * `assertCallerCanGrantPermissionCodes` against the resolved role's permission codes
 * BEFORE the membership row is persisted.
 */
const asScope = (organizationPublicId: string) =>
  PRINCIPAL_SCOPE.REQUEST({
    organizationPublicId,
  }) as OrganizationPrincipalDatabaseScope;

describe('MembershipService.create — grantable-permissions guard (sec-T1)', () => {
  const organization = { id: 1, public_id: 'org_public', owner_user_id: 99 };
  const adminRole = { id: 2, public_id: 'role_public_admin', name: 'Admin' };
  const adminPermissionCodes = ['organization:delete', 'role:manage', 'subscription:manage'];

  const membershipRow = {
    id: 3,
    public_id: 'mem_public',
    organization_id: 1,
    user_id: 10,
    role_id: 2,
    status: 'INVITED' as const,
    joined_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const organizationService = {
    requireOrganizationRecordByPublicId: vi.fn().mockResolvedValue(organization),
    resolveUserInternalIdByPublicId: vi.fn().mockResolvedValue(10),
    resolveUserPublicIdByInternalId: vi.fn().mockResolvedValue('user_public'),
  } as unknown as OrganizationService;

  const memberRoleService = {
    requireRoleRecordByPublicId: vi.fn().mockResolvedValue(adminRole),
    resolveRolePublicIdByInternalId: vi.fn().mockResolvedValue('role_public_admin'),
  } as unknown as MemberRoleService;

  const memberRolePermissionService = {
    listPermissionCodesForRole: vi.fn().mockResolvedValue(adminPermissionCodes),
  } as unknown as MemberRolePermissionService;

  const membershipRepository = {
    create: vi.fn().mockResolvedValue(membershipRow),
    resolveUserSummariesByInternalIds: vi.fn(
      async (ids: readonly number[]) =>
        new Map(
          ids.map((id) => [
            id,
            {
              public_id: `user_public_${id}`,
              email: `user${id}@example.com`,
              first_name: 'Test',
              last_name: `User${id}`,
              avatar_url: null,
            },
          ]),
        ),
    ),
    resolveRoleSummariesByInternalIds: vi.fn(
      async (ids: readonly number[]) =>
        new Map(ids.map((id) => [id, { public_id: `role_public_${id}`, name: 'Admin' }])),
    ),
    resolveLiveInvitationsByMembershipIds: vi.fn(async () => new Map()),
  } as unknown as MembershipRepository;

  const authorizationService = {
    resolveUserOrganizationPermissions: vi.fn().mockResolvedValue([]),
  } as unknown as AuthorizationService;

  const permissionRepository = {
    findAll: vi.fn().mockResolvedValue([]),
  } as unknown as PermissionRepository;

  const userService = {
    findOrCreateInvitedByEmail: vi.fn().mockResolvedValue({
      id: 10,
      public_id: 'user_public',
      email: 'invitee@example.com',
    }),
  } as unknown as UserService;

  const memberInvitationService = {
    createForMembership: vi.fn().mockResolvedValue({ id: 'inv_public' }),
  } as unknown as MemberInvitationService;

  const service = new MembershipService(
    organizationService,
    memberRoleService,
    memberRolePermissionService,
    membershipRepository,
    authorizationService,
    permissionRepository,
    undefined,
    undefined,
    undefined,
    undefined,
    userService,
    memberInvitationService,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockResolvedValue(
      organization as never,
    );
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(10);
    vi.mocked(memberRoleService.requireRoleRecordByPublicId).mockResolvedValue(adminRole as never);
    vi.mocked(memberRolePermissionService.listPermissionCodesForRole).mockResolvedValue(
      adminPermissionCodes,
    );
    vi.mocked(membershipRepository.create).mockResolvedValue(membershipRow as never);
    vi.mocked(assertCallerCanGrantPermissionCodes).mockResolvedValue(undefined);
  });

  it('invokes assertCallerCanGrantPermissionCodes with the target role permission codes BEFORE persisting', async () => {
    const persistOrder: string[] = [];
    vi.mocked(assertCallerCanGrantPermissionCodes).mockImplementation(async () => {
      persistOrder.push('guard');
    });
    vi.mocked(membershipRepository.create).mockImplementation(async () => {
      persistOrder.push('create');
      return membershipRow as never;
    });

    await service.create(
      asScope('org_public'),
      { email: 'invitee@example.com', role_id: 'role_public_admin' },
      'inviter_public',
    );

    expect(memberRolePermissionService.listPermissionCodesForRole).toHaveBeenCalledWith(
      adminRole.id,
    );
    expect(assertCallerCanGrantPermissionCodes).toHaveBeenCalledWith(
      expect.objectContaining({
        callerUserPublicId: 'inviter_public',
        organizationPublicId: 'org_public',
        requestedPermissionCodes: adminPermissionCodes,
      }),
    );
    expect(persistOrder).toEqual(['guard', 'create']);
  });

  it('refuses to persist when caller cannot grant the target role permission codes', async () => {
    vi.mocked(assertCallerCanGrantPermissionCodes).mockRejectedValueOnce(
      new ForbiddenError('errors:cannotGrantPermissionNotHeld'),
    );

    await expect(
      service.create(
        asScope('org_public'),
        { email: 'invitee@example.com', role_id: 'role_public_admin' },
        'inviter_public',
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(membershipRepository.create).not.toHaveBeenCalled();
  });

  it('propagates the caller principal even when undefined (anonymous principal → guard fails closed)', async () => {
    vi.mocked(assertCallerCanGrantPermissionCodes).mockRejectedValueOnce(
      new ForbiddenError('errors:cannotGrantPermissionNotHeld'),
    );

    await expect(
      service.create(
        asScope('org_public'),
        { email: 'invitee@example.com', role_id: 'role_public_admin' },
        undefined,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(assertCallerCanGrantPermissionCodes).toHaveBeenCalledWith(
      expect.objectContaining({ callerUserPublicId: undefined }),
    );
    expect(membershipRepository.create).not.toHaveBeenCalled();
  });
});
