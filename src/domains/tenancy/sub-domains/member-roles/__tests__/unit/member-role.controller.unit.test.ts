import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError, ValidationError } from '@/shared/errors/index.js';
import { createMemberRoleController } from '@/domains/tenancy/sub-domains/member-roles/member-role.controller.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { MemberRoleService } from '@/domains/tenancy/sub-domains/member-roles/member-role.service.js';
import { attachPrincipalScopeGetters } from '@/tests/helpers/principal-scope-getters.helper.js';

function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return attachPrincipalScopeGetters({
    auth: { kind: 'user' as const, userId: generatePublicId('user'), role: 'USER' },
    params: {},
    body: {},
    query: {},
    headers: {},
    id: 'request-id',
    server: {
      auditDomain: { auditService: { record: vi.fn().mockResolvedValue(undefined) } },
    },
    ...overrides,
  }) as FastifyRequest;
}

function mockReply(): FastifyReply {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
  };
  return reply as unknown as FastifyReply;
}

describe('createMemberRoleController', () => {
  const organizationPublicId = generatePublicId('organization');
  const rolePublicId = generatePublicId('memberRole');
  const role = { public_id: rolePublicId, name: 'Admin' };

  const service = {
    list: vi.fn().mockResolvedValue({
      items: [role],
      limit: 25,
      total: null,
      has_more: false,
      next_cursor: null,
    }),
    getByPublicId: vi.fn().mockResolvedValue(role),
    create: vi.fn().mockResolvedValue(role),
    update: vi.fn().mockResolvedValue(role),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as MemberRoleService;

  const controller = createMemberRoleController(service);

  it('listRoles returns paginated roles', async () => {
    vi.mocked(service.list).mockResolvedValueOnce({
      items: [role],
      limit: 25,
      total: null,
      has_more: true,
      next_cursor: 'role_cursor_2',
    } as never);
    const response = await controller.listRoles(
      mockRequest({ params: { organization_id: organizationPublicId } }),
      mockReply(),
    );
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: organizationPublicId }),
      { limit: 25 },
    );
    expect(response).toMatchObject({
      data: [role],
      meta: { pagination: expect.objectContaining({ has_more: true, next: 'role_cursor_2' }) },
    });
  });

  it('getRole delegates to service', async () => {
    await controller.getRole(
      mockRequest({ params: { organization_id: organizationPublicId, role_id: rolePublicId } }),
      mockReply(),
    );
    expect(service.getByPublicId).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: organizationPublicId }),
      rolePublicId,
    );
  });

  it('createRole returns 200', async () => {
    const reply = mockReply();
    await controller.createRole(
      mockRequest({
        params: { organization_id: organizationPublicId },
        body: { name: 'Editor', permission_codes: ['organization:read'] },
      }),
      reply,
    );
    expect(service.create).toHaveBeenCalled();
    // The controller no longer sets an explicit status: the uniform method-status policy
    // (POST -> 200) owns the code, so the handler must leave reply.code untouched.
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('updateRole delegates to service', async () => {
    await controller.updateRole(
      mockRequest({
        params: { organization_id: organizationPublicId, role_id: rolePublicId },
        body: { name: 'Updated' },
      }),
      mockReply(),
    );
    expect(service.update).toHaveBeenCalled();
  });

  it('deleteRole returns 204', async () => {
    const reply = mockReply();
    await controller.deleteRole(
      mockRequest({ params: { organization_id: organizationPublicId, role_id: rolePublicId } }),
      reply,
    );
    expect(service.delete).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: organizationPublicId }),
      rolePublicId,
    );
    expect(reply.code).toHaveBeenCalledWith(204);
  });

  it('listRoles returns has_more false when all items fit page', async () => {
    vi.mocked(service.list).mockResolvedValueOnce({
      items: [role],
      limit: 25,
      total: null,
      has_more: false,
      next_cursor: null,
    } as never);
    const response = await controller.listRoles(
      mockRequest({ params: { organization_id: organizationPublicId } }),
      mockReply(),
    );
    expect(response).toMatchObject({
      meta: { pagination: expect.objectContaining({ has_more: false }) },
    });
  });

  it('createRole rejects missing organization id when params omit id', async () => {
    // No organization_id path param and no auth.organizationPublicId claim → no org in scope.
    await expect(
      controller.createRole(mockRequest({ params: {}, body: { name: 'X' } }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects missing organization id on listRoles and createRole with ForbiddenError', async () => {
    // Missing param or empty-string param → no org in scope.
    await expect(
      controller.listRoles(mockRequest({ params: {} }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      controller.listRoles(mockRequest({ params: { organization_id: '' } }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      controller.createRole(
        mockRequest({ params: { organization_id: '' }, body: { name: 'X' } }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects malformed organization id on listRoles and createRole with ValidationError', async () => {
    await expect(
      controller.listRoles(mockRequest({ params: { organization_id: 'invalid' } }), mockReply()),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      controller.createRole(
        mockRequest({ params: { organization_id: 'not-valid' }, body: { name: 'X' } }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('getRole with valid organization id uses params without fallback', async () => {
    vi.mocked(service.getByPublicId).mockClear();
    await controller.getRole(
      mockRequest({ params: { organization_id: organizationPublicId, role_id: rolePublicId } }),
      mockReply(),
    );
    expect(service.getByPublicId).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: organizationPublicId }),
      rolePublicId,
    );
  });

  // sec-new-T3: getRole, updateRole, deleteRole now validate both id and roleId.
  it('getRole rejects malformed roleId (sec-new-T3)', async () => {
    await expect(
      controller.getRole(
        mockRequest({
          params: { organization_id: organizationPublicId, role_id: 'not_a_valid_id!!' },
        }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('getRole rejects malformed organizationId (sec-new-T3)', async () => {
    await expect(
      controller.getRole(
        mockRequest({ params: { organization_id: '../../etc', role_id: rolePublicId } }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('getRole rejects empty params with ForbiddenError (sec-new-T3)', async () => {
    // undefined params → no organization in scope → ForbiddenError.
    await expect(
      controller.getRole(mockRequest({ params: undefined }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('updateRole rejects malformed roleId (sec-new-T3)', async () => {
    await expect(
      controller.updateRole(
        mockRequest({
          params: { organization_id: organizationPublicId, role_id: '' },
          body: { name: 'X' },
        }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('updateRole rejects malformed organizationId (sec-new-T3)', async () => {
    await expect(
      controller.updateRole(
        mockRequest({
          params: { organization_id: 'bad id', role_id: rolePublicId },
          body: { name: 'X' },
        }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('deleteRole rejects malformed roleId (sec-new-T3)', async () => {
    await expect(
      controller.deleteRole(
        mockRequest({ params: { organization_id: organizationPublicId, role_id: '' } }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('deleteRole rejects empty params with ForbiddenError (sec-new-T3)', async () => {
    // undefined params → no organization in scope → ForbiddenError.
    await expect(
      controller.deleteRole(mockRequest({ params: undefined }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
