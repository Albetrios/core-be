import { env } from '@/shared/config/env.config.js';
import { ConflictError, ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import { isPostgresUniqueViolation } from '@/shared/utils/infrastructure/postgres-error.util.js';
import {
  withPrincipalDatabaseContext,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { assertTeamOrganization } from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import type { MemberRoleRepository } from './member-role.repository.js';
import type { MemberRolePermissionRepository } from './member-role-permission/member-role-permission.repository.js';
import type { MemberRoleOutput, MemberRoleRow } from './member-role.types.js';
import {
  validateCreateMemberRole,
  validateUpdateMemberRole,
  validateListMemberRolesQuery,
} from './member-role.validator.js';
import { serializeMemberRole } from './member-role.serializer.js';
import { invalidateOrganizationPermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import type { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import type { PermissionRepository } from '@/domains/tenancy/sub-domains/permission/permission.repository.js';
import { assertCallerCanGrantPermissionCodes } from '@/domains/tenancy/sub-domains/permission/assert-grantable-permissions.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { ListMemberRolesQueryInput } from './member-role.dto.js';

/**
 * Application service for the per-organization role catalog: list, get,
 * create, update, and soft-delete custom roles.
 *
 * @remarks
 * - **Algorithm:** every public method runs inside
 *   `withPrincipalDatabaseContext` and resolves the caller's
 *   organization through {@link OrganizationService.requireOrganizationRecordByPublicId}
 *   before touching the role repository, so RLS and membership checks happen
 *   before any data access.
 * - **Failure modes:** `NotFoundError('Role' | 'Organization')` when lookups
 *   miss or rows are soft-deleted; `ValidationError` (i18n) for bad input or
 *   illegal pagination. The repository's unique index on `(organization_id,
 *   name)` raises duplicate-key errors for collisions on create/update.
 * - **Side effects:** writes through `MemberRoleRepository` (insert / update /
 *   soft-delete with `deleted_at`). Deleting a role calls
 *   {@link invalidateOrganizationPermissions} so members who held it stop
 *   resolving its permissions from cache. {@link create} may optionally assign an
 *   initial permission set in the same transaction (reusing the same
 *   `assertCallerCanGrantPermissionCodes` guard as the PUT); the companion
 *   {@link MemberRolePermissionService} owns all subsequent edits to the set.
 * - **Notes:** `requireRoleRecord*` and `resolveRolePublicId*` helpers are
 *   shared with other tenancy services (membership, invitations) to keep role
 *   identity resolution in one place.
 */
export class MemberRoleService {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly memberRoleRepository: MemberRoleRepository,
    private readonly memberRolePermissionRepository: MemberRolePermissionRepository,
    private readonly authorizationService: AuthorizationService,
    private readonly permissionRepository: PermissionRepository,
  ) {}

  async list(scope: OrganizationPrincipalDatabaseScope, pagination: ListMemberRolesQueryInput) {
    const organization_public_id = scope.organizationPublicId;
    return withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
      validateListMemberRolesQuery(pagination);
      const result = await this.memberRoleRepository.findByOrganizationId(
        organization.id,
        omitUndefined({
          after: pagination.after,
          limit: pagination.limit,
          q: pagination.q,
          sort: pagination.sort,
          order: pagination.order,
        }),
      );
      // One membership aggregate (GROUP BY role_id) → member_count per role, so the roles-list
      // projection stays a single extra query instead of an N+1 across the page.
      const memberCounts = await this.memberRoleRepository.countMembersByRoleForOrganization(
        organization.id,
      );
      return {
        items: result.items.map((role) =>
          serializeMemberRole(role, memberCounts.get(role.id) ?? 0),
        ),
        limit: result.limit,
        total: result.total,
        has_more: result.has_more,
        next_cursor: result.next_cursor,
      };
    });
  }

  async requireRoleRecordForOrganization(
    organization_id: number,
    role_public_id: string,
  ): Promise<MemberRoleRow> {
    const role = await this.memberRoleRepository.findByPublicId(role_public_id, organization_id);
    if (!role) throw new NotFoundError('Role');
    return role;
  }

  async requireRoleRecordByPublicId(
    organization_public_id: string,
    role_public_id: string,
  ): Promise<MemberRoleRow> {
    const organization =
      await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
    return this.requireRoleRecordForOrganization(organization.id, role_public_id);
  }

  async resolveRolePublicIdForOrganization(
    organization_id: number,
    role_internal_id: number,
  ): Promise<string> {
    const role = await this.memberRoleRepository.findByInternalId(
      role_internal_id,
      organization_id,
    );
    if (!role) throw new NotFoundError('Role');
    return role.public_id;
  }

  async resolveRolePublicIdByInternalId(
    organization_public_id: string,
    role_internal_id: number,
  ): Promise<string> {
    const organization =
      await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
    return this.resolveRolePublicIdForOrganization(organization.id, role_internal_id);
  }

  async getByPublicId(
    scope: OrganizationPrincipalDatabaseScope,
    role_public_id: string,
  ): Promise<MemberRoleOutput> {
    const organization_public_id = scope.organizationPublicId;
    return withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
      const role = await this.memberRoleRepository.findByPublicId(role_public_id, organization.id);
      if (!role) throw new NotFoundError('Role');
      const memberCount = await this.memberRoleRepository.countMembersForRole(
        role.id,
        organization.id,
      );
      return serializeMemberRole(role, memberCount);
    });
  }

  /**
   * Translate a repository write failure into a clean conflict when it is the
   * `(organization_id, name)` unique violation, so duplicate role names surface
   * as 409 instead of an unhandled 500. Any other error is rethrown unchanged.
   */
  private mapRoleNameConflict(error: unknown, name: string | undefined): unknown {
    if (isPostgresUniqueViolation(error)) {
      return new ConflictError('errors:roleNameExists', name ? { name } : undefined);
    }
    return error;
  }

  async create(
    scope: OrganizationPrincipalDatabaseScope,
    body: unknown,
    created_by_user_public_id: string | undefined,
  ): Promise<MemberRoleOutput> {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateCreateMemberRole(body);
    return withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
      // Capability matrix: a PERSONAL organization is single-member by definition, so custom roles
      // (which exist to grant scoped permissions to OTHER members) are meaningless there. Reject —
      // role management is a TEAM-organization feature.
      assertTeamOrganization(organization, 'ROLES');
      // sec-r5-followup-ratelimit-dos-2 + audit-#8: serialize the per-org count + insert with a
      // transaction-scoped advisory lock so concurrent creates cannot both pass the same count
      // and overshoot MEMBER_ROLE_MAX_PER_ORG. The lock auto-releases at commit.
      await this.memberRoleRepository.acquireCreationQuotaLock(organization.id);
      const activeCount = await this.memberRoleRepository.countActiveByOrganization(
        organization.id,
      );
      if (activeCount >= env.MEMBER_ROLE_MAX_PER_ORG) {
        throw new ConflictError('errors:memberRoleMaxReached', {
          max: env.MEMBER_ROLE_MAX_PER_ORG,
        });
      }
      const userId =
        await this.organizationService.resolveUserInternalIdByPublicId(created_by_user_public_id);

      // When an initial permission set is requested, verify the caller may grant every code
      // BEFORE creating the role. An escalation attempt (a code the caller does not hold) or an
      // unknown code throws here, and the whole `withPrincipalDatabaseContext` transaction
      // rolls back — no half-made role. A brand-new role has no current permissions and is never
      // the owner role, so the owner-protection / removed-codes checks the PUT path runs do not apply.
      const permissionCodes = parsed.permission_codes ?? [];
      if (permissionCodes.length > 0) {
        await assertCallerCanGrantPermissionCodes({
          authorizationService: this.authorizationService,
          permissionRepository: this.permissionRepository,
          callerUserPublicId: created_by_user_public_id,
          organizationPublicId: organization_public_id,
          requestedPermissionCodes: permissionCodes,
        });
      }

      let created: MemberRoleRow;
      try {
        // sec-T3: `is_system` is intentionally omitted — the DTO no longer accepts it
        // from clients and the repository default is false. Only seeds set it (via a
        // server-side path that does not go through this service).
        created = await this.memberRoleRepository.create(
          omitUndefined({
            organization_id: organization.id,
            name: parsed.name,
            description: parsed.description,
            created_by_user_id: userId ?? null,
          }),
        );
      } catch (error) {
        throw this.mapRoleNameConflict(error, parsed.name);
      }

      // Assign the initial permission set in the SAME transaction as the insert (atomic).
      // No cache invalidation is needed — a brand-new role has no members whose resolved
      // permissions could be stale.
      if (permissionCodes.length > 0) {
        await this.memberRolePermissionRepository.replace(
          created.id,
          permissionCodes,
          userId ?? null,
        );
      }

      // A brand-new role has no memberships yet (a member cannot be assigned to a role that did
      // not exist), so member_count is definitionally 0 — no aggregate query needed.
      return serializeMemberRole(created, 0);
    });
  }

  async update(
    scope: OrganizationPrincipalDatabaseScope,
    role_public_id: string,
    body: unknown,
    updated_by_user_public_id: string | undefined,
  ): Promise<MemberRoleOutput> {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateUpdateMemberRole(body);
    return withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
      const role = await this.memberRoleRepository.findByPublicId(role_public_id, organization.id);
      if (!role) throw new NotFoundError('Role');
      // sec-T3: system roles (Admin/Member) are immutable from the API — same guard as delete.
      if (role.is_system) {
        throw new ForbiddenError('errors:cannotModifySystemRole');
      }
      const userId =
        await this.organizationService.resolveUserInternalIdByPublicId(updated_by_user_public_id);
      let updated: MemberRoleRow | null;
      try {
        updated = await this.memberRoleRepository.update(
          role_public_id,
          organization.id,
          omitUndefined(parsed),
          userId ?? null,
        );
      } catch (error) {
        throw this.mapRoleNameConflict(error, parsed.name);
      }
      if (!updated) throw new NotFoundError('Role');
      const memberCount = await this.memberRoleRepository.countMembersForRole(
        updated.id,
        organization.id,
      );
      return serializeMemberRole(updated, memberCount);
    });
  }

  /**
   * Soft-deletes a custom role.
   *
   * @remarks
   * sec-T3 guards:
   *   1. **`is_system` guard** — Admin/Member seed roles cannot be deleted from the API.
   *      Surfaces as `ForbiddenError('errors:cannotDeleteSystemRole')`.
   *   2. **Active-membership guard** — refuses to delete a role currently assigned to one
   *      or more active memberships, because the permission-resolution join filters
   *      `isNull(roles.deleted_at)` and would silently strip every member's permission
   *      set. Surfaces as `ConflictError('errors:roleHasActiveMembers')` — clients
   *      must reassign members before deleting.
   *
   * Both checks fire BEFORE the repository `softDelete` so a refused attempt leaves no
   * partial state. The is_system guard runs first so operators get the more actionable
   * "system role" message in the seeded-Admin case (which is the most common attempt).
   */
  async delete(scope: OrganizationPrincipalDatabaseScope, role_public_id: string): Promise<void> {
    const organization_public_id = scope.organizationPublicId;
    await withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
      const role = await this.memberRoleRepository.findByPublicId(role_public_id, organization.id);
      if (!role) throw new NotFoundError('Role');
      if (role.is_system) {
        throw new ForbiddenError('errors:cannotDeleteSystemRole');
      }
      // Atomic guarded delete: the "no active members?" check and the soft-delete run in ONE
      // statement (a NOT EXISTS over memberships), so a concurrent member-assignment to this role
      // cannot interleave a separate count and the delete and leave a member on a deleted role —
      // which permission resolution would then silently strip of all permissions (route-audit C2).
      // `role` was found above, so a zero-row result means active members remain (or a concurrent
      // delete) → surface the actionable conflict rather than NotFound.
      const deleted = await this.memberRoleRepository.softDeleteIfNoActiveMembers(
        role_public_id,
        organization.id,
      );
      if (!deleted) {
        throw new ConflictError('errors:roleHasActiveMembers');
      }
    });
    // sec-R11: invalidate AFTER the write transaction commits so a concurrent permission recompute
    // cannot re-cache the stale (pre-delete) set for members holding the deleted role.
    await invalidateOrganizationPermissions(organization_public_id);
  }
}
