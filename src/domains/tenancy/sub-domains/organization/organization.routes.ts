import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  EXPENSIVE_AUTHED_RATE_LIMIT,
  ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
  STRICT_AUTHED_RATE_LIMIT,
} from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import type { OrganizationService } from './organization.service.js';
import type { OrganizationSettingsService } from './organization-settings/organization-settings.service.js';
import type { OrganizationNotificationPolicyService } from './organization-notification-policy/organization-notification-policy.service.js';
import type { AuditService } from '@/domains/audit/audit.service.js';
import { ListAuditLogsQueryDto } from '@/domains/audit/audit.dto.js';
import type { OrganizationApiKeyService } from './organization-api-key/organization-api-key.service.js';
import { createOrganizationController } from './organization.controller.js';
import { createOrganizationApiKeyController } from './organization-api-key/organization-api-key.controller.js';
import { createOrganizationSettingsController } from './organization-settings/organization-settings.controller.js';
import { createOrganizationNotificationPolicyController } from './organization-notification-policy/organization-notification-policy.controller.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { rejectLegacyPagePagination } from '@/shared/utils/http/pagination.util.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import { AUDIT_PERMISSIONS } from '@/domains/audit/audit.permissions.js';
import {
  createOrganizationDto,
  listOrganizationsQueryDto,
  organizationSlugParamsDto,
  updateOrganizationDto,
  uploadLogoDto,
} from './organization.dto.js';
import { updateOrganizationSettingsDto } from './organization-settings/organization-settings.dto.js';
import {
  apiKeyIdParamsDto,
  createOrganizationApiKeyDto,
  listOrganizationApiKeysQueryDto,
  updateOrganizationApiKeyDto,
} from './organization-api-key/organization-api-key.dto.js';
import {
  createOrganizationNotificationPolicyDto,
  notificationPolicyIdParamsDto,
  updateOrganizationNotificationPolicyDto,
} from './organization-notification-policy/organization-notification-policy.dto.js';

/**
 * Service collaborators required by the organization routes plugin. Includes
 * the four organization-scoped services plus the optional audit service used
 * by the `/organization/audit-logs` endpoint.
 */
export interface OrganizationRoutesDeps {
  organizationService: OrganizationService;
  organizationSettingsService: OrganizationSettingsService;
  organizationNotificationPolicyService: OrganizationNotificationPolicyService;
  organizationApiKeyService: OrganizationApiKeyService;
  auditService?: AuditService;
}

/**
 * Returns the Fastify plugin that mounts every organization endpoint —
 * organization CRUD, logo upload/delete, audit-log listing, settings,
 * API keys (CRUD + rotate), and notification policies. Each route is wired
 * with auth, the right `requireOrganizationPermission` preHandler, and Zod
 * schemas (which the OpenAPI generator consumes for tags and summaries).
 */
