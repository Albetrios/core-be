import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createStripeWebhookController } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook.controller.js';
import type { StripeWebhookService } from '@/domains/billing/sub-domains/stripe-webhook/stripe-webhook.service.js';
import { ValidationError } from '@/shared/errors/index.js';
import { attachPrincipalScope } from '@/tests/helpers/principal-scope.helper.js';

function mockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return attachPrincipalScope({
    id: 'request-id',
    ...overrides,
  }) as FastifyRequest;
}

function mockReply(): FastifyReply {
  const reply = {
    status: vi.fn().mockReturnThis(),
  };
  return reply as unknown as FastifyReply;
}

describe('createStripeWebhookController', () => {
  const ingestEvent = vi.fn().mockResolvedValue('claimed');
  const stripeWebhookService = { ingestEvent } as unknown as StripeWebhookService;
  const controller = createStripeWebhookController(stripeWebhookService);

  beforeEach(() => {
    vi.clearAllMocks();
    ingestEvent.mockResolvedValue('claimed');
  });

  it('throws when stripeWebhookEvent is missing and does not call the service', async () => {
    await expect(controller.handleWebhook(mockRequest(), mockReply())).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(ingestEvent).not.toHaveBeenCalled();
  });

  it('delegates ingestion to the service (event + request id), then ACKs Stripe with 200', async () => {
    // The controller is a thin coordinator: it extracts the verified event + request id from the
    // request and hands the durability commit + enqueue to the service (sec-B finding #6 lives in
    // StripeWebhookService.ingestEvent now). It must still ACK 200 with the acknowledgement body.
    const verifiedEvent = {
      id: 'evt_1',
      type: 'customer.subscription.updated',
      created: 1_750_000_000,
    };
    const reply = mockReply();
    const response = await controller.handleWebhook(
      mockRequest({ stripeWebhookEvent: verifiedEvent as never }),
      reply,
    );

    expect(ingestEvent).toHaveBeenCalledWith(verifiedEvent, { requestId: 'request-id' });
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(response).toMatchObject({
      data: { received: true },
      meta: { request_id: 'request-id' },
    });
  });

  it('propagates service ingestion failures so Stripe retries the delivery (no swallowing)', async () => {
    ingestEvent.mockRejectedValueOnce(new Error('redis unavailable'));
    const verifiedEvent = {
      id: 'evt_fail',
      type: 'invoice.paid',
      created: 1_750_000_000,
    };

    await expect(
      controller.handleWebhook(
        mockRequest({ stripeWebhookEvent: verifiedEvent as never }),
        mockReply(),
      ),
    ).rejects.toThrow('redis unavailable');
  });
});
