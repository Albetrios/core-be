import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ValidationError } from '@/shared/errors/index.js';
import { createWebhookController } from '@/domains/notify/sub-domains/webhook/webhook.controller.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { WebhookService } from '@/domains/notify/sub-domains/webhook/webhook.service.js';

function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    auth: { userId: generatePublicId('user'), role: 'user' },
    params: {},
    body: {},
    query: {},
    headers: {},
    id: 'request-id',
    ...overrides,
  } as FastifyRequest;
}

function mockReply(): FastifyReply {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply as unknown as FastifyReply;
}

describe('createWebhookController', () => {
  const organizationPublicId = generatePublicId('organization');
  const webhookPublicId = generatePublicId('webhook');
  const webhook = { public_id: webhookPublicId, url: 'https://example.com/hook' };

  const service = {
    list: vi.fn().mockResolvedValue({
      items: [webhook],
      total: null,
      limit: 25,
      has_more: false,
      next_cursor: null,
    }),
    get: vi.fn().mockResolvedValue(webhook),
    create: vi.fn().mockResolvedValue(webhook),
    update: vi.fn().mockResolvedValue(webhook),
    delete: vi.fn().mockResolvedValue(undefined),
    listDeliveryAttempts: vi.fn().mockResolvedValue({
      items: [],
      total: null,
      limit: 25,
      has_more: false,
      next_cursor: null,
    }),
    testWebhook: vi.fn().mockResolvedValue({ delivered: true }),
  } as unknown as WebhookService;

  const controller = createWebhookController(service);

  it('listWebhooks and getWebhook delegate to service', async () => {
    await controller.listWebhooks(
      mockRequest({ params: { organization_id: organizationPublicId } }) as never,
      mockReply(),
    );
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ organizationPublicId }),
        limit: 25,
      }),
    );

    await controller.getWebhook(
      mockRequest({
        params: { organization_id: organizationPublicId, webhook_id: webhookPublicId },
      }) as never,
      mockReply(),
    );
    expect(service.get).toHaveBeenCalled();
  });

  it('createWebhook and updateWebhook delegate to service', async () => {
    await controller.createWebhook(
      mockRequest({
        params: { organization_id: organizationPublicId },
        body: { url: 'https://example.com/hook', events: ['subscription.updated'] },
      }) as never,
      mockReply(),
    );
    expect(service.create).toHaveBeenCalled();

    await controller.updateWebhook(
      mockRequest({
        params: { organization_id: organizationPublicId, webhook_id: webhookPublicId },
        body: { enabled: false },
      }) as never,
      mockReply(),
    );
    expect(service.update).toHaveBeenCalled();
  });

  it('deleteWebhook returns 204', async () => {
    const reply = mockReply();
    await controller.deleteWebhook(
      mockRequest({
        params: { organization_id: organizationPublicId, webhook_id: webhookPublicId },
      }) as never,
      reply,
    );
    expect(service.delete).toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(204);
  });

  it('listDeliveryAttempts and testWebhook delegate to service', async () => {
    await controller.listDeliveryAttempts(
      mockRequest({
        params: { organization_id: organizationPublicId, webhook_id: webhookPublicId },
        query: { limit: '10' },
      }) as never,
      mockReply(),
    );
    expect(service.listDeliveryAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ organizationPublicId }),
        webhook_public_id: webhookPublicId,
        limit: 10,
      }),
    );

    await controller.testWebhook(
      mockRequest({
        params: { organization_id: organizationPublicId, webhook_id: webhookPublicId },
      }) as never,
      mockReply(),
    );
    expect(service.testWebhook).toHaveBeenCalled();
  });

  it('listDeliveryAttempts uses default limit when query is omitted', async () => {
    await controller.listDeliveryAttempts(
      mockRequest({
        params: { organization_id: organizationPublicId, webhook_id: webhookPublicId },
        query: {},
      }) as never,
      mockReply(),
    );
    expect(service.listDeliveryAttempts).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({ organizationPublicId }),
        webhook_public_id: webhookPublicId,
        limit: 25,
      }),
    );
  });

  describe('listWebhooks (cursor pagination)', () => {
    it('forwards after, limit, and include_total=true to the service', async () => {
      await controller.listWebhooks(
        mockRequest({
          params: { organization_id: organizationPublicId },
          query: { after: 'cursor-token', limit: '5', include_total: 'true' },
        }) as never,
        mockReply(),
      );
      expect(service.list).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: expect.objectContaining({ organizationPublicId }),
          after: 'cursor-token',
          limit: 5,
          include_total: true,
        }),
      );
    });

    it('emits next_cursor in next field when service signals more pages (keyset)', async () => {
      vi.mocked(service.list).mockResolvedValueOnce({
        items: [webhook],
        total: null,
        limit: 1,
        has_more: true,
        next_cursor: 'opaque-cursor-2',
      } as never);
      const response = await controller.listWebhooks(
        mockRequest({
          params: { organization_id: organizationPublicId },
          query: { limit: '1' },
        }) as never,
        mockReply(),
      );
      expect(response).toMatchObject({
        meta: {
          pagination: expect.objectContaining({
            has_more: true,
            next: 'opaque-cursor-2',
            per_page: 1,
          }),
        },
      });
      expect(
        (response as { meta: { pagination: Record<string, unknown> } }).meta.pagination,
      ).not.toHaveProperty('estimated_total');
    });

    it('clears next when on the final page and omits estimated_total without include_total', async () => {
      vi.mocked(service.list).mockResolvedValueOnce({
        items: [webhook],
        total: null,
        limit: 25,
        has_more: false,
        next_cursor: null,
      } as never);
      const response = await controller.listWebhooks(
        mockRequest({ params: { organization_id: organizationPublicId } }) as never,
        mockReply(),
      );
      expect(response).toMatchObject({
        meta: {
          pagination: expect.objectContaining({ has_more: false, next: null, per_page: 25 }),
        },
      });
      expect(
        (response as { meta: { pagination: Record<string, unknown> } }).meta.pagination,
      ).not.toHaveProperty('estimated_total');
    });

    it('exposes estimated_total when service returns a total', async () => {
      vi.mocked(service.list).mockResolvedValueOnce({
        items: [webhook],
        total: 1,
        limit: 25,
        has_more: false,
        next_cursor: null,
      } as never);
      const response = await controller.listWebhooks(
        mockRequest({
          params: { organization_id: organizationPublicId },
          query: { include_total: 'true' },
        }) as never,
        mockReply(),
      );
      expect(response).toMatchObject({
        meta: {
          pagination: expect.objectContaining({ estimated_total: 1, has_more: false, next: null }),
        },
      });
    });
  });

  describe('sec-new-N1 webhookId path-param validation', () => {
    it('getWebhook rejects empty webhookId with ValidationError', async () => {
      await expect(
        controller.getWebhook(
          mockRequest({
            params: { organization_id: organizationPublicId, webhook_id: '' },
          }) as never,
          mockReply(),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('getWebhook rejects malformed webhookId with ValidationError', async () => {
      await expect(
        controller.getWebhook(
          mockRequest({
            params: { organization_id: organizationPublicId, webhook_id: 'not-a-valid-id' },
          }) as never,
          mockReply(),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('updateWebhook rejects malformed webhookId with ValidationError', async () => {
      await expect(
        controller.updateWebhook(
          mockRequest({
            params: { organization_id: organizationPublicId, webhook_id: 'bad!!id' },
            body: { enabled: false },
          }) as never,
          mockReply(),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('deleteWebhook rejects malformed webhookId with ValidationError', async () => {
      await expect(
        controller.deleteWebhook(
          mockRequest({
            params: { organization_id: organizationPublicId, webhook_id: 'INVALID' },
          }) as never,
          mockReply(),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('listDeliveryAttempts rejects malformed webhookId with ValidationError', async () => {
      await expect(
        controller.listDeliveryAttempts(
          mockRequest({
            params: { organization_id: organizationPublicId, webhook_id: '../traversal' },
            query: {},
          }) as never,
          mockReply(),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('testWebhook rejects malformed webhookId with ValidationError', async () => {
      await expect(
        controller.testWebhook(
          mockRequest({
            params: { organization_id: organizationPublicId, webhook_id: 'not valid' },
          }) as never,
          mockReply(),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('listDeliveryAttempts (cursor pagination)', () => {
    it('forwards after cursor and include_total to the service', async () => {
      await controller.listDeliveryAttempts(
        mockRequest({
          params: { organization_id: organizationPublicId, webhook_id: webhookPublicId },
          query: { after: 'cursor-attempt', limit: '50', include_total: 'true' },
        }) as never,
        mockReply(),
      );
      expect(service.listDeliveryAttempts).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: expect.objectContaining({ organizationPublicId }),
          webhook_public_id: webhookPublicId,
          after: 'cursor-attempt',
          limit: 50,
          include_total: true,
        }),
      );
    });

    it('emits next_cursor and estimated_total when service signals more pages with total', async () => {
      vi.mocked(service.listDeliveryAttempts).mockResolvedValueOnce({
        items: [
          { id: 1, status: 'SENT' },
          { id: 2, status: 'FAILED' },
        ],
        total: 10,
        limit: 2,
        has_more: true,
        next_cursor: 'opaque-attempts-2',
      } as never);
      const response = await controller.listDeliveryAttempts(
        mockRequest({
          params: { organization_id: organizationPublicId, webhook_id: webhookPublicId },
          query: { limit: '2', include_total: 'true' },
        }) as never,
        mockReply(),
      );
      expect(response).toMatchObject({
        meta: {
          pagination: expect.objectContaining({
            has_more: true,
            next: 'opaque-attempts-2',
            estimated_total: 10,
            per_page: 2,
          }),
        },
      });
    });

    it('clears next on the final page (keyset)', async () => {
      vi.mocked(service.listDeliveryAttempts).mockResolvedValueOnce({
        items: [{ id: 1, status: 'SENT' }],
        total: null,
        limit: 25,
        has_more: false,
        next_cursor: null,
      } as never);
      const response = await controller.listDeliveryAttempts(
        mockRequest({
          params: { organization_id: organizationPublicId, webhook_id: webhookPublicId },
        }) as never,
        mockReply(),
      );
      expect(response).toMatchObject({
        meta: {
          pagination: expect.objectContaining({ has_more: false, next: null }),
        },
      });
    });
  });
});
