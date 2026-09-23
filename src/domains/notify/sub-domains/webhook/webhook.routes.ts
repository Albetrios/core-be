import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
  STRICT_AUTHED_RATE_LIMIT,
} from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { rejectLegacyPagePagination } from '@/shared/utils/http/pagination.util.js';
import { NOTIFY_PERMISSIONS } from '@/domains/notify/notify.permissions.js';
import type { WebhookService } from './webhook.service.js';
import type { WebhookEventService } from './webhook-event/webhook-event.service.js';
import { createWebhookController } from './webhook.controller.js';
import { createWebhookEventController } from './webhook-event/webhook-event.controller.js';
import {
  CreateWebhookDto,
  listWebhookDeliveryAttemptsQueryDto,
  listWebhooksQueryDto,
  UpdateWebhookDto,
  webhookIdParamsDto,
} from './webhook.dto.js';

/**
 * Returns a Fastify plugin that registers the organization-scoped webhook HTTP routes (catalog,
 * list, get, create, update, delete, delivery attempts, test) plus their permission preHandlers
 * (`webhook:read` / `webhook:manage`) and rate-limit presets.
 */
export function webhookRoutes(
  webhookService: WebhookService,
  webhookEventService: WebhookEventService,
): FastifyPluginAsync {
  const webhookController = createWebhookController(webhookService);
  const webhookEventController = createWebhookEventController(webhookEventService);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    zodApplication.get(
      '/webhook-events',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(NOTIFY_PERMISSIONS.WEBHOOK_READ)],
        schema: {
          summary: 'List dispatchable webhook event types',
          description:
            "Returns the catalog of event types this platform can dispatch, so a client can build a webhook subscription list. These are event TYPES, not the organization's delivery history — for that, use GET /notify/webhooks/{webhook_id}/delivery-attempts. Requires WEBHOOK_READ permission.",
          tags: ['Webhook'],
        },
      },
      webhookEventController.listWebhookEvents,
    );
    zodApplication.get(
      '/webhooks',
      {
        schema: {
          summary: 'List webhooks',
          description:
            'Returns all configured webhooks for the organization. Requires WEBHOOK_READ permission.',
          tags: ['Webhook'],
          querystring: listWebhooksQueryDto,
        },
        onRequest: [app.authenticate],
        preValidation: [rejectLegacyPagePagination],
        preHandler: [requireOrganizationPermission(NOTIFY_PERMISSIONS.WEBHOOK_READ)],
      },
      webhookController.listWebhooks,
    );
    zodApplication.get<{ Params: { webhook_id: string } }>(
      '/webhooks/:webhook_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(NOTIFY_PERMISSIONS.WEBHOOK_READ)],
        schema: {
          summary: 'Get webhook',
          description: 'Returns a single webhook configuration. Requires WEBHOOK_READ permission.',
          tags: ['Webhook'],
          params: webhookIdParamsDto,
        },
      },
      webhookController.getWebhook,
    );
    zodApplication.post(
      '/webhooks',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(NOTIFY_PERMISSIONS.WEBHOOK_MANAGE)],
        config: { idempotencyRequired: true, ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config },
        schema: {
          summary: 'Create webhook',
          description:
            'Creates a new webhook endpoint. Specify the URL and events to subscribe to. Requires WEBHOOK_MANAGE permission.',
          tags: ['Webhook'],
          body: CreateWebhookDto,
        },
      },
      webhookController.createWebhook,
    );
    zodApplication.patch<{ Params: { webhook_id: string } }>(
      '/webhooks/:webhook_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(NOTIFY_PERMISSIONS.WEBHOOK_MANAGE)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Update webhook',
          description:
            'Updates a webhook URL, events, or enabled status. Requires WEBHOOK_MANAGE permission.',
          tags: ['Webhook'],
          params: webhookIdParamsDto,
          body: UpdateWebhookDto,
        },
      },
      webhookController.updateWebhook,
    );
    zodApplication.delete<{ Params: { webhook_id: string } }>(
      '/webhooks/:webhook_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(NOTIFY_PERMISSIONS.WEBHOOK_MANAGE)],
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Delete webhook',
          description:
            'Permanently deletes a webhook endpoint. Requires WEBHOOK_MANAGE permission.',
          tags: ['Webhook'],
          params: webhookIdParamsDto,
        },
      },
      webhookController.deleteWebhook,
    );
    zodApplication.get<{ Params: { webhook_id: string } }>(
      '/webhooks/:webhook_id/delivery-attempts',
      {
        schema: {
          summary: 'List webhook delivery attempts',
          description:
            'Returns the delivery attempt history for a webhook, including status codes and response times. Requires WEBHOOK_READ permission.',
          tags: ['Webhook'],
          params: webhookIdParamsDto,
          querystring: listWebhookDeliveryAttemptsQueryDto,
        },
        onRequest: [app.authenticate],
        preValidation: [rejectLegacyPagePagination],
        preHandler: [requireOrganizationPermission(NOTIFY_PERMISSIONS.WEBHOOK_READ)],
      },
      webhookController.listDeliveryAttempts,
    );
    zodApplication.post<{ Params: { webhook_id: string } }>(
      '/webhooks/:webhook_id/test',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(NOTIFY_PERMISSIONS.WEBHOOK_MANAGE)],
        ...STRICT_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Send test webhook',
          description:
            'Sends a test event to the webhook URL to verify connectivity. Requires WEBHOOK_MANAGE permission.',
          tags: ['Webhook'],
          params: webhookIdParamsDto,
        },
      },
      webhookController.testWebhook,
    );
  };
}
