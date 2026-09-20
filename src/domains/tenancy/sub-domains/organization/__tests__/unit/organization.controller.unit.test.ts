import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError } from '@/shared/errors/index.js';
import { createOrganizationController } from '@/domains/tenancy/sub-domains/organization/organization.controller.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { AuditService } from '@/domains/audit/audit.service.js';
import { attachPrincipalScope } from '@/tests/helpers/principal-scope.helper.js';

describe('createOrganizationController', () => {
  const organizationPublicId = generatePublicId('organization');
  const userPublicId = generatePublicId('user');

  function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
    return attachPrincipalScope({
      auth: { kind: 'user' as const, userId: userPublicId, role: 'USER' },
      params: {},
      body: {},
      query: {},
      headers: {},
      id: 'request-id',
      ...overrides,
    }) as FastifyRequest;
  }

  function mockReply(): FastifyReply {
    const reply = {
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    return reply as unknown as FastifyReply;
  }
  const organization = { public_id: organizationPublicId, name: 'Acme', slug: 'acme' };

  const service = {
    list: vi.fn().mockResolvedValue({
      items: [organization],
      limit: 20,
      total: null,
      has_more: false,
      next_cursor: null,
    }),
    getByPublicId: vi.fn().mockResolvedValue(organization),
    getBySlug: vi.fn().mockResolvedValue(organization),
    create: vi.fn().mockResolvedValue(organization),
    update: vi.fn().mockResolvedValue(organization),
    delete: vi.fn().mockResolvedValue(undefined),
    uploadLogo: vi.fn().mockResolvedValue(organization),
    deleteLogo: vi.fn().mockResolvedValue(organization),
  } as unknown as OrganizationService;

  const auditService = {
    listForOrganization: vi.fn().mockResolvedValue({
      items: [],
      limit: 20,
      total: null,
      has_more: false,
      next_cursor: null,
    }),
  } as unknown as AuditService;

  const controller = createOrganizationController(service, auditService);

  it('listOrganizations returns paginated data with has_more', async () => {
    vi.mocked(service.list).mockResolvedValueOnce({
      items: [organization],
      limit: 20,
      total: null,
      has_more: true,
      next_cursor: 'organization_cursor_2',
    } as never);
    const response = await controller.listOrganizations(mockRequest(), mockReply());
    expect(service.list).toHaveBeenCalledWith({}, userPublicId);
    expect(response).toMatchObject({
      data: [organization],
      meta: {
        pagination: expect.objectContaining({ has_more: true, next: 'organization_cursor_2' }),
      },
    });
  });

  it('listOrganizations returns has_more false when all items fit page', async () => {
    vi.mocked(service.list).mockResolvedValueOnce({
      items: [organization],
      limit: 20,
      total: null,
      has_more: false,
      next_cursor: null,
    } as never);
    const response = await controller.listOrganizations(mockRequest(), mockReply());
    expect(response).toMatchObject({
      meta: { pagination: expect.objectContaining({ has_more: false, next: null }) },
    });
  });

  it('getOrganization delegates to service', async () => {
    await controller.getOrganization(
      mockRequest({ params: { organization_id: organizationPublicId } }),
      mockReply(),
    );
    expect(service.getByPublicId).toHaveBeenCalledWith(organizationPublicId, userPublicId);
  });

  it('getOrganizationBySlug delegates to service', async () => {
    await controller.getOrganizationBySlug(mockRequest({ params: { slug: 'acme' } }), mockReply());
    expect(service.getBySlug).toHaveBeenCalledWith('acme', userPublicId);
  });

  it('createOrganization returns 200', async () => {
    const reply = mockReply();
    await controller.createOrganization(
      mockRequest({ body: { name: 'Acme', slug: 'acme' } }),
      reply,
    );
    expect(service.create).toHaveBeenCalled();
    // The controller no longer sets an explicit status: the uniform method-status policy
    // (POST -> 200) owns the code, so the handler must leave reply.code untouched.
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('updateOrganization delegates to service', async () => {
    await controller.updateOrganization(
      mockRequest({ params: { organization_id: organizationPublicId }, body: { name: 'New' } }),
      mockReply(),
    );
    expect(service.update).toHaveBeenCalled();
  });

  it('deleteOrganization returns 204', async () => {
    const reply = mockReply();
    await controller.deleteOrganization(
      mockRequest({ params: { organization_id: organizationPublicId } }),
      reply,
    );
    expect(service.delete).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: organizationPublicId }),
    );
    expect(reply.code).toHaveBeenCalledWith(204);
  });

  it('uploadLogo and deleteLogo delegate to service', async () => {
    await controller.uploadLogo(
      mockRequest({
        params: { organization_id: organizationPublicId },
        body: { key: `organization-logos/${organizationPublicId}/logo.png` },
      }),
      mockReply(),
    );
    expect(service.uploadLogo).toHaveBeenCalled();

    await controller.deleteLogo(
      mockRequest({ params: { organization_id: organizationPublicId } }),
      mockReply(),
    );
    expect(service.deleteLogo).toHaveBeenCalled();
  });

  it('listOrganizationAuditLogs delegates to audit service', async () => {
    vi.mocked(auditService.listForOrganization).mockResolvedValueOnce({
      items: [],
      limit: 20,
      total: null,
      has_more: true,
      next_cursor: 'audit_cursor_2',
    } as never);
    const response = await controller.listOrganizationAuditLogs(
      mockRequest({ params: { organization_id: organizationPublicId }, query: { limit: '20' } }),
      mockReply(),
    );
    expect(auditService.listForOrganization).toHaveBeenCalled();
    expect(response).toMatchObject({
      meta: { pagination: expect.objectContaining({ has_more: true, next: 'audit_cursor_2' }) },
    });
  });

  it('ignores a malformed organization path param — the signed claim decides', async () => {
    const organizationPublicId = generatePublicId('organization');
    vi.mocked(service.getByPublicId).mockClear();
    await controller.getOrganization(
      mockRequest({
        auth: {
          kind: 'user' as const,
          userId: userPublicId,
          role: 'user',
          organizationPublicId,
        },
        params: { organization_id: 'not-a-public-id' },
      }),
      mockReply(),
    );
    expect(service.getByPublicId).toHaveBeenCalledWith(organizationPublicId, userPublicId);
  });

  it('rejects a missing organization context with ForbiddenError on each validated handler', async () => {
    // No path param and no `org` token claim → "organization context required" (403), matching
    // requireOrganizationPermission. On real flattened routes the active organization arrives via the signed
    // claim; the mock principal here carries none, and an empty path segment cannot reach a handler.
    await expect(
      controller.getOrganization(mockRequest({ params: {} }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      controller.updateOrganization(mockRequest({ params: {}, body: { name: 'X' } }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      controller.deleteOrganization(mockRequest({ params: { organization_id: '' } }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      controller.uploadLogo(mockRequest({ params: {}, body: { key: 'k' } }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      controller.deleteLogo(mockRequest({ params: { organization_id: '' } }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      controller.listOrganizationAuditLogs(mockRequest({ params: {} }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('uses empty slug default when params are undefined', async () => {
    vi.mocked(service.getBySlug).mockClear();
    await controller.getOrganizationBySlug(mockRequest({ params: undefined }), mockReply());
    expect(service.getBySlug).toHaveBeenCalledWith('', userPublicId);
  });

  it('listOrganizationAuditLogs returns has_more false on last page', async () => {
    vi.mocked(auditService.listForOrganization).mockResolvedValueOnce({
      items: [],
      limit: 20,
      total: null,
      has_more: false,
      next_cursor: null,
    } as never);
    const response = await controller.listOrganizationAuditLogs(
      mockRequest({ params: { organization_id: organizationPublicId }, query: { after: '100' } }),
      mockReply(),
    );
    expect(response).toMatchObject({
      meta: { pagination: expect.objectContaining({ has_more: false, next: null }) },
    });
  });

  it('listOrganizationAuditLogs throws when audit service is not configured', async () => {
    const controllerWithoutAudit = createOrganizationController(service);
    await expect(
      controllerWithoutAudit.listOrganizationAuditLogs(
        mockRequest({ params: { organization_id: organizationPublicId } }),
        mockReply(),
      ),
    ).rejects.toThrow('Audit service not configured');
  });
});
