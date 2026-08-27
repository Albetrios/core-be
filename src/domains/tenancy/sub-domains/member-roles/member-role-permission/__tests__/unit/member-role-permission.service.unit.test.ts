import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from '@/shared/errors/index.js';

vi.mock('@/infrastructure/database/contexts/organization-database.context.js', () => ({
  withOrganizationDatabaseContext: vi.fn(
    async (_organizationPublicId: string, callback: () => Promise<unknown>) => callback(),
  ),
}));

vi.mock('@/domains/tenancy/sub-domains/permission/permission-cache.service.js', () => ({
  invalidateOrganizationPermissions: vi.fn().mockResolvedValue(undefined),
}));

// The grant-permission guard has its own dedicated unit tests; stub it to a no-op here so these
// tests isolate the service's own control flow, except where we assert it is invoked.
vi.mock('@/domains/tenancy/sub-domains/permission/assert-grantable-permissions.util.js', () => ({
  assertCallerCanGrantPermissionCodes: vi.fn().mockResolvedValue(undefined),
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

import { invalidateOrganizationPermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import { assertCallerCanGrantPermissionCodes } from '@/domains/tenancy/sub-domains/permission/assert-grantable-permissions.util.js';
import { MemberRolePermissionService } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.service.js';
import type { OrganizationRepository } from '@/domains/tenancy/sub-domains/organization/organization.repository.js';
import type { MemberRoleRepository } from '@/domains/tenancy/sub-domains/member-roles/member-role.repository.js';
import type { MemberRolePermissionRepository } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.repository.js';
import {
  createPrincipalDatabaseScope,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';

const asScope = (organizationPublicId: string) =>
  createPrincipalDatabaseScope({
    organizationPublicId,
    source: 'token',
  }) as OrganizationPrincipalDatabaseScope;

describe('MemberRolePermissionService', () => {
  const organizationRepository = {
    findByPublicId: vi.fn(),
    resolveUserIdByPublicId: vi.fn(),
  } as unknown as OrganizationRepository;

  const memberRoleRepository = {
    findByPublicId: vi.fn(),
  } as unknown as MemberRoleRepository;

  const memberRolePermissionRepository = {
    replace: vi.fn(),
    findByRoleId: vi.fn(),
  } as unknown as MemberRolePermissionRepository;

  // Unused once the grant guard is stubbed, but the constructor requires them.
  const authorizationService = { resolveUserOrganizationPermissions: vi.fn() };
  const permissionRepository = { findAll: vi.fn() };
  // Used by put() owner-role protection (sec-T2). Default to a non-matching owner role
  // so the existing tests' control flow is unchanged.
  const membershipRepository = {
    findByUserAndOrganization: vi.fn().mockResolvedValue({
      id: 99,
      public_id: 'mem_owner',
      user_id: 11,
      organization_id: 1,
      role_id: 999, // different from the role being PUT against in tests below
      status: 'ACTIVE',
    }),
  };

  const service = new MemberRolePermissionService(
    organizationRepository,
    memberRoleRepository,
    memberRolePermissionRepository,
    authorizationService as never,
    permissionRepository as never,
    membershipRepository as never,
  );

  const PUT_BODY = { permission_codes: ['tenancy:read', 'tenancy:write'] };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(organizationRepository.findByPublicId).mockResolvedValue({
      id: 1,
      public_id: 'org_public_abc',
      owner_user_id: 11,
    } as never);
    vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValue({
      id: 2,
      public_id: 'role_public',
    } as never);
    vi.mocked(organizationRepository.resolveUserIdByPublicId).mockResolvedValue(7);
    vi.mocked(memberRolePermissionRepository.replace).mockResolvedValue([
      { permission_code: 'tenancy:read' },
    ] as never);
    vi.mocked(memberRolePermissionRepository.findByRoleId).mockResolvedValue([
      { permission_code: 'tenancy:read' },
      { permission_code: 'tenancy:write' },
    ] as never);
  });

  describe('listPermissionCodesForRole', () => {
    it('returns only the permission_code strings from the repository rows', async () => {
      const codes = await service.listPermissionCodesForRole(2);

      expect(memberRolePermissionRepository.findByRoleId).toHaveBeenCalledWith(2);
      expect(codes).toEqual(['tenancy:read', 'tenancy:write']);
    });

    it('returns an empty array when the role has no permissions', async () => {
      vi.mocked(memberRolePermissionRepository.findByRoleId).mockResolvedValueOnce([] as never);

      await expect(service.listPermissionCodesForRole(2)).resolves.toEqual([]);
    });
  });

  describe('list', () => {
    it('throws NotFoundError when the organization does not exist', async () => {
      vi.mocked(organizationRepository.findByPublicId).mockResolvedValueOnce(null as never);

      await expect(service.list(asScope('org_public_abc'), 'role_public')).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(memberRolePermissionRepository.findByRoleId).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the role does not exist in the organization', async () => {
      vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValueOnce(null as never);

      await expect(service.list(asScope('org_public_abc'), 'role_public')).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(memberRolePermissionRepository.findByRoleId).not.toHaveBeenCalled();
    });

    it('resolves the role within the organization and returns its permission rows', async () => {
      const rows = await service.list(asScope('org_public_abc'), 'role_public');

      // Role is looked up scoped to the resolved organization id (cross-tenant safety).
      expect(memberRoleRepository.findByPublicId).toHaveBeenCalledWith('role_public', 1);
      expect(memberRolePermissionRepository.findByRoleId).toHaveBeenCalledWith(2);
      expect(rows).toEqual([
        { permission_code: 'tenancy:read' },
        { permission_code: 'tenancy:write' },
      ]);
    });
  });

  describe('put', () => {
    it('throws NotFoundError when the organization does not exist', async () => {
      vi.mocked(organizationRepository.findByPublicId).mockResolvedValueOnce(null as never);

      await expect(
        service.put(asScope('org_public_abc'), 'role_public', PUT_BODY, 'admin_public'),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(memberRolePermissionRepository.replace).not.toHaveBeenCalled();
      expect(invalidateOrganizationPermissions).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the role does not exist in the organization', async () => {
      vi.mocked(memberRoleRepository.findByPublicId).mockResolvedValueOnce(null as never);

      await expect(
        service.put(asScope('org_public_abc'), 'role_public', PUT_BODY, 'admin_public'),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(memberRolePermissionRepository.replace).not.toHaveBeenCalled();
    });

    it('checks the caller may grant the requested codes before any write', async () => {
      await service.put(asScope('org_public_abc'), 'role_public', PUT_BODY, 'admin_public');

      expect(assertCallerCanGrantPermissionCodes).toHaveBeenCalledWith(
        expect.objectContaining({
          callerUserPublicId: 'admin_public',
          organizationPublicId: 'org_public_abc',
          requestedPermissionCodes: ['tenancy:read', 'tenancy:write'],
        }),
      );
    });

    it('replaces the role permission set and invalidates the whole organization namespace', async () => {
      await service.put(asScope('org_public_abc'), 'role_public', PUT_BODY, 'admin_public');

      expect(organizationRepository.resolveUserIdByPublicId).toHaveBeenCalledWith('admin_public');
      expect(memberRolePermissionRepository.replace).toHaveBeenCalledWith(
        2,
        ['tenancy:read', 'tenancy:write'],
        7,
      );
      expect(invalidateOrganizationPermissions).toHaveBeenCalledWith('org_public_abc');
    });

    it('writes a null created-by and never resolves a user id when no caller is provided', async () => {
      await service.put(asScope('org_public_abc'), 'role_public', PUT_BODY, undefined);

      // The `created_by ? resolve(...) : null` branch must take the null path — a mutant that
      // flips the condition would call resolveUserIdByPublicId and persist id 7 instead of null.
      expect(organizationRepository.resolveUserIdByPublicId).not.toHaveBeenCalled();
      expect(memberRolePermissionRepository.replace).toHaveBeenCalledWith(
        2,
        ['tenancy:read', 'tenancy:write'],
        null,
      );
    });

    // sec-T2 — held-permissions-on-remove. A `ROLE_MANAGE` holder must not be
    // able to strip permissions from a role they themselves do not hold; that
    // would let a delegated role-manager downgrade a higher-privileged role
    // (e.g. wiping every Admin perm via empty-array PUT, or selectively pulling
    // `subscription:manage` from a Finance role they don't sit on). Service
    // passes the UNION of added + removed codes to the grant-guard so the
    // caller must hold every code involved in either direction.
    it('checks every code being removed (empty PUT against role with current perms)', async () => {
      vi.mocked(memberRolePermissionRepository.findByRoleId).mockResolvedValueOnce([
        { permission_code: 'subscription:manage' },
        { permission_code: 'tenancy:write' },
      ] as never);

      await service.put(
        asScope('org_public_abc'),
        'role_public',
        { permission_codes: [] },
        'admin_public',
      );

      // Empty-PUT means the caller is removing both currently-held codes; the
      // guard must therefore receive both — not the empty array — so caller
      // entitlement is verified for the wipe.
      expect(assertCallerCanGrantPermissionCodes).toHaveBeenCalledWith(
        expect.objectContaining({
          callerUserPublicId: 'admin_public',
          organizationPublicId: 'org_public_abc',
          requestedPermissionCodes: expect.arrayContaining([
            'subscription:manage',
            'tenancy:write',
          ]),
        }),
      );
      const passedCodes = vi
        .mocked(assertCallerCanGrantPermissionCodes)
        .mock.calls.at(-1)?.[0].requestedPermissionCodes;
      expect(passedCodes).toHaveLength(2);
    });

    it('passes the union of added-and-removed codes (partial replace)', async () => {
      vi.mocked(memberRolePermissionRepository.findByRoleId).mockResolvedValueOnce([
        { permission_code: 'tenancy:read' },
        { permission_code: 'subscription:manage' },
      ] as never);

      await service.put(
        asScope('org_public_abc'),
        'role_public',
        { permission_codes: ['tenancy:read', 'audit:write'] },
        'admin_public',
      );

      const passedCodes = vi
        .mocked(assertCallerCanGrantPermissionCodes)
        .mock.calls.at(-1)?.[0].requestedPermissionCodes;
      // tenancy:read kept (carried over via the new set), audit:write being
      // added, subscription:manage being removed → all three must be in the
      // union the caller is verified against.
      expect(passedCodes).toEqual(
        expect.arrayContaining(['tenancy:read', 'audit:write', 'subscription:manage']),
      );
      expect(passedCodes).toHaveLength(3);
    });

    it('passes an empty array to the guard when role has no perms AND PUT is empty (no-op)', async () => {
      vi.mocked(memberRolePermissionRepository.findByRoleId).mockResolvedValueOnce([] as never);

      await service.put(
        asScope('org_public_abc'),
        'role_public',
        { permission_codes: [] },
        'admin_public',
      );

      expect(assertCallerCanGrantPermissionCodes).toHaveBeenCalledWith(
        expect.objectContaining({
          requestedPermissionCodes: [],
        }),
      );
    });
  });
});
