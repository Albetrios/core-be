import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createWebhookEventController } from '@/domains/notify/sub-domains/webhook/webhook-event/webhook-event.controller.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { UnauthorizedError } from '@/shared/errors/index.js';
import type { WebhookEventService } from '@/domains/notify/sub-domains/webhook/webhook-event/webhook-event.service.js';
import { attachPrincipalScope } from '@/tests/helpers/principal-scope.helper.js';

function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return attachPrincipalScope({
    auth: { kind: 'user', userId: generatePublicId('user'), role: 'user' },
    params: { organization_id: generatePublicId('organization') },
    body: {},
    headers: {},
    id: 'request-id',
    ...overrides,
  }) as FastifyRequest;
}

function mockReply(): FastifyReply {
  return {} as FastifyReply;
}

describe('createWebhookEventController', () => {
  const eventList = [
    { event: 'subscription.updated', description: 'Subscription was updated' },
    { event: 'subscription.cancelled', description: 'Subscription was cancelled' },
  ];

  const service = {
    list: vi.fn().mockResolvedValue(eventList),
  } as unknown as WebhookEventService;

  const controller = createWebhookEventController(service);

  it('listWebhookEvents delegates to service and returns serialized events', async () => {
    const response = await controller.listWebhookEvents(mockRequest() as never, mockReply());
    expect(service.list).toHaveBeenCalledOnce();
    expect(response).toMatchObject({
      data: [
        { event: 'subscription.updated', description: 'Subscription was updated' },
        { event: 'subscription.cancelled', description: 'Subscription was cancelled' },
      ],
      meta: { request_id: 'request-id' },
    });
  });

  it('listWebhookEvents returns empty array when no events are registered', async () => {
    vi.mocked(service.list).mockResolvedValueOnce([]);
    const response = await controller.listWebhookEvents(mockRequest() as never, mockReply());
    expect(response).toMatchObject({ data: [] });
  });

  it('listWebhookEvents throws UnauthorizedError when auth is missing', async () => {
    await expect(
      controller.listWebhookEvents(mockRequest({ auth: undefined as never }) as never, mockReply()),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('listWebhookEvents propagates generic service error', async () => {
    vi.mocked(service.list).mockRejectedValueOnce(new Error('Repository failed'));
    await expect(controller.listWebhookEvents(mockRequest() as never, mockReply())).rejects.toThrow(
      'Repository failed',
    );
  });
});
