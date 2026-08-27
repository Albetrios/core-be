import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/infrastructure/database/contexts/organization-database.context.js', () => ({
  withOrganizationDatabaseContext: vi.fn(
    async (_organizationPublicId: string, callback: () => Promise<unknown>) => callback(),
  ),
}));

vi.mock('@/domains/tenancy/sub-domains/permission/permission-cache.service.js', () => ({
  invalidateOrganizationPermissions: vi.fn().mockResolvedValue(undefined),
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

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/shared/errors/index.js';
import { invalidateOrganizationPermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import { MemberRoleService } from '@/domains/tenancy/sub-domains/member-roles/member-role.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { MemberRoleRepository } from '@/domains/tenancy/sub-domains/member-roles/member-role.repository.js';
import type { MemberRolePermissionRepository } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.repository.js';
import type { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import type { PermissionRepository } from '@/domains/tenancy/sub-domains/permission/permission.repository.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';

const organization = { id: 1, public_id: generatePublicId('memberRole') };
const roleRow = {
  id: 2,
  public_id: generatePublicId('memberRole'),
  organization_id: 1,
  name: 'Admin',
  description: 'Admin role',
  is_system: false,
  created_at: new Date(),
  updated_at: new Date(),
};

const asScope = (organizationPublicId: string) =>
  createPrincipalDatabaseScope({
    organizationPublicId,
    source: 'token',
  }) as OrganizationPrincipalDatabaseScope;

describe('MemberRoleService', () => {
  const organizationService = {
    requireOrganizationRecordByPublicId: vi.fn().mockResolvedValue(organization),
    resolveUserInternalIdByPublicId: vi.fn().mockResolvedValue(5),
  } as unknown as OrganizationService;

  const memberRoleRepository = {
    findByOrganizationId: vi
      .fn()
      .mockResolvedValue({ items: [roleRow], has_more: false, next_cursor: null }),
    findByPublicId: vi.fn().mockResolvedValue(roleRow),
    findByInternalId: vi.fn().mockResolvedValue(roleRow),
    // sec-r5-followup-ratelimit-dos-2: create() now consults this guard
    // before insert. Default to 0 so the lifecycle tests still reach create;
    // the cap regression lives in `per-org-row-caps.unit.test.ts`.
    countActiveByOrganization: vi.fn().mockResolvedValue(0),
    // audit-#8: per-org creation quota advisory lock (no-op in unit tests).
    acquireCreationQuotaLock: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(roleRow),
    update: vi.fn().mockResolvedValue(roleRow),
    softDeleteIfNoActiveMembers: vi.fn().mockResolvedValue(roleRow),
    // member_count projection: aggregate for the list, single count for get/update.
    countMembersByRoleForOrganization: vi.fn().mockResolvedValue(new Map<number, number>()),
    countMembersForRole: vi.fn().mockResolvedValue(0),
  } as unknown as MemberRoleRepository;

  const memberRolePermissionRepository = {
    replace: vi.fn().mockResolvedValue([]),
  } as unknown as MemberRolePermissionRepository;

  const authorizationService = {
    resolveUserOrganizationPermissionsFromDatabase: vi.fn().mockResolvedValue([]),
  } as unknown as AuthorizationService;

  const permissionRepository = {
    findAll: vi.fn().mockResolvedValue([]),
  } as unknown as PermissionRepository;

  const service = new MemberRoleService(
    organizationService,
    memberRoleRepository,
    memberRolePermissionRepository,
    authorizationService,
    permissionRepository,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockResolvedValue(
      organization as never,
    );
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(5);
    vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(roleRow as never);
    vi.mocked(memberRoleRepository.findByInternalId).mockResolvedValue(roleRow as never);
    vi.mocked(memberRoleRepository.update).mockResolvedValue(roleRow as never);
    vi.mocked(memberRoleRepository.softDeleteIfNoActiveMembers).mockResolvedValue(roleRow as never);
    vi.mocked(memberRoleRepository.create).mockResolvedValue(roleRow as never);
    vi.mocked(memberRoleRepository.countMembersByRoleForOrganization).mockResolvedValue(new Map());
    vi.mocked(memberRoleRepository.countMembersForRole).mockResolvedValue(0);
  });

  it('list returns roles', async () => {
    const result = await service.list(asScope(organization.public_id), { limit: 20, order: 'asc' });
    expect(result.items).toHaveLength(1);
  });

  it('list attaches member_count per role from the single aggregate (no N+1)', async () => {
    vi.mocked(memberRoleRepository.countMembersByRoleForOrganization).mockResolvedValue(
      new Map([[roleRow.id, 4]]),
    );
    const result = await service.list(asScope(organization.public_id), { limit: 20, order: 'asc' });
    expect(result.items[0]).toMatchObject({ id: roleRow.public_id, member_count: 4 });
    // One grouped query for the whole page — never the per-role count.
    expect(memberRoleRepository.countMembersByRoleForOrganization).toHaveBeenCalledTimes(1);
    expect(memberRoleRepository.countMembersForRole).not.toHaveBeenCalled();
  });

  it('list defaults member_count to 0 for a role absent from the aggregate', async () => {
    vi.mocked(memberRoleRepository.countMembersByRoleForOrganization).mockResolvedValue(new Map());
    const result = await service.list(asScope(organization.public_id), { limit: 20, order: 'asc' });
    expect(result.items[0]!.member_count).toBe(0);
  });

  it('getByPublicId includes member_count from the single-role count', async () => {
    vi.mocked(memberRoleRepository.countMembersForRole).mockResolvedValue(2);
    const result = await service.getByPublicId(asScope(organization.public_id), roleRow.public_id);
    expect(result).toMatchObject({ id: roleRow.public_id, member_count: 2 });
  });

  it('create returns member_count 0 for the brand-new role without an aggregate query', async () => {
    const result = await service.create(
      asScope(organization.public_id),
      { name: 'Editor' },
      'creator_public',
    );
    expect(result.member_count).toBe(0);
    expect(memberRoleRepository.countMembersForRole).not.toHaveBeenCalled();
    expect(memberRoleRepository.countMembersByRoleForOrganization).not.toHaveBeenCalled();
  });

  it('update returns the refreshed member_count for the updated role', async () => {
    vi.mocked(memberRoleRepository.countMembersForRole).mockResolvedValue(5);
    const result = await service.update(
      asScope(organization.public_id),
      roleRow.public_id,
      { name: 'Updated' },
      'updater_public',
    );
    expect(result).toMatchObject({ id: roleRow.public_id, member_count: 5 });
  });

  it('getByPublicId returns role', async () => {
    const result = await service.getByPublicId(asScope(organization.public_id), roleRow.public_id);
    expect(result.id).toBe(roleRow.public_id);
  });

  it('create throws when organization is missing', async () => {
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockRejectedValue(
      new NotFoundError('Organization'),
    );
    await expect(
      service.create(asScope(organization.public_id), { name: 'Editor' }, 'creator_public'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('create adds role', async () => {
    await service.create(
      asScope(organization.public_id),
      { name: 'Editor', description: 'Can edit' },
      'creator_public',
    );
    expect(memberRoleRepository.create).toHaveBeenCalled();
  });

  it('create rejects a PERSONAL organization (no custom roles without members)', async () => {
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockResolvedValueOnce({
      ...organization,
      type: 'PERSONAL',
    } as never);
    await expect(
      service.create(asScope(organization.public_id), { name: 'Editor' }, 'creator_public'),
    ).rejects.toMatchObject({ messageKey: 'errors:personalOrganizationNoRoles' });
    expect(memberRoleRepository.create).not.toHaveBeenCalled();
  });

  it('create omits optional description and is_system defaults', async () => {
    await service.create(asScope(organization.public_id), { name: 'Minimal' }, 'creator_public');
    expect(memberRoleRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Minimal' }),
    );
  });

  it('create assigns an initial permission set when the caller holds every code', async () => {
    vi.mocked(permissionRepository.findAll).mockResolvedValue([
      { code: 'organization:read' },
    ] as never);
    vi.mocked(
      authorizationService.resolveUserOrganizationPermissionsFromDatabase,
    ).mockResolvedValue(['organization:read']);

    await service.create(
      asScope(organization.public_id),
      { name: 'Editor', permission_codes: ['organization:read'] },
      'creator_public',
    );

    expect(memberRoleRepository.create).toHaveBeenCalled();
    expect(memberRolePermissionRepository.replace).toHaveBeenCalledWith(
      roleRow.id,
      ['organization:read'],
      5,
    );
  });

  it('create rejects permission_codes the caller does not hold and creates no role (atomic)', async () => {
    vi.mocked(permissionRepository.findAll).mockResolvedValue([
      { code: 'subscription:manage' },
    ] as never);
    // Caller holds nothing → may not grant subscription:manage.
    vi.mocked(
      authorizationService.resolveUserOrganizationPermissionsFromDatabase,
    ).mockResolvedValue([]);

    await expect(
      service.create(
        asScope(organization.public_id),
        { name: 'Escalate', permission_codes: ['subscription:manage'] },
        'creator_public',
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // The guard runs BEFORE the insert, so neither the role nor its grants are written.
    expect(memberRoleRepository.create).not.toHaveBeenCalled();
    expect(memberRolePermissionRepository.replace).not.toHaveBeenCalled();
  });

  it('requireRoleRecordByPublicId returns role row', async () => {
    const record = await service.requireRoleRecordByPublicId(
      organization.public_id,
      roleRow.public_id,
    );
    expect(record.public_id).toBe(roleRow.public_id);
  });

  it('requireRoleRecordForOrganization skips organization lookup', async () => {
    const record = await service.requireRoleRecordForOrganization(
      organization.id,
      roleRow.public_id,
    );
    expect(record.public_id).toBe(roleRow.public_id);
    expect(organizationService.requireOrganizationRecordByPublicId).not.toHaveBeenCalled();
  });

  it('resolveRolePublicIdForOrganization skips organization lookup', async () => {
    const publicId = await service.resolveRolePublicIdForOrganization(organization.id, roleRow.id);
    expect(publicId).toBe(roleRow.public_id);
    expect(organizationService.requireOrganizationRecordByPublicId).not.toHaveBeenCalled();
  });

  it('resolveRolePublicIdForOrganization throws when role is missing', async () => {
    vi.mocked(memberRoleRepository.findByInternalId).mockResolvedValue(null);
    await expect(
      service.resolveRolePublicIdForOrganization(organization.id, 999),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('resolveRolePublicIdByInternalId resolves via organization membership', async () => {
    const publicId = await service.resolveRolePublicIdByInternalId(
      organization.public_id,
      roleRow.id,
    );
    expect(publicId).toBe(roleRow.public_id);
    expect(organizationService.requireOrganizationRecordByPublicId).toHaveBeenCalled();
  });

  it('update and delete mutate role', async () => {
    await service.update(
      asScope(organization.public_id),
      roleRow.public_id,
      { name: 'Updated' },
      'updater_public',
    );
    await service.delete(asScope(organization.public_id), roleRow.public_id);
    expect(memberRoleRepository.update).toHaveBeenCalled();
    expect(memberRoleRepository.softDeleteIfNoActiveMembers).toHaveBeenCalled();
  });

  it('delete invalidates the entire organization permission namespace', async () => {
    await service.delete(asScope(organization.public_id), roleRow.public_id);
    expect(invalidateOrganizationPermissions).toHaveBeenCalledWith(organization.public_id);
  });

  it('update does not invalidate the permission cache (no permission change)', async () => {
    await service.update(
      asScope(organization.public_id),
      roleRow.public_id,
      { name: 'X' },
      'updater',
    );
    expect(invalidateOrganizationPermissions).not.toHaveBeenCalled();
  });

  it('requireRoleRecordByPublicId throws when missing', async () => {
    vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(null);
    await expect(
      service.requireRoleRecordByPublicId(organization.public_id, 'missing'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('list throws when organization is missing', async () => {
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockRejectedValue(
      new NotFoundError('Organization'),
    );
    await expect(
      service.list(asScope(organization.public_id), { limit: 20, order: 'asc' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getByPublicId throws when role is missing', async () => {
    vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(null);
    await expect(
      service.getByPublicId(asScope(organization.public_id), roleRow.public_id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('update passes null updater when user id cannot be resolved', async () => {
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(null);
    await service.update(
      asScope(organization.public_id),
      roleRow.public_id,
      { name: 'X' },
      'missing',
    );
    expect(memberRoleRepository.update).toHaveBeenCalledWith(
      roleRow.public_id,
      organization.id,
      { name: 'X' },
      null,
    );
  });

  it('update throws when repository returns null', async () => {
    vi.mocked(memberRoleRepository.update).mockResolvedValue(null);
    await expect(
      service.update(asScope(organization.public_id), roleRow.public_id, { name: 'X' }, 'updater'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('delete throws Conflict when the guarded soft-delete matches no row (active members)', async () => {
    // route-audit C2: softDeleteIfNoActiveMembers returns null when active members remain (or a
    // concurrent delete), which the service surfaces as the actionable roleHasActiveMembers conflict.
    vi.mocked(memberRoleRepository.softDeleteIfNoActiveMembers).mockResolvedValue(null);
    await expect(
      service.delete(asScope(organization.public_id), roleRow.public_id),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('create rejects `is_system` from the client body (sec-T3: server-only flag)', async () => {
    // sec-T3 removed `is_system` from createMemberRoleDto; clients that still send it
    // get a ValidationError before the repository is touched.
    await expect(
      service.create(
        asScope(organization.public_id),
        { name: 'System', description: null, is_system: true },
        'missing_creator',
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(memberRoleRepository.create).not.toHaveBeenCalled();
  });

  it('create persists with null created_by_user_id when the creator id cannot be resolved', async () => {
    vi.mocked(organizationService.resolveUserInternalIdByPublicId).mockResolvedValue(null);
    await service.create(
      asScope(organization.public_id),
      { name: 'Custom', description: null },
      'missing_creator',
    );
    expect(memberRoleRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Custom', created_by_user_id: null }),
    );
    // sec-T3 also: the service no longer threads `is_system` through to the repo.
    const createPayload = vi.mocked(memberRoleRepository.create).mock.calls[0]![0];
    expect('is_system' in createPayload).toBe(false);
  });

  it('getByPublicId and requireRoleRecordByPublicId throw when organization is missing', async () => {
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockRejectedValue(
      new NotFoundError('Organization'),
    );
    await expect(
      service.getByPublicId(asScope(organization.public_id), roleRow.public_id),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.requireRoleRecordByPublicId(organization.public_id, roleRow.public_id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('update throws when role is missing', async () => {
    vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(null);
    await expect(
      service.update(asScope(organization.public_id), roleRow.public_id, { name: 'X' }, 'updater'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('delete throws when organization is missing', async () => {
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockRejectedValue(
      new NotFoundError('Organization'),
    );
    await expect(
      service.delete(asScope(organization.public_id), roleRow.public_id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
