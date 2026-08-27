import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createMemberRolePermissionController } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.controller.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { NotFoundError, UnauthorizedError } from '@/shared/errors/index.js';
import type { MemberRolePermissionService } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.service.js';
import { attachPrincipalScopeGetters } from '@/tests/helpers/principal-scope-getters.helper.js';

function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return attachPrincipalScopeGetters({
    auth: { kind: 'user', userId: generatePublicId('user'), role: 'user' },
    params: {},
    body: {},
    headers: {},
    id: 'request-id',
    ...overrides,
  }) as FastifyRequest;
}

function mockReply(): FastifyReply {
  return {} as FastifyReply;
}

describe('createMemberRolePermissionController', () => {
  const organizationPublicId = generatePublicId('organization');
  const rolePublicId = generatePublicId('memberRole');

  const now = new Date('2026-01-01T00:00:00.000Z');
  const permissionRow = {
    permission_code: 'tenancy:read',
    created_at: now,
  };

  const service = {
    list: vi.fn().mockResolvedValue([permissionRow]),
    put: vi.fn().mockResolvedValue([permissionRow]),
    listPermissionCodesForRole: vi.fn().mockResolvedValue(['tenancy:read']),
  } as unknown as MemberRolePermissionService;

  const controller = createMemberRolePermissionController(service);

  it('listRolePermissions delegates to service and returns paginated response', async () => {
    const response = await controller.listRolePermissions(
      mockRequest({ params: { organization_id: organizationPublicId, role_id: rolePublicId } }),
      mockReply(),
    );
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: organizationPublicId }),
      rolePublicId,
    );
    expect(response).toMatchObject({
      data: [{ role_id: rolePublicId, permission_code: 'tenancy:read' }],
      meta: { pagination: { has_more: false, next: null, estimated_total: 1 } },
    });
  });

  it('listRolePermissions propagates NotFoundError when organization is missing', async () => {
    vi.mocked(service.list).mockRejectedValueOnce(new NotFoundError('Organization'));
    await expect(
      controller.listRolePermissions(
        mockRequest({ params: { organization_id: organizationPublicId, role_id: rolePublicId } }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('listRolePermissions propagates NotFoundError when role is missing', async () => {
    vi.mocked(service.list).mockRejectedValueOnce(new NotFoundError('Role'));
    await expect(
      controller.listRolePermissions(
        mockRequest({ params: { organization_id: organizationPublicId, role_id: rolePublicId } }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('listRolePermissions returns empty paginated response when no permissions', async () => {
    vi.mocked(service.list).mockResolvedValueOnce([]);
    const response = await controller.listRolePermissions(
      mockRequest({ params: { organization_id: organizationPublicId, role_id: rolePublicId } }),
      mockReply(),
    );
    expect(response).toMatchObject({
      data: [],
      meta: { pagination: { estimated_total: 0, has_more: false } },
    });
  });

  it('putRolePermissions delegates to service with user id', async () => {
    const userId = generatePublicId('user');
    const body = { permission_codes: ['tenancy:read'] };
    const response = await controller.putRolePermissions(
      mockRequest({
        params: { organization_id: organizationPublicId, role_id: rolePublicId },
        body,
        auth: { kind: 'user', userId, role: 'user' } as never,
      }),
      mockReply(),
    );
    expect(service.put).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: organizationPublicId }),
      rolePublicId,
      body,
      userId,
    );
    expect(response).toMatchObject({
      data: [{ role_id: rolePublicId, permission_code: 'tenancy:read' }],
    });
  });

  it('putRolePermissions throws UnauthorizedError when auth is missing', async () => {
    await expect(
      controller.putRolePermissions(
        mockRequest({
          params: { organization_id: organizationPublicId, role_id: rolePublicId },
          auth: undefined as never,
        }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('putRolePermissions propagates NotFoundError when role is missing', async () => {
    vi.mocked(service.put).mockRejectedValueOnce(new NotFoundError('Role'));
    await expect(
      controller.putRolePermissions(
        mockRequest({
          params: { organization_id: organizationPublicId, role_id: rolePublicId },
          body: { permission_codes: [] },
        }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('putRolePermissions propagates generic error', async () => {
    vi.mocked(service.put).mockRejectedValueOnce(new Error('Cache eviction failed'));
    await expect(
      controller.putRolePermissions(
        mockRequest({
          params: { organization_id: organizationPublicId, role_id: rolePublicId },
          body: { permission_codes: ['tenancy:read'] },
        }),
        mockReply(),
      ),
    ).rejects.toThrow('Cache eviction failed');
  });
});