export function organizationRoutes(deps: OrganizationRoutesDeps): FastifyPluginAsync {
  const organizationController = createOrganizationController(
    deps.organizationService,
    deps.auditService,
  );
  const settingsController = createOrganizationSettingsController(deps.organizationSettingsService);
  const notificationPolicyController = createOrganizationNotificationPolicyController(
    deps.organizationNotificationPolicyService,
  );
  const apiKeyController = createOrganizationApiKeyController(deps.organizationApiKeyService);

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    // Organization CRUD.
    // The caller's own organizations are NOT listed here: that is `GET /users/me/organizations`,
    // registered by the user domain. The collection root stays free for the admin "every
    // organization" listing, matching `GET /users` and `GET /audit/logs` — collection root is the
    // admin view, the caller's own view hangs off `/users/me`.
    zodApplication.get(
      '/organization',
      {
        schema: {
          summary: 'Get active organization',
          description: 'Returns organization details including name, slug, status, and logo.',
          tags: ['Organization'],
        },
        onRequest: [app.authenticate],
      },
      organizationController.getOrganization,
    );
    zodApplication.get(
      '/organizations/by-slug/:slug',
      {
        schema: {
          summary: 'Get organization by slug',
          description: 'Looks up an organization by its unique URL-friendly slug.',
          tags: ['Organization'],
          params: organizationSlugParamsDto,
        },
        onRequest: [app.authenticate],
      },
      organizationController.getOrganizationBySlug,
    );
    zodApplication.post(
      '/organizations',
      {
        // sec-new-M1: add STRICT_AUTHED_RATE_LIMIT (10 req/60s per user) — organization creation is a
        // high-value mutation (provisions DB rows, mints memberships, charges billing);
        // without a cap an authenticated user could flood the endpoint. Merge rateLimit
        // into the existing config object rather than spreading STRICT_AUTHED_RATE_LIMIT at
        // the top level to preserve idempotencyRequired alongside the rate-limit config.
        config: { idempotencyRequired: true, ...STRICT_AUTHED_RATE_LIMIT.config },
        schema: {
          summary: 'Create organization',
          description:
            'Creates a new organization. The authenticated user becomes the owner automatically.',
          tags: ['Organization'],
          body: createOrganizationDto,
        },
        onRequest: [app.authenticate],
      },
      organizationController.createOrganization,
    );
    zodApplication.patch(
      '/organization',
      {
        // sec-r4-I2: organization-scoped mutation — cap per (organization, actor) so a
        // single member cannot churn organization metadata in a loop or starve
        // siblings, and a cross-tenant probe cannot exhaust the victim's bucket.
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Update organization',
          description:
            'Updates organization details (name, slug, status, logo). Requires ORGANIZATION_UPDATE permission.',
          tags: ['Organization'],
          body: updateOrganizationDto,
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.ORGANIZATION_UPDATE)],
      },
      organizationController.updateOrganization,
    );
    zodApplication.delete(
      '/organization',
      {
        // sec-r4-I2: organization deletion is irreversible (cascades members,
        // subscriptions, audit logs, storage objects). Cap at the expensive-authed
        // tier (5 req / 5 min keyed by actor) so a hijacked session cannot bulk
        // delete tenants. The keyGenerator is user-scoped (not organization-scoped) since
        // a delete burst targets multiple organizations by definition.
        ...EXPENSIVE_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Delete organization',
          description:
            'Permanently deletes an organization and all its data. Requires ORGANIZATION_DELETE permission. This action is irreversible.',
          tags: ['Organization'],
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.ORGANIZATION_DELETE)],
      },
      organizationController.deleteOrganization,
    );

    // Organization Logo
    zodApplication.put(
      '/organization/logo',
      {
        // sec-r4-I2: logo upload writes to S3 and rewrites the organization row; cap at
        // the organization-scoped tier so a hijacked session cannot mint unbounded
        // storage objects for one tenant.
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Upload organization logo',
          description:
            'Uploads or replaces the organization logo. Requires ORGANIZATION_UPDATE permission.',
          tags: ['Organization'],
          body: uploadLogoDto,
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.ORGANIZATION_UPDATE)],
      },
      organizationController.uploadLogo,
    );
    zodApplication.delete(
      '/organization/logo',
      {
        // sec-r4-I2: same organization-scoped tier as upload — each call deletes an S3
        // object and rewrites the organization row.
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.ORGANIZATION_UPDATE)],
        schema: {
          summary: 'Remove organization logo',
          description: 'Removes the organization logo. Requires ORGANIZATION_UPDATE permission.',
          tags: ['Organization'],
        },
      },
      organizationController.deleteLogo,
    );

    // Organization Audit Logs
    zodApplication.get(
      '/organization/audit-logs',
      {
        schema: {
          summary: 'List organization audit logs',
          description:
            'Returns a paginated list of audit log entries for the organization. Requires AUDIT_LOG_READ permission.',
          tags: ['Audit Log'],
          querystring: ListAuditLogsQueryDto,
        },
        onRequest: [app.authenticate],
        preValidation: [rejectLegacyPagePagination],
        preHandler: [requireOrganizationPermission(AUDIT_PERMISSIONS.AUDIT_LOG_READ)],
      },
      organizationController.listOrganizationAuditLogs,
    );

    // Organization Settings
    zodApplication.get(
      '/organization/settings',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.ORGANIZATION_READ)],
        schema: {
          summary: 'Get organization settings',
          description:
            'Returns the organization settings (email notifications, security policy). Requires ORGANIZATION_READ permission.',
          tags: ['Organization Settings'],
        },
      },
      settingsController.getSettings,
    );
    zodApplication.patch(
      '/organization/settings',
      {
        // sec-r4-I2: organization-scoped settings mutation — bound per (organization, actor) so
        // policy churn or notification-config flapping cannot loop unbounded.
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Update organization settings',
          description: 'Updates organization settings. Requires ORGANIZATION_UPDATE permission.',
          tags: ['Organization Settings'],
          body: updateOrganizationSettingsDto,
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.ORGANIZATION_UPDATE)],
      },
      settingsController.updateSettings,
    );

    // Organization API Keys
    zodApplication.get(
      '/organization/api-keys',
      {
        schema: {
          summary: 'List API keys',
          description:
            'Returns all API keys for the organization. The key value is masked after creation. Requires API_KEY_READ permission.',
          tags: ['API Key'],
          querystring: listOrganizationApiKeysQueryDto,
        },
        onRequest: [app.authenticate],
        preValidation: [rejectLegacyPagePagination],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.API_KEY_READ)],
      },
      apiKeyController.listApiKeys,
    );
    zodApplication.get<{ Params: { api_key_id: string } }>(
      '/organization/api-keys/:api_key_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.API_KEY_READ)],
        schema: {
          summary: 'Get API key',
          description: 'Returns a single API key by ID. Requires API_KEY_READ permission.',
          tags: ['API Key'],
          params: apiKeyIdParamsDto,
        },
      },
      apiKeyController.getApiKey,
    );
    zodApplication.post(
      '/organization/api-keys',
      {
        // sec-r5-ratelimit-dos-1: per (organization, actor) cap on API key creation so a
        // single Admin role-holder (or a hijacked session for one) cannot churn
        // unbounded API key rows. Parity with sec-r4-I2 / sec-r4-I3 on every
        // other organization-scoped mutation.
        config: { idempotencyRequired: true, ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config },
        schema: {
          summary: 'Create API key',
          description:
            'Creates a new API key. The full key value is only returned once in the creation response. Requires a user principal with API_KEY_MANAGE permission.',
          tags: ['API Key'],
          body: createOrganizationApiKeyDto,
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.API_KEY_MANAGE)],
      },
      apiKeyController.createApiKey,
    );
    zodApplication.patch<{ Params: { api_key_id: string } }>(
      '/organization/api-keys/:api_key_id',
      {
        // R4: organization-scoped admin mutation — cap per (organization, actor).
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Update API key',
          description: 'Updates an API key (name or status). Requires API_KEY_MANAGE permission.',
          tags: ['API Key'],
          params: apiKeyIdParamsDto,
          body: updateOrganizationApiKeyDto,
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.API_KEY_MANAGE)],
      },
      apiKeyController.updateApiKey,
    );
    zodApplication.delete<{ Params: { api_key_id: string } }>(
      '/organization/api-keys/:api_key_id',
      {
        // R4: organization-scoped admin mutation — cap per (organization, actor).
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.API_KEY_MANAGE)],
        schema: {
          summary: 'Delete API key',
          description: 'Permanently deletes an API key. Requires API_KEY_MANAGE permission.',
          tags: ['API Key'],
          params: apiKeyIdParamsDto,
        },
      },
      apiKeyController.deleteApiKey,
    );
    zodApplication.post<{ Params: { api_key_id: string } }>(
      '/organization/api-keys/:api_key_id/rotate',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.API_KEY_MANAGE)],
        ...STRICT_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Rotate API key',
          description:
            'Regenerates the API key secret. The old key is immediately invalidated. Requires a user principal with API_KEY_MANAGE permission.',
          tags: ['API Key'],
          params: apiKeyIdParamsDto,
        },
      },
      apiKeyController.rotateApiKey,
    );

    // Organization Notification Policies
    zodApplication.get(
      '/organization/notification-policies',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.NOTIFICATION_POLICY_READ)],
        schema: {
          summary: 'List notification policies',
          description:
            'Returns all notification policies for the organization. Requires NOTIFICATION_POLICY_READ permission.',
          tags: ['Notification Policy'],
        },
      },
      notificationPolicyController.listPolicies,
    );
    zodApplication.get<{ Params: { notification_policy_id: string } }>(
      '/organization/notification-policies/:notification_policy_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.NOTIFICATION_POLICY_READ)],
        schema: {
          summary: 'Get notification policy',
          description:
            'Returns a single notification policy. Requires NOTIFICATION_POLICY_READ permission.',
          tags: ['Notification Policy'],
          params: notificationPolicyIdParamsDto,
        },
      },
      notificationPolicyController.getPolicy,
    );
    zodApplication.post(
      '/organization/notification-policies',
      {
        // sec-r5-ratelimit-dos-3: per (organization, actor) cap on notification-policy
        // creation. The `notification_type` field is free-form varchar(50)
        // with no enum constraint and no per-organization row cap, so without this
        // limiter an Admin-role-holder could churn policies and flap
        // downstream notification routing. Parity with sec-r4-I2.
        config: { idempotencyRequired: true, ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config },
        schema: {
          summary: 'Create notification policy',
          description:
            'Creates a new notification policy defining how a notification type is delivered. Requires NOTIFICATION_POLICY_MANAGE permission.',
          tags: ['Notification Policy'],
          body: createOrganizationNotificationPolicyDto,
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.NOTIFICATION_POLICY_MANAGE)],
      },
      notificationPolicyController.createPolicy,
    );
    zodApplication.patch<{ Params: { notification_policy_id: string } }>(
      '/organization/notification-policies/:notification_policy_id',
      {
        // R4: organization-scoped admin mutation — cap per (organization, actor).
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        schema: {
          summary: 'Update notification policy',
          description:
            'Updates a notification policy. Requires NOTIFICATION_POLICY_MANAGE permission.',
          tags: ['Notification Policy'],
          params: notificationPolicyIdParamsDto,
          body: updateOrganizationNotificationPolicyDto,
        },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.NOTIFICATION_POLICY_MANAGE)],
      },
      notificationPolicyController.updatePolicy,
    );
    zodApplication.delete<{ Params: { notification_policy_id: string } }>(
      '/organization/notification-policies/:notification_policy_id',
      {
        // R4: organization-scoped admin mutation — cap per (organization, actor).
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.NOTIFICATION_POLICY_MANAGE)],
        schema: {
          summary: 'Delete notification policy',
          description:
            'Deletes a notification policy. Requires NOTIFICATION_POLICY_MANAGE permission.',
          tags: ['Notification Policy'],
          params: notificationPolicyIdParamsDto,
        },
      },
      notificationPolicyController.deletePolicy,
    );
  };
}
