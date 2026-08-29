import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/domains/tenancy/sub-domains/permission/permission-cache.service.js', () => ({
  invalidatePermissions: vi.fn().mockResolvedValue(undefined),
  invalidateOrganizationPermissions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/domains/tenancy/sub-domains/permission/assert-grantable-permissions.util.js', () => ({
  assertCallerCanGrantPermissionCodes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/shared/utils/text/email.util.js', () => ({
  isDisposableEmailBlocked: vi.fn().mockReturnValue(false),
}));

// The seat-availability check acquires a per-organization advisory lock (real DB in production). Mock only
// the lock (keep RESOURCE_QUOTA_LOCK_NAMESPACE) so the seat logic runs without a live connection.
vi.mock('@/infrastructure/database/resource-quota-lock.util.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/infrastructure/database/resource-quota-lock.util.js')
  >()),
  acquireResourceQuotaLock: vi.fn().mockResolvedValue(undefined),
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
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/shared/errors/index.js';
import { MembershipService } from '@/domains/tenancy/sub-domains/membership/membership.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { MemberRoleService } from '@/domains/tenancy/sub-domains/member-roles/member-role.service.js';
import type { MemberRolePermissionService } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.service.js';
import type { MembershipRepository } from '@/domains/tenancy/sub-domains/membership/membership.repository.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { MemberInvitationService } from '@/domains/tenancy/sub-domains/membership/member-invitation/member-invitation.service.js';
import { invalidatePermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import { isDisposableEmailBlocked } from '@/shared/utils/text/email.util.js';
import {
  PRINCIPAL_SCOPE,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

const organization = { id: 1, public_id: 'org_public', owner_user_id: 99 };
const role = { id: 2, public_id: 'role_public', name: 'Admin' };
const membershipRow = {
  id: 3,
  public_id: 'mem_public',
  organization_id: 1,
  user_id: 10,
  role_id: 2,
  status: 'ACTIVE',
  joined_at: new Date(),
  created_at: new Date(),
  updated_at: new Date(),
};

const asScope = (organizationPublicId: string) =>
  PRINCIPAL_SCOPE.REQUEST({
    organizationPublicId,
  }) as OrganizationPrincipalDatabaseScope;

describe('MembershipService', () => {
  const organizationService = {
    requireOrganizationRecordByPublicId: vi.fn().mockResolvedValue(organization),
    resolveUserInternalIdByPublicId: vi.fn().mockResolvedValue(10),
    resolveUserPublicIdByInternalId: vi.fn().mockResolvedValue('user_public'),
  } as unknown as OrganizationService;

  const memberRoleService = {
    requireRoleRecordByPublicId: vi.fn().mockResolvedValue(role),
    requireRoleRecordForOrganization: vi.fn().mockResolvedValue(role),
    resolveRolePublicIdByInternalId: vi.fn().mockResolvedValue('role_public'),
    resolveRolePublicIdForOrganization: vi.fn().mockResolvedValue('role_public'),
  } as unknown as MemberRoleService;

  const memberRolePermissionService = {
    listPermissionCodesForRole: vi.fn().mockResolvedValue(['organization:read']),
  } as unknown as MemberRolePermissionService;

  const membershipRepository = {
    findByOrganizationId: vi.fn().mockResolvedValue({
      items: [membershipRow],
      total: null,
      limit: 20,
      has_more: false,
      next_cursor: null,
    }),
    findByPublicId: vi.fn().mockResolvedValue(membershipRow),
    create: vi.fn().mockResolvedValue(membershipRow),
    update: vi.fn().mockResolvedValue(membershipRow),
    softDelete: vi.fn().mockResolvedValue(membershipRow),
    findByUserAndOrganization: vi.fn().mockResolvedValue(membershipRow),
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
    // REQ-4 seat enforcement: consulted only when the seat-enforcement port is wired.
    countActiveByOrganization: vi.fn().mockResolvedValue(0),
  } as unknown as MembershipRepository;

  const authorizationService = {
    resolveUserOrganizationPermissions: vi.fn().mockResolvedValue([]),
  } as never;
  const permissionRepository = {
    findAll: vi.fn().mockResolvedValue([]),
  } as never;

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
    vi.mocked(memberRoleService.resolveRolePublicIdForOrganization).mockResolvedValue(
      'role_public',
    );
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockResolvedValue(
      organization as never,
    );
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockReset();
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(10);
    vi.mocked(membershipRepository.findByPublicId).mockResolvedValue(membershipRow as never);
    vi.mocked(membershipRepository.findByUserAndOrganization).mockResolvedValue(
      membershipRow as never,
    );
    vi.mocked(membershipRepository.update).mockResolvedValue(membershipRow as never);
    vi.mocked(membershipRepository.softDelete).mockResolvedValue(membershipRow as never);
  });

  it('list returns paginated memberships', async () => {
    const result = await service.list(asScope('org_public'), { limit: 20 });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBeNull();
    expect(membershipRepository.findByOrganizationId).toHaveBeenCalledWith(1, {
      limit: 20,
    });
  });

  it('getByPublicId returns membership', async () => {
    const result = await service.getByPublicId(asScope('org_public'), 'mem_public');
    expect(result.id).toBe('mem_public');
  });

  it('getByPublicId throws when missing', async () => {
    vi.mocked(membershipRepository.findByPublicId).mockResolvedValue(null);
    await expect(service.getByPublicId(asScope('org_public'), 'missing')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('create adds an INVITED membership by email and issues the invitation', async () => {
    const result = await service.create(
      asScope('org_public'),
      { email: 'invitee@example.com', role_id: 'role_public' },
      'inviter_public',
    );
    expect(userService.findOrCreateInvitedByEmail).toHaveBeenCalledWith({
      email: 'invitee@example.com',
    });
    expect(memberRoleService.requireRoleRecordByPublicId).toHaveBeenCalledWith(
      'org_public',
      'role_public',
    );
    expect(membershipRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 10, role_id: 2, status: 'INVITED' }),
    );
    expect(memberInvitationService.createForMembership).toHaveBeenCalledWith(
      expect.objectContaining({ membership_id: 3, email: 'invitee@example.com' }),
    );
    expect(invalidatePermissions).toHaveBeenCalledWith('user_public', 'org_public');
    expect(result.id).toBe('mem_public');
  });

  it('create rejects a disposable invitee email before any provisioning or write', async () => {
    vi.mocked(isDisposableEmailBlocked).mockReturnValueOnce(true);
    await expect(
      service.create(
        asScope('org_public'),
        { email: 'throwaway@mailinator.com', role_id: 'role_public' },
        'inviter_public',
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(userService.findOrCreateInvitedByEmail).not.toHaveBeenCalled();
    expect(membershipRepository.create).not.toHaveBeenCalled();
  });

  it('create rejects a PERSONAL organization (single-member invariant; no side-door members)', async () => {
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockResolvedValueOnce({
      ...organization,
      type: 'PERSONAL',
    } as never);
    await expect(
      service.create(
        asScope('org_public'),
        { email: 'invitee@example.com', role_id: 'role_public' },
        'inviter_public',
      ),
    ).rejects.toMatchObject({ messageKey: 'errors:personalOrganizationNoMembers' });
    expect(membershipRepository.create).not.toHaveBeenCalled();
  });

  it('getPermissions throws when organization context is missing', async () => {
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockRejectedValueOnce(
      new NotFoundError('Organization'),
    );
    await expect(service.getPermissions(asScope('missing'), 'mem_public')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('getPermissions returns role permission codes', async () => {
    const result = await service.getPermissions(asScope('org_public'), 'mem_public');
    expect(result.permissions).toEqual(['organization:read']);
  });

  it('update changes membership status', async () => {
    await service.update(
      asScope('org_public'),
      'mem_public',
      { status: 'SUSPENDED' },
      'updater_public',
    );
    expect(membershipRepository.update).toHaveBeenCalled();
  });

  it('update changes a member role (REQ-3): resolves the role and persists its internal id', async () => {
    await service.update(
      asScope('org_public'),
      'mem_public',
      { role_id: 'role_public' },
      'updater_public',
    );
    expect(memberRoleService.requireRoleRecordByPublicId).toHaveBeenCalledWith(
      'org_public',
      'role_public',
    );
    // The privilege-escalation guard runs for the new role's permission codes before persisting.
    expect(memberRolePermissionService.listPermissionCodesForRole).toHaveBeenCalledWith(role.id);
    expect(membershipRepository.update).toHaveBeenCalledWith(
      'mem_public',
      organization.id,
      expect.objectContaining({ role_id: role.id }),
      expect.anything(),
    );
  });

  // sec-new-T1: owner membership cannot be modified (would enable Admin lockout of owner)
  it('update rejects any status change targeting the organization owner membership (sec-new-T1)', async () => {
    // membership.user_id matches organization.owner_user_id (99)
    vi.mocked(membershipRepository.findByPublicId).mockResolvedValue({
      ...membershipRow,
      user_id: 99,
    } as never);
    await expect(
      service.update(asScope('org_public'), 'owner_mem', { status: 'SUSPENDED' }, 'admin_public'),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Guard fires before any write
    expect(membershipRepository.update).not.toHaveBeenCalled();
  });

  it('update rejects ACTIVE status targeting the organization owner membership (sec-new-T1)', async () => {
    // Even a benign reactivation attempt on the owner is blocked — use transferOwnership.
    vi.mocked(membershipRepository.findByPublicId).mockResolvedValue({
      ...membershipRow,
      user_id: 99,
      status: 'SUSPENDED',
      joined_at: new Date(),
    } as never);
    await expect(
      service.update(asScope('org_public'), 'owner_mem', { status: 'ACTIVE' }, 'admin_public'),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(membershipRepository.update).not.toHaveBeenCalled();
  });

  it('update allows modifying a non-owner membership with matching user_id below owner', async () => {
    // Sanity: user_id:10 !== owner_user_id:99 — update proceeds normally
    await service.update(
      asScope('org_public'),
      'mem_public',
      { status: 'SUSPENDED' },
      'admin_public',
    );
    expect(membershipRepository.update).toHaveBeenCalled();
  });

  it('update rejects activating a never-joined (INVITED) membership via PATCH', async () => {
    vi.mocked(membershipRepository.findByPublicId).mockResolvedValue({
      ...membershipRow,
      status: 'INVITED',
      joined_at: null,
    } as never);
    await expect(
      service.update(asScope('org_public'), 'mem_public', { status: 'ACTIVE' }, 'updater_public'),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(membershipRepository.update).not.toHaveBeenCalled();
  });

  it('update allows reactivating a previously-joined membership (SUSPENDED -> ACTIVE)', async () => {
    vi.mocked(membershipRepository.findByPublicId).mockResolvedValue({
      ...membershipRow,
      status: 'SUSPENDED',
      joined_at: new Date(),
    } as never);
    await service.update(
      asScope('org_public'),
      'mem_public',
      { status: 'ACTIVE' },
      'updater_public',
    );
    expect(membershipRepository.update).toHaveBeenCalled();
  });

  describe('REQ-4 seat-cap enforcement (F1) — the suspend→add→reactivate bypass', () => {
    // The shared `service` has no seat-enforcement port wired (so its create/update tests skip the
    // check). Wire a LOCAL instance that reuses the same mocks so the check runs, without leaking
    // the wiring into the sibling tests above.
    const reserveSeatCeilingForMemberAdd = vi.fn();
    const enqueueSeatQuantitySync = vi.fn().mockResolvedValue(undefined);
    const seatEnforcedService = new MembershipService(
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
    seatEnforcedService.wireSeatEnforcement({
      reserveSeatCeilingForMemberAdd,
      enqueueSeatQuantitySync,
    });

    it('create blocks a new member when the organization is already at its plan seat ceiling', async () => {
      reserveSeatCeilingForMemberAdd.mockResolvedValue(3); // plan ceiling = 3
      vi.mocked(membershipRepository.countActiveByOrganization).mockResolvedValue(3); // already full

      await expect(
        seatEnforcedService.create(
          asScope('org_public'),
          { email: 'invitee@example.com', role_id: 'role_public' },
          'inviter_public',
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(membershipRepository.create).not.toHaveBeenCalled();
    });

    it('create consults the seat check and proceeds when the organization is under the ceiling', async () => {
      reserveSeatCeilingForMemberAdd.mockResolvedValue(5);
      vi.mocked(membershipRepository.countActiveByOrganization).mockResolvedValue(2);

      await seatEnforcedService.create(
        asScope('org_public'),
        { email: 'invitee@example.com', role_id: 'role_public' },
        'inviter_public',
      );

      expect(reserveSeatCeilingForMemberAdd).toHaveBeenCalledWith(organization.id);
      expect(membershipRepository.create).toHaveBeenCalled();
    });

    it('reactivating a SUSPENDED member re-runs the seat check and blocks at the ceiling (closes the suspend→add→reactivate bypass)', async () => {
      // The documented exploit: suspend a member (frees a seat) → add a new member into the slot →
      // reactivate the suspended one, overshooting the plan ceiling unbounded. SUSPENDED members are
      // not counted, so a SUSPENDED→ACTIVE transition MUST re-run the same seat availability check.
      vi.mocked(membershipRepository.findByPublicId).mockResolvedValue({
        ...membershipRow,
        status: 'SUSPENDED',
        joined_at: new Date(),
      } as never);
      reserveSeatCeilingForMemberAdd.mockResolvedValue(3);
      vi.mocked(membershipRepository.countActiveByOrganization).mockResolvedValue(3);

      await expect(
        seatEnforcedService.update(
          asScope('org_public'),
          'mem_public',
          { status: 'ACTIVE' },
          'updater_public',
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(membershipRepository.update).not.toHaveBeenCalled();
    });
  });

  it('delete soft-deletes membership', async () => {
    await service.delete(asScope('org_public'), 'mem_public');
    expect(membershipRepository.softDelete).toHaveBeenCalled();
  });

  it('leaveOrganization throws when user id cannot be resolved', async () => {
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(null);
    await expect(
      service.leaveOrganization(asScope('org_public'), 'missing_user'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('update throws when membership is missing', async () => {
    vi.mocked(membershipRepository.findByPublicId).mockResolvedValue(null);
    await expect(
      service.update(asScope('org_public'), 'missing', { status: 'ACTIVE' }, 'updater_public'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('leaveOrganization forbids organization owner', async () => {
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(99);
    await expect(
      service.leaveOrganization(asScope('org_public'), 'owner_public'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('leaveOrganization soft-deletes non-owner membership', async () => {
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(10);
    await service.leaveOrganization(asScope('org_public'), 'member_public');
    expect(membershipRepository.softDelete).toHaveBeenCalled();
  });

  it('transferOwnership requires current owner and updates organization owner', async () => {
    const transferOrganizationOwnership = vi.fn().mockResolvedValue(undefined);
    const organizationServiceWithTransfer = {
      ...organizationService,
      requireOrganizationRecordByPublicId: vi.fn().mockResolvedValue({
        ...organization,
        owner_user_id: 99,
      }),
      resolveUserInternalIdByPublicId: vi
        .fn()
        .mockImplementation(async (publicId: string | undefined) => {
          if (publicId === 'owner_public') return 99;
          if (publicId === 'new_owner_public') return 10;
          return null;
        }),
      transferOrganizationOwnership,
    } as unknown as OrganizationService;

    const transferService = new MembershipService(
      organizationServiceWithTransfer,
      memberRoleService,
      memberRolePermissionService,
      membershipRepository,
      authorizationService,
      permissionRepository,
    );

    await transferService.transferOwnership(
      asScope('org_public'),
      { new_owner_user_id: 'new_owner_public' },
      'owner_public',
    );
    expect(transferOrganizationOwnership).toHaveBeenCalled();
  });

  it('transferOwnership rejects non-owner caller', async () => {
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(10);
    await expect(
      service.transferOwnership(
        asScope('org_public'),
        { new_owner_user_id: 'other_public' },
        'not_owner_public',
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('update passes null updater when user id cannot be resolved', async () => {
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockImplementation(
      async (publicId: string | undefined) => (publicId === 'missing_updater' ? null : 10),
    );
    await service.update(
      asScope('org_public'),
      'mem_public',
      { status: 'SUSPENDED' },
      'missing_updater',
    );
    expect(membershipRepository.update).toHaveBeenCalledWith(
      'mem_public',
      organization.id,
      { status: 'SUSPENDED' },
      null,
    );
  });

  it('update throws when repository update returns null', async () => {
    vi.mocked(membershipRepository.update).mockResolvedValue(null);
    await expect(
      service.update(asScope('org_public'), 'mem_public', { status: 'ACTIVE' }, 'updater_public'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('delete throws when soft delete returns null', async () => {
    vi.mocked(membershipRepository.softDelete).mockResolvedValue(null);
    await expect(service.delete(asScope('org_public'), 'mem_public')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('leaveOrganization throws when membership is missing', async () => {
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(10);
    vi.mocked(membershipRepository.findByUserAndOrganization).mockResolvedValue(null);
    await expect(
      service.leaveOrganization(asScope('org_public'), 'member_public'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('create throws NotFoundError when the inviter cannot be resolved', async () => {
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(null);
    await expect(
      service.create(
        asScope('org_public'),
        { email: 'invitee@example.com', role_id: 'role_public' },
        'inviter_public',
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('leaveOrganization throws when soft delete returns null', async () => {
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(10);
    vi.mocked(membershipRepository.softDelete).mockResolvedValue(null);
    await expect(
      service.leaveOrganization(asScope('org_public'), 'member_public'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getPermissions throws when membership is missing', async () => {
    vi.mocked(membershipRepository.findByPublicId).mockResolvedValue(null);
    await expect(service.getPermissions(asScope('org_public'), 'missing')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('delete throws when soft delete returns null', async () => {
    vi.mocked(membershipRepository.softDelete).mockResolvedValue(null);
    await expect(service.delete(asScope('org_public'), 'mem_public')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('transferOwnership throws when current user cannot be resolved', async () => {
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockResolvedValue({
      ...organization,
      owner_user_id: 99,
    } as never);
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(null);
    await expect(
      service.transferOwnership(
        asScope('org_public'),
        { new_owner_user_id: 'new_owner_public' },
        'owner_public',
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('transferOwnership throws when new owner user cannot be resolved', async () => {
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockResolvedValue({
      ...organization,
      owner_user_id: 99,
    } as never);
    vi.mocked(organizationService.resolveUserInternalIdByPublicId)
      .mockResolvedValueOnce(99)
      .mockResolvedValueOnce(null);
    await expect(
      service.transferOwnership(
        asScope('org_public'),
        { new_owner_user_id: 'missing_user' },
        'owner_public',
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('transferOwnership requires new owner membership', async () => {
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockResolvedValue({
      ...organization,
      owner_user_id: 99,
    } as never);
    vi.mocked(organizationService.resolveUserInternalIdByPublicId)
      .mockResolvedValueOnce(99)
      .mockResolvedValueOnce(10);
    vi.mocked(membershipRepository.findByUserAndOrganization).mockResolvedValue(null);
    await expect(
      service.transferOwnership(
        asScope('org_public'),
        { new_owner_user_id: 'new_owner_public' },
        'owner_public',
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
