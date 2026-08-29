import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError, ValidationError } from '@/shared/errors/index.js';
import { createMembershipController } from '@/domains/tenancy/sub-domains/membership/membership.controller.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { attachPrincipalScope } from '@/tests/helpers/principal-scope.helper.js';

function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return attachPrincipalScope({
    auth: { kind: 'user' as const, userId: generatePublicId('user'), role: 'USER' },
    params: {},
    body: {},
    query: { limit: 20 },
    headers: {},
    id: 'request-id',
    ...overrides,
  }) as FastifyRequest;
}

function mockReply(): FastifyReply {
  return {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as FastifyReply;
}

describe('createMembershipController', () => {
  const organizationPublicId = generatePublicId('organization');
  const membershipPublicId = generatePublicId('membership');
  const membership = { id: membershipPublicId };
  const service = {
    list: vi.fn().mockResolvedValue({
      items: [membership],
      limit: 20,
      total: null,
      has_more: true,
      next_cursor: 'membership_cursor_2',
    }),
    getByPublicId: vi.fn().mockResolvedValue(membership),
    create: vi.fn().mockResolvedValue(membership),
    update: vi.fn().mockResolvedValue(membership),
    delete: vi.fn().mockResolvedValue(undefined),
    getPermissions: vi.fn().mockResolvedValue({ permissions: ['organization:read'] }),
    leaveOrganization: vi.fn().mockResolvedValue(undefined),
    transferOwnership: vi.fn().mockResolvedValue(membership),
  };

  const controller = createMembershipController(service as never);

  it('listMemberships returns paginated memberships', async () => {
    const response = await controller.listMemberships(
      mockRequest({ params: { organization_id: organizationPublicId } }),
      {} as FastifyReply,
    );
    expect(service.list).toHaveBeenCalled();
    expect(response).toMatchObject({
      meta: {
        pagination: expect.objectContaining({ has_more: true, next: 'membership_cursor_2' }),
      },
    });
  });

  it('getMembership returns membership', async () => {
    await controller.getMembership(
      mockRequest({
        params: { organization_id: organizationPublicId, membership_id: membershipPublicId },
      }),
      {} as FastifyReply,
    );
    expect(service.getByPublicId).toHaveBeenCalled();
  });

  it('createMembership returns 200', async () => {
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    await controller.createMembership(
      mockRequest({
        params: { organization_id: organizationPublicId },
        body: { email: 'invitee@example.com', role_id: generatePublicId('memberRole') },
      }),
      reply as unknown as FastifyReply,
    );
    // The controller no longer sets an explicit status: the uniform method-status policy
    // (POST -> 200) owns the code, so the handler must leave reply.code untouched.
    expect(reply.code).not.toHaveBeenCalled();
  });

  it('updateMembership and deleteMembership delegate to service', async () => {
    await controller.updateMembership(
      mockRequest({
        params: { organization_id: organizationPublicId, membership_id: membershipPublicId },
        body: { status: 'ACTIVE' },
      }),
      {} as FastifyReply,
    );
    const reply = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    await controller.deleteMembership(
      mockRequest({
        params: { organization_id: organizationPublicId, membership_id: membershipPublicId },
      }),
      reply as unknown as FastifyReply,
    );
    expect(service.update).toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(204);
  });

  it('getMembershipPermissions leave and transferOwnership delegate to service', async () => {
    await controller.getMembershipPermissions(
      mockRequest({
        params: { organization_id: organizationPublicId, membership_id: membershipPublicId },
      }),
      {} as FastifyReply,
    );
    const leaveReply = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    await controller.leaveOrganization(
      mockRequest({ params: { organization_id: organizationPublicId } }),
      leaveReply as unknown as FastifyReply,
    );
    await controller.transferOwnership(
      mockRequest({
        params: { organization_id: organizationPublicId },
        body: { new_owner_user_id: generatePublicId('user') },
      }),
      {} as FastifyReply,
    );
    expect(service.getPermissions).toHaveBeenCalled();
    expect(service.leaveOrganization).toHaveBeenCalled();
    expect(service.transferOwnership).toHaveBeenCalled();
  });

  it('listMemberships returns has_more false when all items fit page', async () => {
    vi.mocked(service.list).mockResolvedValueOnce({
      items: [{ id: 'mem_public' }],
      limit: 20,
      total: null,
      has_more: false,
      next_cursor: null,
    } as never);
    const response = await controller.listMemberships(
      mockRequest({ params: { organization_id: organizationPublicId } }),
      mockReply(),
    );
    expect(response).toMatchObject({
      meta: { pagination: expect.objectContaining({ has_more: false }) },
    });
  });

  it('rejects missing organization id on validated handlers with ForbiddenError', async () => {
    // No organization_id path param and no auth.organizationPublicId claim → no organization in scope.
    await expect(
      controller.listMemberships(mockRequest({ params: {} }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      controller.createMembership(mockRequest({ params: {}, body: {} }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Empty-string organization_id also resolves to "no organization in scope".
    await expect(
      controller.createMembership(
        mockRequest({ params: { organization_id: '' }, body: {} }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      controller.leaveOrganization(mockRequest({ params: {} }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      controller.transferOwnership(mockRequest({ params: {} }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('ignores organization path params on validated handlers — the signed claim decides', async () => {
    vi.mocked(service.list).mockClear();
    await controller.listMemberships(
      mockRequest({
        auth: {
          kind: 'user' as const,
          userId: generatePublicId('user'),
          role: 'user',
          organizationPublicId,
        },
        params: { organization_id: 'not-a-public-id' },
      }),
      mockReply(),
    );
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId }),
      expect.anything(),
    );
  });

  it('getMembershipPermissions delegates to service with valid params', async () => {
    await controller.getMembershipPermissions(
      mockRequest({
        params: { organization_id: organizationPublicId, membership_id: membershipPublicId },
      }),
      mockReply(),
    );
    expect(service.getPermissions).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: organizationPublicId }),
      membershipPublicId,
    );
  });

  it('createMembership returns 200 with valid organization id', async () => {
    const reply = mockReply();
    await controller.createMembership(
      mockRequest({
        params: { organization_id: organizationPublicId },
        body: {
          email: 'invitee@example.com',
          role_id: generatePublicId('memberRole'),
          expires_in_days: 14,
        },
      }),
      reply,
    );
    // The controller no longer sets an explicit status: the uniform method-status policy
    // (POST -> 200) owns the code, so the handler must leave reply.code untouched.
    expect(reply.code).not.toHaveBeenCalled();
    expect(service.create).toHaveBeenCalled();
  });

  it('listMemberships rejects with ForbiddenError when params omit organization id', async () => {
    vi.mocked(service.list).mockClear();
    await expect(
      controller.listMemberships(mockRequest({ params: {} }), mockReply()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('sec-re-18: updateMembership and deleteMembership reject when the organization id is missing instead of passing a sentinel through', async () => {
    // Prior behaviour: missing organization id collapsed to undefined / '' and was
    // forwarded to the service (which would then fail elsewhere with unbounded
    // cardinality on the observability path). sec-re-18 binds at the boundary so
    // the request is rejected before the service is reached. With no organization_id
    // path param and no auth.organizationPublicId claim, the organization is out of scope and
    // resolveActiveOrganizationId throws ForbiddenError.
    vi.mocked(service.update).mockClear();
    vi.mocked(service.delete).mockClear();
    await expect(
      controller.updateMembership(
        mockRequest({ params: { membership_id: membershipPublicId }, body: { status: 'ACTIVE' } }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(service.update).not.toHaveBeenCalled();
    await expect(
      controller.deleteMembership(
        mockRequest({ params: { membership_id: membershipPublicId } }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(service.delete).not.toHaveBeenCalled();
  });

  it('sec-re-18: every membership handler that takes path params rejects undefined params (no organization in scope) with ForbiddenError', async () => {
    vi.mocked(service.getByPublicId).mockClear();
    vi.mocked(service.update).mockClear();
    vi.mocked(service.delete).mockClear();
    vi.mocked(service.getPermissions).mockClear();

    await expect(
      controller.getMembership(mockRequest({ params: undefined }), {} as FastifyReply),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(service.getByPublicId).not.toHaveBeenCalled();

    await expect(
      controller.getMembershipPermissions(mockRequest({ params: undefined }), {} as FastifyReply),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(service.getPermissions).not.toHaveBeenCalled();

    await expect(
      controller.updateMembership(
        mockRequest({ params: undefined, body: { status: 'ACTIVE' } }),
        {} as FastifyReply,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(service.update).not.toHaveBeenCalled();

    const deleteReply = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    await expect(
      controller.deleteMembership(
        mockRequest({ params: undefined }),
        deleteReply as unknown as FastifyReply,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(service.delete).not.toHaveBeenCalled();
  });

  it('sec-re-18: handlers reject an invalid membershipId at the boundary', async () => {
    // membershipId was previously a raw passthrough — an attacker-supplied
    // string would flow into the service and downstream observability.
    vi.mocked(service.getByPublicId).mockClear();
    vi.mocked(service.getPermissions).mockClear();
    await expect(
      controller.getMembership(
        mockRequest({
          params: { organization_id: organizationPublicId, membership_id: 'not-a-public-id' },
        }),
        {} as FastifyReply,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(service.getByPublicId).not.toHaveBeenCalled();
    await expect(
      controller.getMembershipPermissions(
        mockRequest({
          params: { organization_id: organizationPublicId, membership_id: 'not-a-public-id' },
        }),
        {} as FastifyReply,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(service.getPermissions).not.toHaveBeenCalled();
  });
});
