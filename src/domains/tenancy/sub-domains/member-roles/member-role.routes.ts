import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT } from '@/shared/middlewares/rate-limit/rate-limit-presets.constants.js';
import { requireOrganizationPermission } from '@/shared/utils/auth/authorization.util.js';
import { TENANCY_PERMISSIONS } from '@/domains/tenancy/tenancy.permissions.js';
import type { MemberRoleService } from './member-role.service.js';
import type { MemberRolePermissionService } from './member-role-permission/member-role-permission.service.js';
import { createMemberRoleController } from './member-role.controller.js';
import { createMemberRolePermissionController } from './member-role-permission/member-role-permission.controller.js';
import { createMemberRoleDto, roleIdParamsDto, updateMemberRoleDto } from './member-role.dto.js';
import { putMemberRolePermissionsDto } from './member-role-permission/member-role-permission.dto.js';

/** Services required to wire the member-role and role-permission routes. */
export interface MemberRoleRoutesDeps {
  memberRoleService: MemberRoleService;
  memberRolePermissionService: MemberRolePermissionService;
}

/**
 * Fastify plugin that registers the active-organization role CRUD routes plus
 * the nested `:role_id/permissions` listing and replacement endpoints. Every
 * route requires authentication and a `ROLE_READ` or `ROLE_MANAGE` organization
 * permission resolved against the signed JWT `org` claim.
 */
export function memberRoleRoutes(deps: MemberRoleRoutesDeps): FastifyPluginAsync {
  const roleController = createMemberRoleController(deps.memberRoleService);
  const permissionController = createMemberRolePermissionController(
    deps.memberRolePermissionService,
  );

  return async (app) => {
    const zodApplication = app.withTypeProvider<ZodTypeProvider>();
    // Member Role CRUD
    zodApplication.get(
      '/organization/roles',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.ROLE_READ)],
        schema: {
          summary: 'List roles',
          description:
            'Returns all roles defined in the organization. Requires ROLE_READ permission.',
          tags: ['Role'],
        },
      },
      roleController.listRoles,
    );
    zodApplication.get<{ Params: { role_id: string } }>(
      '/organization/roles/:role_id',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.ROLE_READ)],
        schema: {
          summary: 'Get role',
          description: 'Returns a single role with its details. Requires ROLE_READ permission.',
          tags: ['Role'],
          params: roleIdParamsDto,
        },
      },
      roleController.getRole,
    );
    zodApplication.post(
      '/organization/roles',
      {
        // sec-r5-ratelimit-dos-2: per (organization, actor) cap on custom-role creation
        // so an Admin-role-holder cannot churn unbounded role rows. Parity with
        // sec-r4-I2 / sec-r4-I3 on every other organization-scoped mutation. The
        // sec-r4-D4 .limit(256) on `findByRoleId` already caps per-role read
        // memory; this caps the rate at which new rows can be created.
        config: { idempotencyRequired: true, ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT.config },
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.ROLE_MANAGE)],
        schema: {
          summary: 'Create role',
          description:
            'Creates a new custom role in the organization. Requires ROLE_MANAGE permission.',
          tags: ['Role'],
          body: createMemberRoleDto,
        },
      },
      roleController.createRole,
    );
    zodApplication.patch<{ Params: { role_id: string } }>(
      '/organization/roles/:role_id',
      {
        // R4: organization-scoped admin mutation — cap per (organization, actor).
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.ROLE_MANAGE)],
        schema: {
          summary: 'Update role',
          description:
            'Updates a role name or description. System roles cannot be modified. Requires ROLE_MANAGE permission.',
          tags: ['Role'],
          params: roleIdParamsDto,
          body: updateMemberRoleDto,
        },
      },
      roleController.updateRole,
    );
    zodApplication.delete<{ Params: { role_id: string } }>(
      '/organization/roles/:role_id',
      {
        // R4: organization-scoped admin mutation — cap per (organization, actor).
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.ROLE_MANAGE)],
        schema: {
          summary: 'Delete role',
          description:
            'Deletes a custom role. System roles cannot be deleted. Members with this role must be reassigned first. Requires ROLE_MANAGE permission.',
          tags: ['Role'],
          params: roleIdParamsDto,
        },
      },
      roleController.deleteRole,
    );

    // Member Role Permissions
    zodApplication.get<{ Params: { role_id: string } }>(
      '/organization/roles/:role_id/permissions',
      {
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.ROLE_READ)],
        schema: {
          summary: 'List role permissions',
          description: 'Returns all permissions assigned to a role. Requires ROLE_READ permission.',
          tags: ['Permission'],
          params: roleIdParamsDto,
        },
      },
      permissionController.listRolePermissions,
    );
    zodApplication.put<{ Params: { role_id: string } }>(
      '/organization/roles/:role_id/permissions',
      {
        // R4: organization-scoped admin mutation (full permission-set replace) — cap per (organization, actor).
        ...ORGANIZATION_SCOPED_AUTHED_RATE_LIMIT,
        onRequest: [app.authenticate],
        preHandler: [requireOrganizationPermission(TENANCY_PERMISSIONS.ROLE_MANAGE)],
        schema: {
          summary: 'Replace role permissions',
          description:
            'Replaces all permissions for a role with the provided set. Requires ROLE_MANAGE permission.',
          tags: ['Permission'],
          params: roleIdParamsDto,
          body: putMemberRolePermissionsDto,
        },
      },
      permissionController.putRolePermissions,
    );
  };
}
