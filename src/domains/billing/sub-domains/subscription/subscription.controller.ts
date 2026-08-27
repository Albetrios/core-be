import type { FastifyReply, FastifyRequest } from 'fastify';
import { paginatedResponse, successResponse } from '@/shared/utils/http/response.util.js';
import {
  getActingUserPublicId,
  getRequestIdentifier,
  requirePrincipal,
} from '@/shared/utils/http/request.util.js';
import { validatePublicIdParam } from '@/shared/utils/identity/public-id-param.util.js';
import type { SubscriptionService } from './subscription.service.js';
import { SubscriptionSerializer } from './subscription.serializer.js';

function readIdempotencyKey(request: FastifyRequest): string | undefined {
  return typeof request.headers['x-idempotency-key'] === 'string'
    ? request.headers['x-idempotency-key']
    : undefined;
}

/**
 * Builds organization-scoped subscription handlers (list / get / create /
 * update / change-plan / cancel / resume). The active organization is resolved
 * from the signed `org` token claim via `REQUEST_SCOPE.organization`; handlers
 * that take a `subscription_id` path param validate it (sec-B10); externally
 * mutating routes also require the `X-Idempotency-Key` header before delegating
 * to {@link SubscriptionService}.
 *
 * @remarks
 * sec-B10: every handler resolves the organization from the token claim and
 * validates `request.params.subscription_id` rather than threading it to the
 * service unchecked. Not an IDOR (the service uses an exact-match WHERE, scoped
 * by RLS to the active organization), but unbounded attacker-supplied input
 * would otherwise flow into Sentry breadcrumbs, log payloads, and route-tagged
 * metric labels — a small cardinality + content-exfiltration foot-gun.
 * Validate the subscription id at the boundary so observability cannot be poisoned.
 */
export function createSubscriptionController(service: SubscriptionService) {
  return {
    listSubscriptions: async (request: FastifyRequest, _reply: FastifyReply) => {
      requirePrincipal(request);
      const data = await service.list(request.principalScope);
      return successResponse(SubscriptionSerializer.many(data), getRequestIdentifier(request));
    },
    getSubscription: async (
      request: FastifyRequest<{ Params: { subscription_id: string } }>,
      _reply: FastifyReply,
    ) => {
      requirePrincipal(request);
      const data = await service.get(
        request.principalScope,
        validatePublicIdParam(request.params.subscription_id, 'subscription_id'),
      );
      return successResponse(SubscriptionSerializer.one(data), getRequestIdentifier(request));
    },
    createSubscription: async (request: FastifyRequest, _reply: FastifyReply) => {
      const auth = requirePrincipal(request);
      const idempotencyKey = readIdempotencyKey(request);
      const data = await service.create(
        request.principalScope,
        request.body,
        getActingUserPublicId(auth),
        idempotencyKey,
      );
      return successResponse(SubscriptionSerializer.one(data), getRequestIdentifier(request));
    },
    updateSubscription: async (
      request: FastifyRequest<{ Params: { subscription_id: string } }>,
      _reply: FastifyReply,
    ) => {
      requirePrincipal(request);
      const data = await service.update(
        request.principalScope,
        validatePublicIdParam(request.params.subscription_id, 'subscription_id'),
        request.body,
      );
      return successResponse(SubscriptionSerializer.one(data), getRequestIdentifier(request));
    },
    changePlan: async (
      request: FastifyRequest<{ Params: { subscription_id: string } }>,
      _reply: FastifyReply,
    ) => {
      requirePrincipal(request);
      const data = await service.changePlan(
        request.principalScope,
        validatePublicIdParam(request.params.subscription_id, 'subscription_id'),
        request.body,
        readIdempotencyKey(request),
      );
      return successResponse(SubscriptionSerializer.one(data), getRequestIdentifier(request));
    },
    cancelSubscription: async (
      request: FastifyRequest<{ Params: { subscription_id: string } }>,
      _reply: FastifyReply,
    ) => {
      requirePrincipal(request);
      const data = await service.cancel(
        request.principalScope,
        validatePublicIdParam(request.params.subscription_id, 'subscription_id'),
        readIdempotencyKey(request),
      );
      return successResponse(SubscriptionSerializer.one(data), getRequestIdentifier(request));
    },
    resumeSubscription: async (
      request: FastifyRequest<{ Params: { subscription_id: string } }>,
      _reply: FastifyReply,
    ) => {
      requirePrincipal(request);
      const data = await service.resume(
        request.principalScope,
        validatePublicIdParam(request.params.subscription_id, 'subscription_id'),
        readIdempotencyKey(request),
      );
      return successResponse(SubscriptionSerializer.one(data), getRequestIdentifier(request));
    },
    getPaymentSetup: async (
      request: FastifyRequest<{ Params: { subscription_id: string } }>,
      _reply: FastifyReply,
    ) => {
      requirePrincipal(request);
      const data = await service.getPaymentSetup(
        request.principalScope,
        validatePublicIdParam(request.params.subscription_id, 'subscription_id'),
      );
      return successResponse(data, getRequestIdentifier(request));
    },
    listInvoices: async (request: FastifyRequest, _reply: FastifyReply) => {
      requirePrincipal(request);
      const result = await service.listInvoices(request.principalScope, request.query);
      return paginatedResponse(result.items, getRequestIdentifier(request), {
        per_page: result.limit,
        next: result.next_cursor,
        has_more: result.has_more,
        ...(result.total !== null ? { estimated_total: result.total } : {}),
      });
    },
    listPaymentMethods: async (request: FastifyRequest, _reply: FastifyReply) => {
      requirePrincipal(request);
      const data = await service.listPaymentMethods(request.principalScope);
      return successResponse(data, getRequestIdentifier(request));
    },
    createPaymentMethodSetup: async (request: FastifyRequest, _reply: FastifyReply) => {
      requirePrincipal(request);
      const data = await service.createPaymentMethodSetup(
        request.principalScope,
        readIdempotencyKey(request),
      );
      return successResponse(data, getRequestIdentifier(request));
    },
  };
}
