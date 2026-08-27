import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createOrganizationNotificationPolicyController } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/organization-notification-policy.controller.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { NotFoundError, UnauthorizedError } from '@/shared/errors/index.js';
import type { OrganizationNotificationPolicyService } from '@/domains/tenancy/sub-domains/organization/organization-notification-policy/organization-notification-policy.service.js';
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
  return {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as FastifyReply;
}

const organizationPublicId = generatePublicId('organization');
const policyRow = {
  id: 1,
  organization_id: organizationPublicId,
  notification_type: 'invite',
  channel: 'email',
  default_enabled: true,
  is_mandatory: false,
  muted_until: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('createOrganizationNotificationPolicyController', () => {
  const service = {
    list: vi.fn().mockResolvedValue([policyRow]),
    getByPublicId: vi.fn().mockResolvedValue(policyRow),
    create: vi.fn().mockResolvedValue(policyRow),
    update: vi.fn().mockResolvedValue(policyRow),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as OrganizationNotificationPolicyService;

  const controller = createOrganizationNotificationPolicyController(service);

  it('listPolicies delegates to service and returns policies', async () => {
    const response = await controller.listPolicies(
      mockRequest({ params: { organization_id: organizationPublicId } }),
      mockReply(),
    );
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: organizationPublicId }),
    );
    expect(response).toMatchObject({ data: [policyRow] });
  });

  it('listPolicies propagates NotFoundError when org is missing', async () => {
    vi.mocked(service.list).mockRejectedValueOnce(new NotFoundError('Organization'));
    await expect(
      controller.listPolicies(
        mockRequest({ params: { organization_id: organizationPublicId } }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getPolicy delegates to service with policy id', async () => {
    const response = await controller.getPolicy(
      mockRequest({
        params: {
          organization_id: organizationPublicId,
          notification_policy_id: 'pol_a1b2c3d4e5f6g7h8i9j0k',
        },
      }),
      mockReply(),
    );
    expect(service.getByPublicId).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: organizationPublicId }),
      'pol_a1b2c3d4e5f6g7h8i9j0k',
    );
    expect(response).toMatchObject({ data: policyRow });
  });

  it('getPolicy propagates NotFoundError when policy is missing', async () => {
    vi.mocked(service.getByPublicId).mockRejectedValueOnce(
      new NotFoundError('Organization notification policy'),
    );
    await expect(
      controller.getPolicy(
        mockRequest({
          params: {
            organization_id: organizationPublicId,
            notification_policy_id: 'pol_a1b2c3d4e5f6g7h8i9j0k',
          },
        }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('createPolicy delegates to service and leaves the status to the method policy', async () => {
    const body = {
      notification_type: 'invite',
      channel: 'email',
      default_enabled: true,
      is_mandatory: false,
    };
    const userId = generatePublicId('user');
    const reply = mockReply();
    const response = await controller.createPolicy(
      mockRequest({
        params: { organization_id: organizationPublicId },
        body,
        auth: { kind: 'user', userId, role: 'user' } as never,
      }),
      reply,
    );
    // The controller no longer sets an explicit status: the uniform method-status policy
    // (POST -> 200) owns the code, so the handler must leave reply.code untouched.
    expect(reply.code).not.toHaveBeenCalled();
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: organizationPublicId }),
      body,
      userId,
    );
    expect(response).toMatchObject({ data: policyRow });
  });

  it('createPolicy throws UnauthorizedError when auth is missing', async () => {
    await expect(
      controller.createPolicy(
        mockRequest({
          params: { organization_id: organizationPublicId },
          auth: undefined as never,
        }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('updatePolicy delegates to service with policy id and user', async () => {
    const body = { default_enabled: false };
    const userId = generatePublicId('user');
    const response = await controller.updatePolicy(
      mockRequest({
        params: {
          organization_id: organizationPublicId,
          notification_policy_id: 'pol_a1b2c3d4e5f6g7h8i9j0k',
        },
        body,
        auth: { kind: 'user', userId, role: 'user' } as never,
      }),
      mockReply(),
    );
    expect(service.update).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: organizationPublicId }),
      'pol_a1b2c3d4e5f6g7h8i9j0k',
      body,
      userId,
    );
    expect(response).toMatchObject({ data: policyRow });
  });

  it('updatePolicy throws UnauthorizedError when auth is missing', async () => {
    await expect(
      controller.updatePolicy(
        mockRequest({
          params: {
            organization_id: organizationPublicId,
            notification_policy_id: 'pol_a1b2c3d4e5f6g7h8i9j0k',
          },
          auth: undefined as never,
        }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('updatePolicy propagates NotFoundError when policy is missing', async () => {
    vi.mocked(service.update).mockRejectedValueOnce(
      new NotFoundError('Organization notification policy'),
    );
    await expect(
      controller.updatePolicy(
        mockRequest({
          params: {
            organization_id: organizationPublicId,
            notification_policy_id: 'pol_a1b2c3d4e5f6g7h8i9j0k',
          },
          body: {},
        }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deletePolicy calls service delete and sends 204', async () => {
    const reply = mockReply();
    await controller.deletePolicy(
      mockRequest({
        params: {
          organization_id: organizationPublicId,
          notification_policy_id: 'pol_a1b2c3d4e5f6g7h8i9j0k',
        },
      }),
      reply,
    );
    expect(service.delete).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: organizationPublicId }),
      'pol_a1b2c3d4e5f6g7h8i9j0k',
    );
    expect(reply.code).toHaveBeenCalledWith(204);
    expect(reply.send).toHaveBeenCalled();
  });

  it('deletePolicy throws UnauthorizedError when auth is missing', async () => {
    await expect(
      controller.deletePolicy(
        mockRequest({
          params: {
            organization_id: organizationPublicId,
            notification_policy_id: 'pol_a1b2c3d4e5f6g7h8i9j0k',
          },
          auth: undefined as never,
        }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('deletePolicy propagates NotFoundError when policy is missing', async () => {
    vi.mocked(service.delete).mockRejectedValueOnce(
      new NotFoundError('Organization notification policy'),
    );
    await expect(
      controller.deletePolicy(
        mockRequest({
          params: {
            organization_id: organizationPublicId,
            notification_policy_id: 'pol_a1b2c3d4e5f6g7h8i9j0k',
          },
        }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
