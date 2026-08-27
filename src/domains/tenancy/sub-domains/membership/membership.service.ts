import {
  ConfigurationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/shared/errors/index.js';
import { isPostgresUniqueViolation } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { isDisposableEmailBlocked } from '@/shared/utils/text/email.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import {
  withPrincipalDatabaseContext,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  acquireResourceQuotaLock,
  RESOURCE_QUOTA_LOCK_NAMESPACE,
} from '@/infrastructure/database/resource-quota-lock.util.js';
import type { UserSettingsService } from '@/domains/user/sub-domains/user-settings/user-settings.service.js';
import {
  isFactoryDefaultUserLocaleSettings,
  preferredLocalesForOrganizationDefaultLocale,
} from '@/domains/user/sub-domains/user-settings/user-settings-locale-defaults.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { assertTeamOrganization } from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import type { OrganizationSettingsService } from '@/domains/tenancy/sub-domains/organization/organization-settings/organization-settings.service.js';
import type { MemberRoleService } from '@/domains/tenancy/sub-domains/member-roles/member-role.service.js';
import type { MemberRolePermissionService } from '@/domains/tenancy/sub-domains/member-roles/member-role-permission/member-role-permission.service.js';
import type { AuthorizationService } from '@/domains/tenancy/sub-domains/permission/authorization.service.js';
import type { PermissionRepository } from '@/domains/tenancy/sub-domains/permission/permission.repository.js';
import { assertCallerCanGrantPermissionCodes } from '@/domains/tenancy/sub-domains/permission/assert-grantable-permissions.util.js';
import type { MembershipRepository } from './membership.repository.js';
import type {
  MembershipOutput,
  MembershipRoleSummary,
  MembershipRow,
  MembershipUserSummary,
} from './membership.types.js';
import {
  validateCreateMembership,
  validateUpdateMembership,
  validateListMembershipsQuery,
  validateTransferOwnership,
} from './membership.validator.js';
import { serializeMembership } from './membership.serializer.js';
import { resolveStoredMediaReadUrl } from '@/shared/utils/infrastructure/media-url.util.js';
import type { ObjectStoragePort } from '@/infrastructure/storage/object-storage.port.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { MemberInvitationService } from './member-invitation/member-invitation.service.js';
import { invalidatePermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import type { OrganizationApiKeyRepository } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.repository.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  resolveVerifiedOrganizationPrincipalScope,
  resolveVerifiedUserPrincipalScope,
} from '@/shared/utils/identity/verified-principal-scope.util.js';

/**
 * Cross-domain port for REQ-4 seat enforcement and Stripe seat reconciliation, satisfied by
 * billing's `SubscriptionService`.
 *
 * @remarks
 * - **Algorithm:** declared as a minimal structural interface (not a `SubscriptionService` import)
 *   so tenancy does not depend on billing — billing already depends on tenancy, so importing the
 *   concrete service here would create a cycle. The composition root late-wires the concrete
 *   service in via {@link MembershipService.wireSeatEnforcement}.
 * - **Failure modes:** `reserveSeatCeilingForMemberAdd` returns `null` (no ceiling) when the org has
 *   no active subscription or the plan is unlimited; the implementer takes a row lock so concurrent
 *   adds serialize. `enqueueSeatQuantitySync` is best-effort (swallows enqueue failures).
 * - **Side effects:** the implementer acquires a `FOR UPDATE` lock (reserve) / enqueues a job (sync).
 */
export type MembershipSeatEnforcementPort = {
  reserveSeatCeilingForMemberAdd(organizationId: number): Promise<number | null>;
  enqueueSeatQuantitySync(organizationPublicId: string, idempotencyKey?: string): void;
};

/**
 * HTTP response shape for `GET
 * /organization/memberships/:membership_id/permissions` — the resolved
 * permission codes for the membership's current role.
 *
 * @remarks
 * - **Algorithm:** computed by joining `memberships -> roles ->
 *   role_permissions` for the requested membership and projecting only the
 *   `permission_code` column.
 * - **Failure modes:** carries no state of its own; producers raise
 *   `NotFoundError('Membership')` when the membership cannot be resolved.
 * - **Side effects:** none — this is a plain DTO.
 * - **Notes:** identifies the membership by public id; codes are flat strings
 *   matching the entries in `tenancy.permissions`.
 */
export interface MembershipPermissionsOutput {
  permissions: string[];
}

