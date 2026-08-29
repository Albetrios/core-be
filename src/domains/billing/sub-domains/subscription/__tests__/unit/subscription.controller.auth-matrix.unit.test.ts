import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyReply } from 'fastify';
import { createSubscriptionController } from '@/domains/billing/sub-domains/subscription/subscription.controller.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { SubscriptionService } from '@/domains/billing/sub-domains/subscription/subscription.service.js';
import { UnauthorizedError } from '@/shared/errors/index.js';
import { attachPrincipalScope } from '@/tests/helpers/principal-scope.helper.js';

const organizationPublicId = generatePublicId('organization');
const subscriptionPublicId = generatePublicId('subscription');
const planPublicId = generatePublicId('plan');

function buildRequest(overrides: Record<string, unknown> = {}): never {
  return attachPrincipalScope({
    auth: { userId: generatePublicId('user'), role: 'user' },
    params: { organization_id: organizationPublicId, subscription_id: subscriptionPublicId },
    body: {},
    headers: {},
    id: 'request-id',
    ...overrides,
  }) as never;
}

function buildReply(): FastifyReply {
  return {} as FastifyReply;
}

function buildService(): SubscriptionService {
  return {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue({ public_id: subscriptionPublicId }),
    create: vi.fn().mockResolvedValue({ public_id: subscriptionPublicId }),
    update: vi.fn().mockResolvedValue({ public_id: subscriptionPublicId }),
    changePlan: vi.fn().mockResolvedValue({ public_id: subscriptionPublicId }),
    cancel: vi.fn().mockResolvedValue({ public_id: subscriptionPublicId }),
    resume: vi.fn().mockResolvedValue({ public_id: subscriptionPublicId }),
  } as unknown as SubscriptionService;
}

describe('createSubscriptionController auth matrix', () => {
  let service: SubscriptionService;
  let controller: ReturnType<typeof createSubscriptionController>;

  beforeEach(() => {
    service = buildService();
    controller = createSubscriptionController(service);
  });

  it('createSubscription throws UnauthorizedError when request.auth is null', async () => {
    await expect(
      controller.createSubscription(
        buildRequest({
          auth: null as never,
          body: { plan_id: planPublicId, billing_cycle: 'monthly' },
        }),
        buildReply(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('updateSubscription throws UnauthorizedError when request.auth is null', async () => {
    await expect(
      controller.updateSubscription(
        buildRequest({ auth: null as never, body: { cancel_at_period_end: true } }),
        buildReply(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('cancelSubscription throws UnauthorizedError when request.auth is null', async () => {
    await expect(
      controller.cancelSubscription(buildRequest({ auth: null as never }), buildReply()),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it('resumeSubscription throws UnauthorizedError when request.auth is null', async () => {
    await expect(
      controller.resumeSubscription(buildRequest({ auth: null as never }), buildReply()),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(service.resume).not.toHaveBeenCalled();
  });

  it('changePlan throws UnauthorizedError when request.auth is null', async () => {
    await expect(
      controller.changePlan(
        buildRequest({ auth: null as never, body: { plan_id: planPublicId } }),
        buildReply(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(service.changePlan).not.toHaveBeenCalled();
  });

  it('ignores an invalid organization path param on mutating handlers — the signed claim decides', async () => {
    const request = buildRequest({
      auth: { userId: generatePublicId('user'), role: 'user', organizationPublicId },
      params: { organization_id: 'not-a-public-id', subscription_id: subscriptionPublicId },
    });
    await controller.cancelSubscription(request, buildReply());
    expect(service.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ organizationPublicId }),
      subscriptionPublicId,
      undefined,
    );
  });
});
