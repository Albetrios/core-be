import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createSubscriptionController } from '@/domains/billing/sub-domains/subscription/subscription.controller.js';
import { ValidationError } from '@/shared/errors/index.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';

function mockRequest(overrides: Partial<FastifyRequest> = {}): never {
  return {
    auth: { userId: generatePublicId('user'), role: 'user' },
    params: {},
    body: {},
    headers: {},
    id: 'request-id',
    ...overrides,
  } as never;
}

function mockReply(): FastifyReply {
  const reply = { code: () => reply } as unknown as FastifyReply;
  return reply;
}

describe('createSubscriptionController', () => {
  const organizationPublicId = generatePublicId('organization');
  const subscriptionPublicId = generatePublicId('subscription');
  const service = {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({ public_id: subscriptionPublicId }),
    create: vi.fn().mockResolvedValue({ public_id: subscriptionPublicId }),
    update: vi.fn().mockResolvedValue({ public_id: subscriptionPublicId }),
    changePlan: vi.fn().mockResolvedValue({ public_id: subscriptionPublicId }),
    cancel: vi.fn().mockResolvedValue({ public_id: subscriptionPublicId }),
    resume: vi.fn().mockResolvedValue({ public_id: subscriptionPublicId }),
    listInvoices: vi.fn().mockResolvedValue({
      items: [{ id: 'in_2' }],
      total: null,
      limit: 25,
      has_more: true,
      next_cursor: 'in_2',
    }),
  } as unknown as SubscriptionService;

  const controller = createSubscriptionController(service);

  it('listSubscriptions delegates to service', async () => {
    const response = await controller.listSubscriptions(
      mockRequest({ params: { organization_id: organizationPublicId } }),
      mockReply(),
    );
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ organizationPublicId }));
    expect(response).toMatchObject({ data: [] });
  });

  it('listInvoices maps the service page into a paginated envelope', async () => {
    const response = await controller.listInvoices(
      mockRequest({ params: { organization_id: organizationPublicId }, query: { limit: 25 } }),
      mockReply(),
    );
    // The Stripe cursor + limit are validated in the service; the controller forwards request.query.
    expect(service.listInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId }),
      { limit: 25 },
    );
    expect(response).toMatchObject({
      data: [{ id: 'in_2' }],
      meta: { pagination: { per_page: 25, next: 'in_2', has_more: true } },
    });
  });

  it('getSubscription delegates to service', async () => {
    await controller.getSubscription(
      mockRequest({
        params: { organization_id: organizationPublicId, subscription_id: subscriptionPublicId },
      }),
      mockReply(),
    );
    expect(service.get).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId }),
      subscriptionPublicId,
    );
  });

  it('createSubscription forwards the idempotency key to service.create', async () => {
    await controller.createSubscription(
      mockRequest({
        params: { organization_id: organizationPublicId },
        body: { plan_id: generatePublicId('plan'), billing_cycle: 'monthly' },
        headers: { 'x-idempotency-key': 'idem-key-123456789012' },
      }),
      mockReply(),
    );
    // Money-path regression: the key must reach service.create as the 4th arg — the service
    // forwards it on to Stripe as the subscription-create idempotency key, so a dropped key
    // lets a retry/double-click mint a second paid subscription. (Asserting positions 0 and 3
    // directly because the 3rd arg — acting user public id — is undefined for this mock auth.)
    const createCall = vi.mocked(service.create).mock.calls[0];
    expect(createCall?.[0]).toMatchObject({ organizationPublicId });
    expect(createCall?.[3]).toBe('idem-key-123456789012');
  });

  it('updateSubscription delegates to service', async () => {
    await controller.updateSubscription(
      mockRequest({
        params: { organization_id: organizationPublicId, subscription_id: subscriptionPublicId },
        body: { cancel_at_period_end: true },
      }),
      mockReply(),
    );
    expect(service.update).toHaveBeenCalled();
  });

  it('changePlan passes idempotency key to service', async () => {
    await controller.changePlan(
      mockRequest({
        params: { organization_id: organizationPublicId, subscription_id: subscriptionPublicId },
        body: { plan_id: generatePublicId('plan') },
        headers: { 'x-idempotency-key': 'idem-key-123456789012' },
      }),
      mockReply(),
    );
    expect(service.changePlan).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId }),
      subscriptionPublicId,
      expect.anything(),
      'idem-key-123456789012',
    );
  });

  it('cancelSubscription passes idempotency key to service', async () => {
    await controller.cancelSubscription(
      mockRequest({
        params: { organization_id: organizationPublicId, subscription_id: subscriptionPublicId },
        headers: { 'x-idempotency-key': 'idem-key-123456789012' },
      }),
      mockReply(),
    );
    expect(service.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId }),
      subscriptionPublicId,
      'idem-key-123456789012',
    );
  });

  it('resumeSubscription passes idempotency key to service', async () => {
    await controller.resumeSubscription(
      mockRequest({
        params: { organization_id: organizationPublicId, subscription_id: subscriptionPublicId },
        headers: { 'x-idempotency-key': 'idem-key-123456789012' },
      }),
      mockReply(),
    );
    expect(service.resume).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId }),
      subscriptionPublicId,
      'idem-key-123456789012',
    );
  });

  // sec-B10: every handler validated `id` but threaded `subscriptionId` raw.
  // Not an IDOR (the service uses exact-match WHERE), but attacker-controlled
  // free-form input would otherwise flow into Sentry breadcrumbs / log payloads
  // / metric labels — a small cardinality + content-exfiltration foot-gun that
  // accumulates over time. Each mutating handler must refuse a malformed
  // `subscriptionId` at the boundary, well before it can reach observability.
  describe('subscriptionId path-param validation (sec-B10)', () => {
    const malformedSubscriptionId = '‮"><script>alert(1)</script>';

    it.each([
      [
        'getSubscription',
        async () => {
          await controller.getSubscription(
            mockRequest({
              params: {
                organization_id: organizationPublicId,
                subscription_id: malformedSubscriptionId,
              },
            }),
            mockReply(),
          );
        },
      ],
      [
        'updateSubscription',
        async () => {
          await controller.updateSubscription(
            mockRequest({
              params: {
                organization_id: organizationPublicId,
                subscription_id: malformedSubscriptionId,
              },
            }),
            mockReply(),
          );
        },
      ],
      [
        'changePlan',
        async () => {
          await controller.changePlan(
            mockRequest({
              params: {
                organization_id: organizationPublicId,
                subscription_id: malformedSubscriptionId,
              },
              headers: { 'x-idempotency-key': 'idem-key-123456789012' },
            }),
            mockReply(),
          );
        },
      ],
      [
        'cancelSubscription',
        async () => {
          await controller.cancelSubscription(
            mockRequest({
              params: {
                organization_id: organizationPublicId,
                subscription_id: malformedSubscriptionId,
              },
              headers: { 'x-idempotency-key': 'idem-key-123456789012' },
            }),
            mockReply(),
          );
        },
      ],
      [
        'resumeSubscription',
        async () => {
          await controller.resumeSubscription(
            mockRequest({
              params: {
                organization_id: organizationPublicId,
                subscription_id: malformedSubscriptionId,
              },
              headers: { 'x-idempotency-key': 'idem-key-123456789012' },
            }),
            mockReply(),
          );
        },
      ],
    ])('refuses a malformed subscriptionId in %s', async (_name, invoke) => {
      await expect(invoke()).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