/**
 * Application service for organization memberships: list/get/create/update/
 * delete, plus self-service `leaveOrganization` and `transferOwnership`.
 *
 * @remarks
 * - **Algorithm:** every public method runs inside
 *   {@link withOrganizationDatabaseContext} and resolves the caller's
 *   organization through
 *   {@link OrganizationService.requireOrganizationRecordByPublicId}
 *   before touching the membership repository. `transferOwnership` is
 *   delegated to {@link OrganizationService.transferOrganizationOwnership} so
 *   the `owner_user_id` flip and the membership update happen atomically.
 *   When a brand-new member is created, the service also pushes the
 *   organization's default locale onto the new user via
 *   {@link UserSettingsService.update} if the user is still on factory-default
 *   locale settings.
 * - **Failure modes:** `NotFoundError('Membership' | 'Organization' | 'Role' |
 *   'User')` for missing rows; `ForbiddenError('errors:ownerCannotLeave')`
 *   when the org owner tries to leave;
 *   `ForbiddenError('errors:onlyOwnerCanTransfer')` for non-owner ownership
 *   transfers;
 *   `ForbiddenError('errors:membershipActivationRequiresInvitationAccept')`
 *   when a PATCH tries to flip a never-joined membership to `ACTIVE` (initial
 *   activation must come from invitation acceptance);
 *   `ValidationError` from Zod-backed validators.
 * - **Side effects:** writes through `MembershipRepository` (insert / update /
 *   soft-delete with `deleted_at`); calls {@link invalidatePermissions} after
 *   every membership mutation that changes effective permissions (create,
 *   update, delete, leave) so the affected user's Redis permission cache is
 *   purged immediately instead of lingering for the cache TTL; updates
 *   {@link UserSettingsService} for locale defaults.
 * - **Notes:** `getPermissions` reads through
 *   {@link MemberRolePermissionService.listPermissionCodesForRole} so role
 *   permissions remain a single source of truth.
 */
