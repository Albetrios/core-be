import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  EXPENSIVE_AUTHED_RATE_LIMIT,
  MODERATE_AUTHED_RATE_LIMIT,
} from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { GLOBAL_ROLES } from '@/shared/constants/index.js';
import { requireRole } from '@/shared/utils/auth/authorization.util.js';
import { rejectLegacyPagePagination } from '@/shared/utils/http/pagination.util.js';
import { listOrganizationsQueryDto } from '@/domains/tenancy/sub-domains/organization/organization.dto.js';
import { createUserController } from './user.controller.js';
import { createUserDataExportController } from './sub-domains/user-data-export/user-data-export.controller.js';
import { PutNotificationPreferencesDto } from './sub-domains/user-notification-preferences/user-notification-preferences.dto.js';
import { UpdateUserSettingsDto } from './sub-domains/user-settings/user-settings.dto.js';
import {
  AdminUpdateUserDto,
  dataExportIdParamsDto,
  UpdateMeDto,
  UploadAvatarDto,
  userIdParamsDto,
} from './user.dto.js';

/**
 * Fastify plugin that mounts the user domain HTTP surface: admin user management routes, the
 * `/me` self-service routes (profile, settings, notification preferences, avatar), and the GDPR
 * data-export request/status endpoints. Admin routes require the `SUPER_ADMIN` or `ADMIN` global
 * role; data-export request is rate-limited via {@link EXPENSIVE_AUTHED_RATE_LIMIT}.
 */
