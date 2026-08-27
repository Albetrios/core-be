import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createOrganizationApiKeyController } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.controller.js';
import type { OrganizationApiKeyService } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.service.js';
import { UnauthorizedError } from '@/shared/errors/index.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

// The controller records best-effort lifecycle audit events; stub the audit util so the unit test
// (a minimal request without `server.auditDomain`) exercises authorization + service delegation only.
vi.mock('@/shared/utils/infrastructure/audit-request-context.util.js', () => ({
  recordScopedAuditEvent: vi.fn().mockResolvedValue(undefined),
  buildAuditActorFields: vi.fn(() => ({})),
}));

describe('createOrganizationApiKeyController', () => {
  const organizationPublicId = generatePublicId('organization');
  const apiKeyPublicId = generatePublicId('organizationApiKey');
  const userPublicId = generatePublicId('user');

  const service = {
    create: vi.fn().mockResolvedValue({
      api_key: { id: apiKeyPublicId },
      raw_key: 'ak_test_secret',
    }),
    rotate: vi.fn().mockResolvedValue({
      api_key: { id: generatePublicId('organizationApiKey') },
      raw_key: 'ak_rotated_secret',
    }),
    update: vi.fn().mockResolvedValue({ id: apiKeyPublicId }),
  } as unknown as OrganizationApiKeyService;

  const controller = createOrganizationApiKeyController(service);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockReply(): FastifyReply {
    return {
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as unknown as FastifyReply;
  }

  function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
    return {
      auth: { userId: userPublicId },
      params: { organization_id: organizationPublicId, api_key_id: apiKeyPublicId },
      body: {},
      query: {},
      headers: {},
      id: 'request-id',
      ...overrides,
    } as FastifyRequest;
  }

  it('rejects API-key principals when creating a new API key', async () => {
    await expect(
      controller.createApiKey(
        mockRequest({
          auth: {
            kind: 'apiKey' as const,
            apiKeyPublicId,
            apiKeyScopes: ['api-key:manage'],
            organizationPublicId,
          },
        }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('rejects API-key principals when rotating an API key', async () => {
    await expect(
      controller.rotateApiKey(
        mockRequest({
          auth: {
            kind: 'apiKey' as const,
            apiKeyPublicId,
            apiKeyScopes: ['api-key:manage'],
            organizationPublicId,
          },
        }),
        mockReply(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(service.rotate).not.toHaveBeenCalled();
  });

  it('still allows API-key principals to update API-key metadata with manage scope', async () => {
    await controller.updateApiKey(
      mockRequest({
        auth: {
          kind: 'apiKey' as const,
          apiKeyPublicId,
          apiKeyScopes: ['api-key:manage'],
          organizationPublicId,
        },
      }),
      mockReply(),
    );

    expect(service.update).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId: organizationPublicId }),
      apiKeyPublicId,
      {},
      undefined,
    );
  });
});