export class MembershipService {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly memberRoleService: MemberRoleService,
    private readonly memberRolePermissionService: MemberRolePermissionService,
    private readonly membershipRepository: MembershipRepository,
    private readonly authorizationService: AuthorizationService,
    private readonly permissionRepository: PermissionRepository,
    private readonly organizationSettingsService?: OrganizationSettingsService,
    private readonly userSettingsService?: UserSettingsService,
    // reaudit-#7: optional so minimal test harnesses can omit it; the container always wires it.
    private readonly organizationApiKeyRepository?: OrganizationApiKeyRepository,
    // REQ-2: presigns the embedded member `avatar_url`; optional so minimal harnesses can omit it
    // (then the raw stored key is passed through). The container always wires the S3 adapter.
    private readonly objectStorage?: ObjectStoragePort,
    // REQ-1: add-member-by-email provisions/finds the invitee and issues the invitation. Optional so
    // minimal harnesses can omit them; the container always wires both. `create` requires them.
    private readonly userService?: UserService,
    private readonly memberInvitationService?: MemberInvitationService,
  ) {}

  /**
   * REQ-4 seat enforcement + Stripe seat-sync port, late-wired by the composition root.
   *
   * @remarks
   * billing's `SubscriptionService` (which enforces the seat ceiling and enqueues the Stripe
   * quantity sync) itself depends on tenancy for `seats_used`, so the membership↔subscription
   * relationship is a true cycle. It is broken by constructing both services, then setting this
   * field via {@link MembershipService.wireSeatEnforcement} — never a constructor param. Left
   * `null` in minimal test harnesses, where seat enforcement is simply skipped.
   */
  private seatEnforcement: MembershipSeatEnforcementPort | null = null;

  /** Late-wires the billing seat-enforcement port (REQ-4); see {@link seatEnforcement}. */
  wireSeatEnforcement(seatEnforcement: MembershipSeatEnforcementPort): void {
    this.seatEnforcement = seatEnforcement;
  }

  /**
   * Revokes every API key the departing member created in this organization (reaudit-#7), so a
   * removed/left member's keys lose access along with their session. Runs inside the caller's
   * organization DB context (RLS-scoped). Best-effort: skipped when the api-key repository is not
   * wired (minimal test harness).
   */
  private async revokeApiKeysForDepartedMember(
    userId: number,
    organizationId: number,
  ): Promise<void> {
    if (!this.organizationApiKeyRepository) return;
    await this.organizationApiKeyRepository.revokeAllByCreatorInOrganization(
      organizationId,
      userId,
    );
  }

  /**
   * Enforces the plan seat limit before a member is added (REQ-4). MUST run inside the org
   * transaction so the advisory lock (and the billing port's FOR UPDATE, when a subscription
   * exists) serializes concurrent adds. No-op when the seat-enforcement port is unwired (minimal
   * harness) or when the plan grants unlimited seats (`ceiling === null`). Throws
   * `ConflictError('errors:seatLimitReached')` with reason `seat_limit_reached` once
   * `used >= ceiling` (a seat is consumed by ACTIVE + INVITED memberships, so an outstanding invite
   * already counts and a burst of invites cannot overshoot the limit).
   *
   * @remarks
   * audit-#M1: the FOR UPDATE row lock only exists when the org has an ACTIVE subscription. On the
   * free-tier / no-subscription branch the ceiling is a catalog value with no row to lock, so two
   * concurrent adds could both pass `used < ceiling` and overshoot a plan with `included_seats > 1`.
   * A per-org advisory xact lock (`MEMBERSHIP_SEAT`) taken up front serializes the count+insert on
   * BOTH paths, independent of whether the free ceiling happens to be 1.
   */
  private async assertSeatAvailableForMemberAdd(organizationInternalId: number): Promise<void> {
    if (!this.seatEnforcement) return;
    // Serialize concurrent member-adds for this org before the count so the free-tier path (no
    // FOR UPDATE row to lock) cannot race two inserts past the ceiling. Auto-released at COMMIT.
    await acquireResourceQuotaLock(
      RESOURCE_QUOTA_LOCK_NAMESPACE.MEMBERSHIP_SEAT,
      organizationInternalId,
    );
    const seatCeiling =
      await this.seatEnforcement.reserveSeatCeilingForMemberAdd(organizationInternalId);
    if (seatCeiling === null) return;
    const seatsUsed =
      await this.membershipRepository.countActiveByOrganization(organizationInternalId);
    if (seatsUsed >= seatCeiling) {
      throw new ConflictError('errors:seatLimitReached', {
        used: seatsUsed,
        limit: seatCeiling,
      }).withReason('seat_limit_reached');
    }
  }

  /**
   * Best-effort enqueue of a Stripe seat-quantity reconciliation after a member add/remove (REQ-4).
   * Swallows when the port is unwired; the billing port itself swallows enqueue failures so member
   * management never fails on a Redis blip.
   */
  private enqueueSeatQuantitySync(organizationPublicId: string): void {
    if (!this.seatEnforcement) return;
    try {
      this.seatEnforcement.enqueueSeatQuantitySync(organizationPublicId);
    } catch (error) {
      logger.warn({ error, organizationPublicId }, 'membership.seat_sync.enqueue_failed');
    }
  }

  private async invalidatePermissionsForMembership(
    user_internal_id: number,
    organization_public_id: string,
  ): Promise<void> {
    const userPublicId =
      await this.organizationService.resolveUserPublicIdByInternalId(user_internal_id);
    if (userPublicId) {
      await invalidatePermissions(userPublicId, organization_public_id);
    }
  }

  private async applyOrganizationLocaleDefaults(
    userPublicId: string,
    organizationPublicId: string,
  ): Promise<void> {
    if (!(this.organizationSettingsService && this.userSettingsService)) return;
    const currentSettings = await this.userSettingsService.getForInvitedUser(userPublicId);
    if (!isFactoryDefaultUserLocaleSettings(currentSettings)) return;
    const defaultLocale =
      await this.organizationSettingsService.resolveDefaultLocaleForOrganization(
        organizationPublicId,
      );
    await this.userSettingsService.updateForInvitedUser(userPublicId, {
      language: defaultLocale,
      preferred_locales: preferredLocalesForOrganizationDefaultLocale(defaultLocale),
    });
  }

  /**
   * Resolves user + role summaries (and the live invitation for `INVITED` rows) for a page of
   * memberships and serializes them. The internal `user_id`/`role_id` are never emitted; user
   * summaries go through the SECURITY DEFINER resolver (auth.users is FORCE RLS and unreachable by a
   * plain join under org-only context), and each distinct avatar key is presigned for read.
   */
  private async serializeMemberships(
    rows: MembershipRow[],
    organization_public_id: string,
  ): Promise<MembershipOutput[]> {
    if (rows.length === 0) return [];
    const [userSummaryRows, roleSummaryRows, invitationRows] = await Promise.all([
      this.membershipRepository.resolveUserSummariesByInternalIds(rows.map((row) => row.user_id)),
      this.membershipRepository.resolveRoleSummariesByInternalIds(rows.map((row) => row.role_id)),
      this.membershipRepository.resolveLiveInvitationsByMembershipIds(
        rows.filter((row) => row.status === 'INVITED').map((row) => row.id),
      ),
    ]);
    const userSummaries = new Map<number, MembershipUserSummary>();
    for (const [userInternalId, row] of userSummaryRows) {
      userSummaries.set(userInternalId, {
        id: row.public_id,
        email: row.email,
        first_name: row.first_name,
        last_name: row.last_name,
        // Presign the raw avatar key for read (network-free signature); pass through when no
        // object-storage adapter is wired (minimal test harness).
        avatar_url: this.objectStorage
          ? await resolveStoredMediaReadUrl(this.objectStorage, row.avatar_url)
          : row.avatar_url,
      });
    }
    return rows.map((row) => {
      const user: MembershipUserSummary = userSummaries.get(row.user_id) ?? {
        id: String(row.user_id),
        email: '',
        first_name: null,
        last_name: null,
        avatar_url: null,
      };
      const roleRow = roleSummaryRows.get(row.role_id);
      const role: MembershipRoleSummary = roleRow
        ? { id: roleRow.public_id, name: roleRow.name }
        : { id: String(row.role_id), name: '' };
      return serializeMembership(
        row,
        organization_public_id,
        user,
        role,
        invitationRows.get(row.id) ?? null,
      );
    });
  }

  private async resolveAndSerializeMembership(
    membership: MembershipRow,
    organization_public_id: string,
  ): Promise<MembershipOutput> {
    const [output] = await this.serializeMemberships([membership], organization_public_id);
    return output!;
  }

  async list(scope: OrganizationPrincipalDatabaseScope, query: unknown) {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateListMembershipsQuery(query);
    return withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
      const result = await this.membershipRepository.findByOrganizationId(
        organization.id,
        omitUndefined({
          after: parsed.after,
          limit: parsed.limit,
          q: parsed.q,
          sort: parsed.sort,
          order: parsed.order,
        }),
      );
      return {
        ...result,
        // Batch-resolve user + role summaries + live invitations for the page (no N+1).
        items: await this.serializeMemberships(result.items, organization_public_id),
      };
    });
  }

  async getByPublicId(
    scope: OrganizationPrincipalDatabaseScope,
    membership_public_id: string,
  ): Promise<MembershipOutput> {
    const organization_public_id = scope.organizationPublicId;
    return withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
      const membership = await this.membershipRepository.findByPublicId(
        membership_public_id,
        organization.id,
      );
      if (!membership) throw new NotFoundError('Membership');
      return this.resolveAndSerializeMembership(membership, organization_public_id);
    });
  }

  async create(
    scope: OrganizationPrincipalDatabaseScope,
    body: unknown,
    invited_by_user_public_id: string | undefined,
    options?: { requestId?: string },
  ): Promise<MembershipOutput> {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateCreateMembership(body);
    const userService = this.userService;
    const memberInvitationService = this.memberInvitationService;
    if (!(userService && memberInvitationService)) {
      throw new ConfigurationError(
        'UserService and MemberInvitationService must be wired on MembershipService (tenancy.container).',
      );
    }
    // Block disposable invitee addresses up front (no DB/context needed) — mirrors the prior
    // invitation-create guard now that the email enters at the membership door.
    if (isDisposableEmailBlocked(parsed.email)) {
      throw new ValidationError('errors:disposableEmail', undefined, undefined, [
        { field: 'email', messageKey: 'errors:disposableEmail' },
      ]).withReason('disposable_email');
    }
    // Provision/find the invitee in its OWN transaction (BEFORE the org context) so the public-id
    // collision retry can open fresh transactions — a pinned org transaction would abort on retry.
    // A user left with no membership by a later failure is harmless and reused on the next attempt.
    const inviteeUser = await userService.findOrCreateInvitedByEmail({
      email: parsed.email,
    });
    const result = await withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
      // Capability matrix: a PERSONAL organization is single-member by definition. Collaboration
      // requires a TEAM organization — reject here so the single-member invariant holds at every door.
      assertTeamOrganization(organization, 'MEMBERS');
      const role = await this.memberRoleService.requireRoleRecordByPublicId(
        organization_public_id,
        parsed.role_id,
      );
      // Privilege-escalation guard: the caller must already hold every permission the assigned role
      // would grant, or a MEMBERSHIP_MANAGE holder could mint an Admin membership for a throwaway
      // address and accept it → full organization takeover. Runs BEFORE any row is persisted.
      const rolePermissionCodes = await this.memberRolePermissionService.listPermissionCodesForRole(
        role.id,
      );
      await assertCallerCanGrantPermissionCodes({
        authorizationService: this.authorizationService,
        permissionRepository: this.permissionRepository,
        callerUserPublicId: invited_by_user_public_id,
        organizationPublicId: organization_public_id,
        requestedPermissionCodes: rolePermissionCodes,
      });
      // REQ-4: enforce the plan seat limit before persisting the new membership. Runs INSIDE the
      // existing org transaction so the per-org advisory lock (plus the FOR UPDATE row lock when a
      // subscription exists) serializes concurrent adds — two simultaneous adds cannot both pass the
      // same count and exceed the limit, on the paid OR the free-tier path (audit-#M1). Ceiling of
      // null (unlimited plan / unwired port) is a no-op.
      await this.assertSeatAvailableForMemberAdd(organization.id);
      const inviterId =
        await this.organizationService.resolveUserInternalIdByPublicId(invited_by_user_public_id);
      if (inviterId === null) throw new NotFoundError('User');
      let created: Awaited<ReturnType<MembershipRepository['create']>>;
      try {
        created = await this.membershipRepository.create({
          organization_id: organization.id,
          user_id: inviteeUser.id,
          role_id: role.id,
          status: 'INVITED',
          invited_by_user_id: inviterId,
          created_by_user_id: inviterId,
        });
      } catch (error) {
        // The invitee already belongs to this organization (idx_memberships_user_org_unique) —
        // surface a clean 409 instead of an unhandled unique_violation 500. Covers an existing
        // ACTIVE member and a still-live INVITED one (the FE resends in that case).
        if (isPostgresUniqueViolation(error)) {
          throw new ConflictError('errors:membershipAlreadyExists').withReason(
            'membership_already_exists',
          );
        }
        throw error;
      }
      // Issue the invitation (token + email) in this same org transaction.
      await memberInvitationService.createForMembership({
        organization_name: organization.name ?? organization.public_id,
        organization_id: organization.id,
        membership_id: created.id,
        membership_public_id: created.public_id,
        email: inviteeUser.email,
        expires_in_days: parsed.expires_in_days,
        invited_by_user_id: inviterId,
        inviter_label: invited_by_user_public_id ?? 'Team member',
        ...(options?.requestId !== undefined ? { requestId: options.requestId } : {}),
      });
      await this.applyOrganizationLocaleDefaults(inviteeUser.public_id, organization_public_id);
      return this.resolveAndSerializeMembership(created, organization_public_id);
    });
    // sec-R11: invalidate the invitee's cached permissions AFTER the org transaction commits.
    // Doing it pre-commit left a race where a concurrent recompute re-cached the stale set.
    await invalidatePermissions(inviteeUser.public_id, organization_public_id);
    // REQ-4: the seat count just grew — reconcile the Stripe subscription quantity out-of-band.
    // Enqueued AFTER the org transaction commits so the worker re-reads the new count. Best-effort.
    this.enqueueSeatQuantitySync(organization_public_id);
    return result;
  }

  async update(
    scope: OrganizationPrincipalDatabaseScope,
    membership_public_id: string,
    body: unknown,
    updated_by_user_public_id: string | undefined,
  ): Promise<MembershipOutput> {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateUpdateMembership(body);
    let affectedUserInternalId: number | undefined;
    const result = await withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
      const membership = await this.membershipRepository.findByPublicId(
        membership_public_id,
        organization.id,
      );
      if (!membership) throw new NotFoundError('Membership');
      /**
       * sec-new-T1: The org owner's membership must not be modified by other members.
       * An Admin holding MEMBERSHIP_MANAGE could otherwise SUSPEND the owner, locking
       * them out of all RBAC-gated routes with no self-recovery path. The ownership
       * transfer endpoint is the correct mechanism for any ownership-adjacent change.
       */
      if (organization.owner_user_id === membership.user_id) {
        throw new ForbiddenError('errors:ownerMembershipCannotBeModified');
      }
      /**
       * Initial activation must be driven by invitation acceptance, not a
       * manager PATCH. A membership that has never joined (`joined_at IS NULL`,
       * i.e. still `INVITED`) cannot be flipped to `ACTIVE` here. Reactivating a
       * previously-active member (e.g. `SUSPENDED -> ACTIVE`, which already has
       * `joined_at` set) stays allowed so admin suspend/reactivate flows work.
       */
      if (parsed.status === 'ACTIVE' && membership.joined_at === null) {
        throw new ForbiddenError('errors:membershipActivationRequiresInvitationAccept');
      }
      /**
       * F1: reactivating a SUSPENDED member re-consumes a seat — SUSPENDED memberships are NOT
       * counted toward the cap, so a `SUSPENDED -> ACTIVE` transition adds one to the live seat
       * count. Without this check, suspend → add-a-new-member-into-the-freed-slot → reactivate
       * overshoots the plan's seat ceiling unbounded. Run the same seat-availability check as
       * `create`, inside this org transaction so the subscription `FOR UPDATE` lock serializes it.
       */
      if (parsed.status === 'ACTIVE' && membership.status !== 'ACTIVE') {
        await this.assertSeatAvailableForMemberAdd(organization.id);
      }
      let roleInternalId: number | undefined;
      if (parsed.role_id !== undefined) {
        // REQ-3: resolve the target role and run the same privilege-escalation guard as create — a
        // caller must already hold every permission the new role grants, so a MEMBERSHIP_MANAGE
        // holder cannot escalate a member into a role carrying permissions the caller lacks.
        const role = await this.memberRoleService.requireRoleRecordByPublicId(
          organization_public_id,
          parsed.role_id,
        );
        const rolePermissionCodes =
          await this.memberRolePermissionService.listPermissionCodesForRole(role.id);
        await assertCallerCanGrantPermissionCodes({
          authorizationService: this.authorizationService,
          permissionRepository: this.permissionRepository,
          callerUserPublicId: updated_by_user_public_id,
          organizationPublicId: organization_public_id,
          requestedPermissionCodes: rolePermissionCodes,
        });
        roleInternalId = role.id;
      }
      const userId =
        await this.organizationService.resolveUserInternalIdByPublicId(updated_by_user_public_id);
      const updated = await this.membershipRepository.update(
        membership_public_id,
        organization.id,
        omitUndefined({ status: parsed.status, role_id: roleInternalId }),
        userId ?? null,
      );
      if (!updated) throw new NotFoundError('Membership');
      affectedUserInternalId = updated.user_id;
      return this.resolveAndSerializeMembership(updated, organization_public_id);
    });
    // sec-R11: invalidate AFTER commit so a racing recompute can't re-cache the stale role set.
    if (affectedUserInternalId !== undefined) {
      await this.invalidatePermissionsForMembership(affectedUserInternalId, organization_public_id);
    }
    return result;
  }

  async delete(
    scope: OrganizationPrincipalDatabaseScope,
    membership_public_id: string,
  ): Promise<void> {
    const organization_public_id = scope.organizationPublicId;
    let affectedUserInternalId: number | undefined;
    await withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
      const membership = await this.membershipRepository.findByPublicId(
        membership_public_id,
        organization.id,
      );
      if (!membership) throw new NotFoundError('Membership');
      // The owner cannot be removed — they must transfer ownership first, or the organization
      // would be left without an owner.
      if (organization.owner_user_id === membership.user_id) {
        throw new ForbiddenError('errors:ownerCannotBeRemoved');
      }
      const deleted = await this.membershipRepository.softDelete(
        membership_public_id,
        organization.id,
      );
      if (!deleted) {
        // The atomic owner-guard refused the delete (a concurrent transfer made this member the
        // owner after the check above) or the row vanished — re-resolve for the precise error.
        const current =
          await this.organizationService.requireOrganizationRecordByPublicId(
            organization_public_id,
          );
        if (current.owner_user_id === membership.user_id) {
          throw new ForbiddenError('errors:ownerCannotBeRemoved');
        }
        throw new NotFoundError('Membership');
      }
      // reaudit-#7: revoke the removed member's API keys so they lose access too.
      await this.revokeApiKeysForDepartedMember(deleted.user_id, organization.id);
      affectedUserInternalId = deleted.user_id;
    });
    // sec-R11: invalidate AFTER commit so a racing recompute can't re-cache the removed member's
    // stale permissions (delayed revocation).
    if (affectedUserInternalId !== undefined) {
      await this.invalidatePermissionsForMembership(affectedUserInternalId, organization_public_id);
    }
    // REQ-4: the seat count just shrank — reconcile the Stripe subscription quantity out-of-band.
    this.enqueueSeatQuantitySync(organization_public_id);
  }

  async getPermissions(
    scope: OrganizationPrincipalDatabaseScope,
    membership_public_id: string,
  ): Promise<MembershipPermissionsOutput> {
    const organization_public_id = scope.organizationPublicId;
    return withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
      const membership = await this.membershipRepository.findByPublicId(
        membership_public_id,
        organization.id,
      );
      if (!membership) throw new NotFoundError('Membership');
      const permissionCodes = await this.memberRolePermissionService.listPermissionCodesForRole(
        membership.role_id,
      );
      return { permissions: permissionCodes };
    });
  }

  async leaveOrganization(
    scope: OrganizationPrincipalDatabaseScope,
    user_public_id: string,
  ): Promise<void> {
    const organization_public_id = scope.organizationPublicId;
    await withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
      const userId = await this.organizationService.resolveUserInternalIdByPublicId(user_public_id);
      if (userId === null) throw new NotFoundError('User');
      const membership = await this.membershipRepository.findByUserAndOrganization(
        userId,
        organization.id,
      );
      if (!membership) throw new NotFoundError('Membership');
      if (organization.owner_user_id === userId) {
        throw new ForbiddenError('errors:ownerCannotLeave');
      }
      const deleted = await this.membershipRepository.softDelete(
        membership.public_id,
        organization.id,
      );
      if (!deleted) {
        // The atomic owner-guard refused the delete: a concurrent transfer made this user the
        // owner after the pre-check above (which would otherwise orphan the org), or the row
        // vanished. Re-resolve so the race surfaces the same ownerCannotLeave as the pre-check.
        const current =
          await this.organizationService.requireOrganizationRecordByPublicId(
            organization_public_id,
          );
        if (current.owner_user_id === userId) {
          throw new ForbiddenError('errors:ownerCannotLeave');
        }
        throw new NotFoundError('Membership');
      }
      // reaudit-#7: revoke the departing member's API keys so they lose access too.
      await this.revokeApiKeysForDepartedMember(userId, organization.id);
    });
    // sec-R11: invalidate AFTER commit so a racing recompute can't re-cache the stale set.
    await invalidatePermissions(user_public_id, organization_public_id);
    // REQ-4: the seat count just shrank — reconcile the Stripe subscription quantity out-of-band.
    this.enqueueSeatQuantitySync(organization_public_id);
  }

  async transferOwnership(
    scope: OrganizationPrincipalDatabaseScope,
    body: unknown,
    current_user_public_id: string,
  ): Promise<MembershipOutput> {
    const organization_public_id = scope.organizationPublicId;
    const parsed = validateTransferOwnership(body);
    const result = await withPrincipalDatabaseContext(scope, async () => {
      const organization =
        await this.organizationService.requireOrganizationRecordByPublicId(organization_public_id);
      // A PERSONAL organization belongs solely to its owner and cannot be handed off.
      assertTeamOrganization(organization, 'MUTATION');
      const currentUserId =
        await this.organizationService.resolveUserInternalIdByPublicId(current_user_public_id);
      if (currentUserId === null) throw new NotFoundError('User');
      if (organization.owner_user_id !== currentUserId) {
        throw new ForbiddenError('errors:onlyOwnerCanTransfer');
      }
      const newOwnerUserId = await this.organizationService.resolveUserInternalIdByPublicId(
        parsed.new_owner_user_id,
      );
      if (newOwnerUserId === null) throw new NotFoundError('User');
      const newOwnerMembership = await this.membershipRepository.findByUserAndOrganization(
        newOwnerUserId,
        organization.id,
      );
      if (newOwnerMembership?.status !== 'ACTIVE') {
        throw new NotFoundError('New owner must be an active member');
      }
      await this.organizationService.transferOrganizationOwnership(
        organization_public_id,
        newOwnerUserId,
      );
      return this.resolveAndSerializeMembership(newOwnerMembership, organization_public_id);
    });
    // sec-R11b: ownership itself is a live DB check (never cached), but invalidate both parties'
    // cached permission sets after commit for defense-in-depth and consistency with the other
    // membership mutations, so no owner-implied permission can ever linger in cache.
    await invalidatePermissions(current_user_public_id, organization_public_id);
    await invalidatePermissions(parsed.new_owner_user_id, organization_public_id);
    return result;
  }

  /**
   * Counts the seat-occupying memberships (ACTIVE + INVITED) in an organization (REQ-4).
   *
   * @remarks
   * - **Algorithm:** runs {@link MembershipRepository.countActiveByOrganization} inside
   *   {@link withOrganizationDatabaseContext} so the `memberships` RLS policy resolves the
   *   org's rows. Resolves the org's internal id from its public id first.
   * - **Failure modes:** `NotFoundError('Organization')` when the public id does not resolve.
   * - **Side effects:** one read-only COUNT query under the org GUC.
   * - **Notes:** this is the cross-domain SERVICE entry point billing's `SubscriptionService`
   *   calls to compute `seats_used` — billing never reaches the membership repository/schema
   *   directly (cross-domain reads go service→service).
   */
  async countActiveMembers(options: { organizationPublicId: string }): Promise<number> {
    return withPrincipalDatabaseContext(
      resolveVerifiedOrganizationPrincipalScope(options.organizationPublicId),
      async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          options.organizationPublicId,
        );
        return this.membershipRepository.countActiveByOrganization(organization.id);
      },
    );
  }

  /**
   * F2: suspends the most-recently-joined non-owner ACTIVE members until the org's active headcount
   * fits `ceiling`; returns how many were suspended. Cross-domain entry point billing's
   * `SubscriptionService` calls after a downgrade commits.
   *
   * @remarks
   * - **Algorithm:** counts ACTIVE + INVITED seats; if `seatsUsed > ceiling`, suspends
   *   `seatsUsed - ceiling` non-owner ACTIVE members ordered by `joined_at DESC` (longest-tenured
   *   kept), then purges each suspended member's Redis permission cache so access is revoked at once
   *   rather than lingering for the cache TTL. The **owner is never suspended**, so an owner-only or
   *   owner-plus-invites org may remain above `ceiling` (invitations are not suspendable) — the
   *   add-member ceiling check still blocks further growth.
   * - **Failure modes:** `NotFoundError('Organization')` for a missing org; otherwise none beyond the
   *   underlying queries. Runs in the org DB context + transaction so the count and suspend are
   *   consistent and RLS-scoped.
   * - **Side effects:** flips excess memberships to `SUSPENDED`; invalidates permission caches.
   */
  async suspendExcessActiveMembersToFitCeiling(options: {
    organizationPublicId: string;
    ceiling: number;
  }): Promise<number> {
    const suspendedUserIds = await withPrincipalDatabaseContext(
      resolveVerifiedOrganizationPrincipalScope(options.organizationPublicId),
      async () => {
        const organization = await this.organizationService.requireOrganizationRecordByPublicId(
          options.organizationPublicId,
        );
        const seatsUsed = await this.membershipRepository.countActiveByOrganization(
          organization.id,
        );
        const excess = seatsUsed - options.ceiling;
        if (excess <= 0) return [];
        return this.membershipRepository.suspendExcessActiveMembers({
          organization_id: organization.id,
          owner_user_id: organization.owner_user_id,
          suspend_count: excess,
        });
      },
    );
    // Post-commit (policy audit R11): purge each suspended member's permission cache OUTSIDE the
    // org context block, so a concurrent recompute can't re-cache the pre-suspension permission set
    // before the suspend transaction commits.
    for (const userInternalId of suspendedUserIds) {
      await this.invalidatePermissionsForMembership(userInternalId, options.organizationPublicId);
    }
    return suspendedUserIds.length;
  }

  /**
   * Lists organization memberships for a GDPR data-export bundle under the requesting user's RLS
   * context (cross-organization read scoped to the owner).
   */
  async listOrganizationsForUserDataExport(options: {
    userPublicId: string;
    userInternalId: number;
    limit: number;
  }) {
    return withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(options.userPublicId),
      (_databaseHandle) =>
        this.membershipRepository.listOrganizationsForUserDataExport(
          options.userInternalId,
          options.limit,
        ),
    );
  }
}