export const userRoutesPlugin: FastifyPluginAsync = async (app) => {
  // The caller's own organizations live at `/users/me/organizations`; the data is tenancy's, so
  // its service is injected here the same way the audit service is injected into the organization
  // routes for `/tenancy/organization/audit-logs`. Every container is composed before routes
  // register, so this is always present in production wiring.
  const controller = createUserController({
    ...app.userDomain,
    organizationService: app.tenancyDomain?.organizationService,
  });
  const dataExportController = createUserDataExportController(app.userDomain.userDataExportService);
  const zodApplication = app.withTypeProvider<ZodTypeProvider>();
  // ── Admin user routes (require admin+ role) ────────────────
  zodApplication.get(
    '/',
    {
      onRequest: [app.authenticate],
      preHandler: [requireRole(GLOBAL_ROLES.SUPER_ADMIN)],
      schema: {
        summary: 'List all users (admin)',
        description: 'Returns a paginated list of all users. Requires SUPER_ADMIN or ADMIN role.',
        tags: ['User Management'],
      },
    },
    controller.listUsers,
  );
  zodApplication.get(
    '/:user_id',
    {
      onRequest: [app.authenticate],
      preHandler: [requireRole(GLOBAL_ROLES.SUPER_ADMIN)],
      schema: {
        summary: 'Get user by ID (admin)',
        description: "Returns a specific user's profile. Requires SUPER_ADMIN or ADMIN role.",
        tags: ['User Management'],
        params: userIdParamsDto,
      },
    },
    controller.getUser,
  );
  zodApplication.patch(
    '/:user_id',
    {
      // route-#4: bound admin user-mutations so a compromised admin token cannot bulk-edit accounts.
      ...MODERATE_AUTHED_RATE_LIMIT,
      onRequest: [app.authenticate],
      preHandler: [requireRole(GLOBAL_ROLES.SUPER_ADMIN)],
      schema: {
        summary: 'Update user (admin)',
        description: "Updates a user's profile or status. Requires SUPER_ADMIN or ADMIN role.",
        tags: ['User Management'],
        params: userIdParamsDto,
        body: AdminUpdateUserDto,
      },
    },
    controller.updateUser,
  );
  zodApplication.delete(
    '/:user_id',
    {
      // route-#4: stronger bound on the destructive admin delete (matches DELETE /me).
      ...EXPENSIVE_AUTHED_RATE_LIMIT,
      onRequest: [app.authenticate],
      preHandler: [requireRole(GLOBAL_ROLES.SUPER_ADMIN)],
      schema: {
        summary: 'Delete user (admin)',
        description: 'Permanently deletes a user account. Requires SUPER_ADMIN or ADMIN role.',
        tags: ['User Management'],
        params: userIdParamsDto,
      },
    },
    controller.deleteUser,
  );
  zodApplication.post(
    '/:user_id/suspend',
    {
      ...MODERATE_AUTHED_RATE_LIMIT,
      onRequest: [app.authenticate],
      preHandler: [requireRole(GLOBAL_ROLES.SUPER_ADMIN)],
      schema: {
        summary: 'Suspend user (admin)',
        description:
          'Suspends a user account, preventing login. Requires SUPER_ADMIN or ADMIN role.',
        tags: ['User Management'],
        params: userIdParamsDto,
      },
    },
    controller.suspendUser,
  );
  zodApplication.post(
    '/:user_id/unsuspend',
    {
      ...MODERATE_AUTHED_RATE_LIMIT,
      onRequest: [app.authenticate],
      preHandler: [requireRole(GLOBAL_ROLES.SUPER_ADMIN)],
      schema: {
        summary: 'Unsuspend user (admin)',
        description: 'Reactivates a suspended user account. Requires SUPER_ADMIN or ADMIN role.',
        tags: ['User Management'],
        params: userIdParamsDto,
      },
    },
    controller.unsuspendUser,
  );

  // ── Self-service user routes (require authenticated) ───────
  zodApplication.get(
    '/me',
    {
      onRequest: [app.authenticate],
      schema: {
        summary: 'Get current user profile',
        description:
          "Returns the authenticated user's profile including name, email, avatar, and account status.",
        tags: ['User'],
      },
    },
    controller.getMe,
  );
  zodApplication.get(
    '/me/organizations',
    {
      onRequest: [app.authenticate],
      preValidation: [rejectLegacyPagePagination],
      schema: {
        summary: 'List my organizations',
        description:
          "Returns the organizations the authenticated user owns or is an active member of, newest last. Always the caller's own organizations, whatever their global role.",
        // Tagged with the owning domain, like `/tenancy/organization/audit-logs` is tagged
        // `Audit Log` — the tag follows the data, the path follows the scope.
        tags: ['Organization'],
        querystring: listOrganizationsQueryDto,
      },
    },
    controller.listMyOrganizations,
  );
  zodApplication.patch(
    '/me',
    {
      onRequest: [app.authenticate],
      // sec-r4-I1: bound profile-update writes per authenticated user — the field
      // touches PII columns and downstream notification preferences, so cap at
      // the moderate-authed tier (30 req / 60s) consistent with other authed
      // mutation paths. Unauthenticated traffic is already rejected upstream.
      ...MODERATE_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Update current user profile',
        description:
          "Updates the authenticated user's profile fields (name, avatar). Email changes require verification.",
        tags: ['User'],
        body: UpdateMeDto,
      },
    },
    controller.patchMe,
  );
  zodApplication.post(
    '/me/onboarding/complete',
    {
      onRequest: [app.authenticate],
      // Idempotent one-shot stamp on wizard finish; moderate-authed tier matches
      // the other self-service mutations.
      ...MODERATE_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Mark onboarding complete',
        description:
          "Stamps the authenticated user's onboarding as finished (idempotent) and returns the refreshed self profile. Called when the onboarding wizard is completed so subsequent sign-ins route to the dashboard.",
        tags: ['User'],
      },
    },
    controller.completeOnboardingMe,
  );
  zodApplication.delete(
    '/me',
    {
      onRequest: [app.authenticate],
      // sec-r4-I1: account self-deletion is irreversible (cascades sessions,
      // memberships, schedules retention sweep). Cap at the expensive-authed
      // tier (5 req / 5 min) so a hijacked session cannot rip through victim
      // accounts in bulk.
      ...EXPENSIVE_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Delete my account',
        description:
          "Permanently deletes the authenticated user's account and all associated data. This action is irreversible.",
        tags: ['User'],
      },
    },
    controller.deleteMe,
  );
  zodApplication.get(
    '/me/settings',
    {
      onRequest: [app.authenticate],
      schema: {
        summary: 'Get my settings',
        description:
          "Returns the authenticated user's personal settings (dark mode, language, notification preferences).",
        tags: ['User Settings'],
      },
    },
    controller.getSettings,
  );
  zodApplication.patch(
    '/me/settings',
    {
      onRequest: [app.authenticate],
      // sec-r4-I1: moderate-authed tier for self-service settings mutations so a
      // session-token holder cannot churn settings rows unbounded.
      ...MODERATE_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Update my settings',
        description: "Updates the authenticated user's personal settings.",
        tags: ['User Settings'],
        body: UpdateUserSettingsDto,
      },
    },
    controller.patchSettings,
  );
  zodApplication.get(
    '/me/notification-preferences',
    {
      onRequest: [app.authenticate],
      schema: {
        summary: 'Get my notification preferences',
        description:
          "Returns the authenticated user's notification preferences per type and channel.",
        tags: ['Notification Preferences'],
      },
    },
    controller.getNotificationPreferences,
  );
  zodApplication.put(
    '/me/notification-preferences',
    {
      onRequest: [app.authenticate],
      // sec-r4-I1: cap notification-preference replacement at the moderate-authed
      // tier — a PUT replaces the full set per call and could otherwise be looped
      // to churn rows or trigger downstream cache invalidation storms.
      ...MODERATE_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Replace notification preferences',
        description:
          'Replaces all notification preferences for the authenticated user. Sends a complete set of preferences.',
        tags: ['Notification Preferences'],
        body: PutNotificationPreferencesDto,
      },
    },
    controller.putNotificationPreferences,
  );
  zodApplication.put(
    '/me/avatar',
    {
      onRequest: [app.authenticate],
      // sec-r4-I1: each avatar upload writes to S3 and rewrites the user row;
      // cap at moderate-authed (30 req / 60s) so a hijacked session cannot
      // mint unbounded S3 objects.
      ...MODERATE_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Upload avatar',
        description: "Uploads or replaces the authenticated user's avatar image.",
        tags: ['User'],
        body: UploadAvatarDto,
      },
    },
    controller.uploadAvatar,
  );
  zodApplication.delete(
    '/me/avatar',
    {
      onRequest: [app.authenticate],
      // sec-r4-I1: avatar deletion calls S3 and rewrites the user row; same
      // moderate-authed bound as the upload counterpart.
      ...MODERATE_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Remove avatar',
        description: "Removes the authenticated user's avatar image.",
        tags: ['User'],
      },
    },
    controller.deleteAvatar,
  );

  // ── GDPR / Privacy ─────────────────────────────────────────
  zodApplication.post(
    '/me/data-export',
    {
      onRequest: [app.authenticate],
      ...EXPENSIVE_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Request GDPR data export',
        description:
          'Enqueues an async export of all personal data. Poll GET /users/me/data-export/{data_export_id} for status and a time-limited download URL (15-minute lifetime).',
        tags: ['Privacy'],
      },
    },
    dataExportController.requestExport,
  );
  zodApplication.get(
    '/me/data-export/:data_export_id',
    {
      onRequest: [app.authenticate],
      // sec-U6: every successful poll while status === COMPLETED mints a fresh
      // presigned download URL. Without a rate limit, a session-token holder
      // could spin the poll loop to mint URLs indefinitely; cap at the
      // moderate-authed tier (30 req / 60s) so the typical UI poll cadence
      // (a few seconds while the user waits) is unaffected but bulk-replay
      // mints are bounded.
      ...MODERATE_AUTHED_RATE_LIMIT,
      schema: {
        summary: 'Get GDPR data export status',
        description:
          'Returns export job status. When completed, includes a presigned download URL for the gzip JSON artifact (15-minute lifetime; every mint is audited as `user.data_export.url_minted`).',
        tags: ['Privacy'],
        params: dataExportIdParamsDto,
      },
    },
    dataExportController.getExportStatus,
  );
};
