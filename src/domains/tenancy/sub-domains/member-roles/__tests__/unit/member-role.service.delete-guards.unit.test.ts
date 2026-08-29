import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError } from '@/shared/errors/index.js';

vi.mock('@/domains/tenancy/sub-domains/permission/permission-cache.service.js', () => ({
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
    withAppDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

import { MemberRoleService } from '@/domains/tenancy/sub-domains/member-roles/member-role.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { MemberRoleRepository } from '@/domains/tenancy/sub-domains/member-roles/member-role.repository.js';
import type { MemberRolePermissionRepository } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.repository.js';
import type { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import type { PermissionRepository } from '@/domains/tenancy/sub-domains/permission/permission.repository.js';
import { invalidateOrganizationPermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import {
  PRINCIPAL_SCOPE,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';

// These delete/update-guard tests never supply permission_codes, so the permission-side
// dependencies (added for atomic create-with-permissions) are never exercised — stub them.
const stubMemberRolePermissionRepository = {} as unknown as MemberRolePermissionRepository;
const stubAuthorizationService = {} as unknown as AuthorizationService;
const stubPermissionRepository = {} as unknown as PermissionRepository;

/**
 * Regression for sec-T3 (High): role-delete must refuse to silently strip every member
 * holding the role.
 *
 * Two guards:
 *   1. `is_system` guard — system roles (Admin, Member seeds) cannot be deleted.
 *   2. Active-membership guard — a role currently assigned to active members cannot be
 *      deleted (clients must reassign first); soft-deleting a role otherwise silently strips
 *      every member's permission set (the permission-resolution join filters
 *      `isNull(roles.deleted_at)`).
 *
 * route-audit C2: the active-membership check + the soft-delete now run in ONE statement
 * (`softDeleteIfNoActiveMembers` — a `NOT EXISTS` over memberships), so a concurrent
 * member-assignment can't slip between a separate count and the delete. A zero-row result means
 * active members remain → `ConflictError`.
 */
const asScope = (organizationPublicId: string) =>
  PRINCIPAL_SCOPE.REQUEST({
    organizationPublicId,
  }) as OrganizationPrincipalDatabaseScope;

describe('MemberRoleService.delete — sec-T3 guards (route-audit C2 atomic)', () => {
  const organization = { id: 1, public_id: 'org_public', owner_user_id: 99 };

  const systemRole = {
    id: 7,
    public_id: 'role_system',
    name: 'Admin',
    organization_id: organization.id,
    is_system: true,
    deleted_at: null,
  };

  const customRoleAssigned = {
    id: 8,
    public_id: 'role_custom_assigned',
    name: 'People-Ops',
    organization_id: organization.id,
    is_system: false,
    deleted_at: null,
  };

  const customRoleEmpty = {
    id: 9,
    public_id: 'role_custom_empty',
    name: 'Unused',
    organization_id: organization.id,
    is_system: false,
    deleted_at: null,
  };

  const organizationService = {
    requireOrganizationRecordByPublicId: vi.fn().mockResolvedValue(organization),
  } as unknown as OrganizationService;

  const memberRoleRepository = {
    findByPublicId: vi.fn(),
    softDeleteIfNoActiveMembers: vi.fn(),
  } as unknown as MemberRoleRepository;

  const service = new MemberRoleService(
    organizationService,
    memberRoleRepository,
    stubMemberRolePermissionRepository,
    stubAuthorizationService,
    stubPermissionRepository,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(organizationService.requireOrganizationRecordByPublicId).mockResolvedValue(
      organization as never,
    );
    // Default: the guarded delete succeeds (no active members).
    vi.mocked(memberRoleRepository.softDeleteIfNoActiveMembers).mockImplementation(
      async (publicId) => ({ public_id: publicId, organization_id: organization.id }) as never,
    );
  });

  it('refuses to delete a system role with ForbiddenError (is_system guard fires first)', async () => {
    vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(systemRole as never);

    await expect(
      service.delete(asScope('org_public'), systemRole.public_id),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(memberRoleRepository.softDeleteIfNoActiveMembers).not.toHaveBeenCalled();
    expect(invalidateOrganizationPermissions).not.toHaveBeenCalled();
  });

  it('refuses to delete a non-system role that has active members (ConflictError)', async () => {
    vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(customRoleAssigned as never);
    // Atomic guard matches zero rows because active members remain.
    vi.mocked(memberRoleRepository.softDeleteIfNoActiveMembers).mockResolvedValue(null as never);

    await expect(
      service.delete(asScope('org_public'), customRoleAssigned.public_id),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(invalidateOrganizationPermissions).not.toHaveBeenCalled();
  });

  it('allows deletion of an unused non-system role (control case — happy path)', async () => {
    vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(customRoleEmpty as never);

    await expect(
      service.delete(asScope('org_public'), customRoleEmpty.public_id),
    ).resolves.toBeUndefined();

    expect(memberRoleRepository.softDeleteIfNoActiveMembers).toHaveBeenCalledWith(
      customRoleEmpty.public_id,
      organization.id,
    );
    expect(invalidateOrganizationPermissions).toHaveBeenCalledWith('org_public');
  });

  it('throws NotFoundError when the role does not exist (guarded delete is skipped)', async () => {
    vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue(null);

    await expect(service.delete(asScope('org_public'), 'role_missing')).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(memberRoleRepository.softDeleteIfNoActiveMembers).not.toHaveBeenCalled();
  });
});

/**
 * Regression for sec-T3 (High): update must refuse to mutate system roles.
 *
 * The delete-guard was added first; this extends the same invariant to PATCH so
 * that tenants cannot rename Admin/Member to mask or shadow the seed identity,
 * which would defeat the is_system check used by the delete guard itself.
 */
describe('MemberRoleService.update — sec-T3 is_system guard', () => {
  const organization = { id: 1, public_id: 'org_public', owner_user_id: 99 };

  const systemRole = {
    id: 7,
    public_id: 'role_system',
    name: 'Admin',
    organization_id: organization.id,
    is_system: true,
    deleted_at: null,
  };

  const now = new Date('2026-01-01T00:00:00.000Z');

  const customRole = {
    id: 10,
    public_id: 'role_custom',
    name: 'People-Ops',
    description: null,
    organization_id: organization.id,
    is_system: false,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };

  const orgServiceForUpdate = {
    requireOrganizationRecordByPublicId: vi.fn().mockResolvedValue(organization),
    resolveUserInternalIdByPublicId: vi.fn().mockResolvedValue(null),
  } as unknown as OrganizationService;

  const roleRepoForUpdate = {
    findByPublicId: vi.fn(),
    update: vi.fn(),
    // update() now projects member_count via a single-role count after the write.
    countMembersForRole: vi.fn().mockResolvedValue(0),
  } as unknown as MemberRoleRepository;

  const updateService = new MemberRoleService(
    orgServiceForUpdate,
    roleRepoForUpdate,
    stubMemberRolePermissionRepository,
    stubAuthorizationService,
    stubPermissionRepository,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(orgServiceForUpdate.requireOrganizationRecordByPublicId).mockResolvedValue(
      organization as never,
    );
  });

  it('refuses to update a system role with ForbiddenError', async () => {
    vi.mocked(roleRepoForUpdate.findByPublicId).mockResolvedValue(systemRole as never);

    await expect(
      updateService.update(
        asScope('org_public'),
        systemRole.public_id,
        { name: 'Hacked' },
        undefined,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(roleRepoForUpdate.update).not.toHaveBeenCalled();
  });

  it('allows updating a non-system role (happy path)', async () => {
    const updatedRole = { ...customRole, name: 'Renamed', updated_at: now };
    vi.mocked(roleRepoForUpdate.findByPublicId).mockResolvedValue(customRole as never);
    vi.mocked(roleRepoForUpdate.update).mockResolvedValue(updatedRole as never);

    await expect(
      updateService.update(
        asScope('org_public'),
        customRole.public_id,
        { name: 'Renamed' },
        undefined,
      ),
    ).resolves.toBeDefined();

    expect(roleRepoForUpdate.update).toHaveBeenCalled();
  });
});
