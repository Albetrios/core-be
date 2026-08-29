import type { FastifyPluginAsync } from 'fastify';
import { organizationRoutes } from './sub-domains/organization/organization.routes.js';
import { membershipRoutes } from './sub-domains/membership/membership.routes.js';
import { memberRoleRoutes } from './sub-domains/member-roles/member-role.routes.js';
import { permissionRoutes } from './sub-domains/permission/permission.routes.js';

/**
 * Top-level tenancy domain plugin — registers the organization, membership,
 * member-role, and permission sub-domain route trees against
 * `app.tenancyDomain` (and `app.auditDomain` for organization audit-log listings).
 * Mounted by `src/routes.ts` under the public API prefix.
 */
export const tenancyRoutesPlugin: FastifyPluginAsync = async (app) => {
  const { tenancyDomain, auditDomain } = app;

  await app.register(
    organizationRoutes({
      organizationService: tenancyDomain.organizationService,
      organizationSettingsService: tenancyDomain.organizationSettingsService,
      organizationNotificationPolicyService: tenancyDomain.organizationNotificationPolicyService,
      organizationApiKeyService: tenancyDomain.organizationApiKeyService,
      auditService: auditDomain.auditService,
    }),
  );
  await app.register(
    membershipRoutes({
      membershipService: tenancyDomain.membershipService,
      memberInvitationService: tenancyDomain.memberInvitationService,
    }),
  );
  await app.register(
    memberRoleRoutes({
      memberRoleService: tenancyDomain.memberRoleService,
      memberRolePermissionService: tenancyDomain.memberRolePermissionService,
    }),
  );
  await app.register(permissionRoutes({ permissionService: tenancyDomain.permissionService }));
};
