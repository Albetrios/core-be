import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/shared/errors/index.js';
import { assertTeamOrganization } from './organization-capability.js';
import { env } from '@/shared/config/env.config.js';
import {
  PRINCIPAL_SCOPE,
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
  withAppDatabaseContext,
  type OrganizationPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationRepository } from './organization.repository.js';
import type { Organization } from './organization.types.js';
import type {
  OrganizationBillingContext,
  OrganizationMembershipContext,
  OrganizationOutput,
} from './organization.types.js';
import {
  validateCreateOrganization,
  validateUpdateOrganization,
  validateListOrganizationsQuery,
  validateUploadLogo,
} from './organization.validator.js';
import { serializeOrganization } from './organization.serializer.js';
import { resolveStoredMediaReadUrl } from '@/shared/utils/infrastructure/media-url.util.js';
import { provisionOrganizationWithOwner } from './organization-provisioning.js';
import { invalidateOrganizationPermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import { buildOrganizationLogoKeyPrefix } from '@/domains/upload/upload.constants.js';
import type { ObjectStoragePort } from '@/infrastructure/storage/object-storage.port.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { isPostgresUniqueViolation } from '@/shared/utils/infrastructure/postgres-error.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import type { UploadService } from '@/domains/upload/upload.service.js';

/**
 * Structural port for the billing side of organization offboarding (route-audit-#2).
 *
 * @remarks
 * - **Algorithm:** declared as a minimal interface (not an import of `SubscriptionService`) so a
 *   call to `delete` can cancel the org's subscription without tenancy depending on billing.
 * - **Failure modes:** the implementer throws on a payment-provider outage, aborting the delete.
 * - **Side effects:** none on this type — the implementer makes the Stripe call + local write.
 * - **Notes:** billing already depends on tenancy, so importing the concrete service here would
 *   create a cycle; the composition root supplies `SubscriptionService` structurally.
 */
export type OrganizationSubscriptionOffboardingPort = {
  cancelActiveForOrganizationOffboarding(organizationPublicId: string): Promise<void>;
};

/**
 * Optional collaborators wired into {@link OrganizationService} after the
 * upload (and billing) domains have booted, used to tombstone tenant uploads,
 * confirm S3 keys during logo attachment, and cancel the org's subscription on delete.
 *
 * @remarks
 * - **Algorithm:** populated lazily by `wireOffboardingUploadService` so the
 *   tenancy container can be constructed before the upload/billing containers exist.
 * - **Failure modes:** until wired, `uploadLogo` and `delete` either throw
 *   (logo confirmation requires the upload service) or silently skip the
 *   upload-tombstone / subscription-cancel step.
 * - **Side effects:** none on construction; downstream calls invoke
 *   `UploadService.tombstoneAllByOrganizationId`, `assertKeyConfirmed`, and
 *   `OrganizationSubscriptionOffboardingPort.cancelActiveForOrganizationOffboarding`.
 * - **Notes:** the public {@link OrganizationService.offboardingUploadService}
 *   reference exists for composition-root assertions only.
 */
export type OrganizationOffboardingDependencies = {
  uploadService: UploadService;
  /** route-audit-#2: cancels the org's active subscription on delete so billing stops. */
  subscriptionService?: OrganizationSubscriptionOffboardingPort | undefined;
};

/**
 * Authoritative tenancy service for the organization aggregate — list / get /
 * create / update / soft-delete plus logo lifecycle.
 *
 * @remarks
 * - **Algorithm:** every mutation runs inside `withAppDatabaseContext`
 *   (sets `app.current_organization_public_id` for RLS) and reads use
 *   `withAppDatabaseContext (user scope)` to satisfy the `organizations_user_discovery`
 *   policy. Slug uniqueness is enforced explicitly; access checks short-
 *   circuit for global admins and otherwise require ownership or an active
 *   membership via {@link OrganizationRepository.userCanAccessOrganization}.
 * - **Failure modes:** `NotFoundError` for missing organizations, members,
 *   logos, or callers; `ConflictError('errors:organizationSlugExists')` on
 *   slug collision; `ValidationError` for bad logo keys, missing S3 objects,
 *   or disallowed `image/svg+xml` content.
 * - **Side effects:** S3 deletes and head-object calls via the injected
 *   {@link ObjectStoragePort}; tombstones uploads and clears the logo URL on
 *   organization deletion (cross-domain wiring through
 *   {@link OrganizationOffboardingDependencies}); purges the org's permission
 *   cache on soft-delete via {@link invalidateOrganizationPermissions}; does not
 *   emit domain events or write audit logs directly.
 * - **Notes:** soft-delete only — the row remains until the tombstone
 *   retention worker hard-deletes it; offboarding S3/upload-service work runs
 *   outside the DB context to avoid holding a transaction across HTTP.
 */
export class OrganizationService {
  private offboardingDependencies: OrganizationOffboardingDependencies | null = null;
  /** Public reference for composition-root assertions; populated at boot via wireOffboardingUploadService. */
  public offboardingUploadService: UploadService | null = null;

  constructor(
    private readonly repository: OrganizationRepository,
    private readonly objectStorage: ObjectStoragePort,
  ) {}

  wireOffboardingUploadService(
    uploadService: UploadService,
    subscriptionService?: OrganizationSubscriptionOffboardingPort,
  ): void {
    this.offboardingDependencies = { uploadService, subscriptionService };
    this.offboardingUploadService = uploadService;
  }

  /**
   * Serializes an organization row to {@link OrganizationOutput} with `logo_url`
   * resolved to a short-lived signed read URL (TEN-07: private bucket +
   * signed-on-read). The presign is a network-free local signature, so it is safe
   * to call from within a database context. Legacy rows that stored an absolute
   * public URL are returned as-is.
   */
  private async toOrganizationOutput(
    row: Parameters<typeof serializeOrganization>[0],
  ): Promise<OrganizationOutput> {
    const serialized = serializeOrganization(row);
    return {
      ...serialized,
      logo_url: await resolveStoredMediaReadUrl(this.objectStorage, row.logo_url),
    };
  }

  private extractOrganizationLogoStorageKey(
    public_id: string,
    logo_url: string | null,
  ): string | null {
    if (!logo_url) return null;
    const prefix = buildOrganizationLogoKeyPrefix(public_id);
    if (logo_url.startsWith(prefix)) return logo_url;
    const keyMatch = /organization-logos\/[^?#]+/.exec(logo_url);
    return keyMatch?.[0] ?? null;
  }

  /**
   * Best-effort reclaim of the S3 object backing an owned organization-logo URL. Prefix-guarded
   * (external URLs are ignored). Does NOT mutate the column — callers decide what to write — so it
   * is reused by per-asset delete, logo replacement, and offboarding.
   */
  private async deleteOwnedOrganizationLogoObject(
    public_id: string,
    logo_url: string | null,
  ): Promise<void> {
    const storageKey = this.extractOrganizationLogoStorageKey(public_id, logo_url);
    if (!storageKey) return;
    const objectDeleted = await this.objectStorage.deleteObject(storageKey);
    if (!objectDeleted) {
      logger.warn({ publicId: public_id, logoKey: storageKey }, 'organization.logo.deleteFailed');
    }
  }

  private async clearOrganizationLogoStorage(
    scope: OrganizationPrincipalDatabaseScope,
    logo_url: string | null,
  ): Promise<void> {
    const public_id = scope.organizationPublicId;
    await this.deleteOwnedOrganizationLogoObject(public_id, logo_url);
    const updated = await withAppDatabaseContext(scope, () =>
      this.repository.update(public_id, { logo_url: null }, null),
    );
    if (!updated) throw new NotFoundError('Organization');
  }

  async requireOrganizationByPublicId(public_id: string): Promise<OrganizationBillingContext> {
    const organization = await this.requireOrganizationRecordByPublicId(public_id);
    return {
      id: organization.id,
      public_id: organization.public_id,
      name: organization.name,
      slug: organization.slug,
      type: organization.type,
      stripe_customer_id: organization.stripe_customer_id,
    };
  }

  /**
   * Counts the active organizations owned by a user (route-audit-#2 follow-up). Runs in the user's
   * discovery context so the `organizations_user_discovery` RLS policy resolves the owned rows; used
   * by user offboarding to block deleting a user who still owns organizations.
   */
  async countOrganizationsOwnedByUser(
    userPublicId: string,
    userInternalId: number,
  ): Promise<number> {
    return withAppDatabaseContext(PRINCIPAL_SCOPE.VERIFIED({ userPublicId: userPublicId }), () =>
      this.repository.countActiveOwnedByUser(userInternalId),
    );
  }

  /**
   * Resolves the organization row for the active-organization public id, throwing `NotFoundError` when it
   * does not exist. Renamed from `requireOrganizationMembershipByPublicId` (audit-#T2).
   *
   * @remarks
   * - **Algorithm:** a single `findByPublicId` under the caller's RLS-scoped context; shapes the
   *   row into an {@link OrganizationMembershipContext}.
   * - **Failure modes:** `NotFoundError('Organization')` if no row resolves.
   * - **Side effects:** none (read-only).
   * - **Notes:** this does **NOT** assert that the caller is a member of the organization — it only
   *   resolves the row (the old name falsely implied a membership check). Authorization is enforced
   *   upstream by the route's `requireOrganizationPermission` preHandler and Postgres RLS scoped to
   *   `app.current_organization_public_id`. Do not add a route that relies on this method as its sole
   *   authorization gate; always pair it with a permission preHandler.
   */
  async requireOrganizationRecordByPublicId(
    public_id: string,
  ): Promise<OrganizationMembershipContext> {
    const organization = await this.repository.findByPublicId(public_id);
    if (!organization) throw new NotFoundError('Organization');
    return {
      id: organization.id,
      public_id: organization.public_id,
      name: organization.name,
      slug: organization.slug,
      type: organization.type,
      stripe_customer_id: organization.stripe_customer_id,
      owner_user_id: organization.owner_user_id,
    };
  }

  async transferOrganizationOwnership(
    organization_public_id: string,
    new_owner_user_id: number,
  ): Promise<OrganizationMembershipContext> {
    const updated = await this.repository.updateOwner(organization_public_id, new_owner_user_id);
    if (!updated) {
      // updateOwner only writes when the target is still an active member (atomic EXISTS guard);
      // a null result means a concurrent suspend/removal won the race after the caller's check.
      throw new ConflictError('errors:ownershipTransferTargetNotActive');
    }
    return this.requireOrganizationRecordByPublicId(organization_public_id);
  }

  async findOrganizationByInternalId(
    identifier: number,
  ): Promise<OrganizationBillingContext | null> {
    const organization = await this.repository.findById(identifier);
    if (!organization) return null;
    return {
      id: organization.id,
      public_id: organization.public_id,
      name: organization.name,
      slug: organization.slug,
      type: organization.type,
      stripe_customer_id: organization.stripe_customer_id,
    };
  }

  async findOrganizationByPublicId(public_id: string): Promise<OrganizationBillingContext | null> {
    const organization = await this.repository.findByPublicId(public_id);
    if (!organization) return null;
    return {
      id: organization.id,
      public_id: organization.public_id,
      name: organization.name,
      slug: organization.slug,
      type: organization.type,
      stripe_customer_id: organization.stripe_customer_id,
    };
  }

  async resolveUserInternalIdByPublicId(
    user_public_id: string | undefined,
  ): Promise<number | null> {
    // An API-key principal has no acting user, so the public id is `undefined`; resolve to a
    // null actor rather than looking up an empty string.
    if (!user_public_id) return null;
    return this.repository.resolveUserIdByPublicId(user_public_id);
  }

  /**
   * Resolve a user's public id from their internal numeric id.
   *
   * @remarks
   * - **Algorithm:** delegates to
   *   {@link OrganizationRepository.resolveUserPublicIdByInternalId}, which
   *   reads the active `users` row by internal id.
   * - **Failure modes:** returns `null` when no active user matches; never
   *   throws on a miss.
   * - **Side effects:** single read-only Postgres lookup.
   * - **Notes:** the inverse of {@link resolveUserInternalIdByPublicId}; used by
   *   tenancy services that hold a membership's internal `user_id` but need the
   *   public id to invalidate the per-user permission cache.
   */
  async resolveUserPublicIdByInternalId(user_internal_id: number): Promise<string | null> {
    return this.repository.resolveUserPublicIdByInternalId(user_internal_id);
  }

  /**
   * The batch form of {@link resolveUserPublicIdByInternalId}, for a caller holding a whole
   * set of internal ids.
   *
   * @remarks
   * - **Why:** resolving a set one id at a time costs one round trip per id. The underlying
   *   `auth.resolve_user_public_ids_by_ids` resolver answers the whole set in one statement.
   * - **Failure modes:** none raised. An id with no active user is absent from the map, which
   *   is the same signal the single-id version gives with `null`.
   * - **Side effects:** one read-only Postgres lookup, or none for empty input.
   */
  async resolveUserPublicIdsByInternalIds(
    user_internal_ids: readonly number[],
  ): Promise<Map<number, string>> {
    return this.repository.resolveUserPublicIdsByInternalIds(user_internal_ids);
  }

  async updateStripeCustomerIdForOrganization(
    organization_public_id: string,
    stripe_customer_id: string,
  ): Promise<void> {
    // tenancy.organizations is FORCE RLS — persist the Stripe customer id under the organization GUC
    // so the update is not silently dropped when called from the payment provider outside HTTP.
    return withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization_public_id }),
      async () => {
        const organization = await this.repository.findByPublicId(organization_public_id);
        if (!organization) throw new NotFoundError('Organization');
        await this.repository.updateStripeCustomerId(organization.id, stripe_customer_id);
      },
    );
  }

  /**
   * Membership gate for the single-organization reads.
   *
   * @remarks
   * This used to short-circuit for a global admin. The bypass could never fire: these reads run in
   * the caller's USER context, where `tenancy.organizations` is visible only through
   * `organizations_user_discovery` (owner or active member). No tenancy policy carries an
   * `app.global_admin` arm — that invisibility is deliberate and pinned by
   * `tenancy-global-admin-invisibility.security.test.ts` — so an admin's read returned their own
   * organizations either way and the bypass only decided whether the miss surfaced as a 404 here
   * or as an empty row set one query later. A real cross-tenant admin view needs a SECURITY DEFINER
   * resolver and a role-guarded route, not a branch here.
   */
  private async requireAccessibleOrganization(
    user_public_id: string,
    organization_public_id: string,
  ): Promise<Organization> {
    const organization = await this.repository.userCanAccessOrganization(
      user_public_id,
      organization_public_id,
    );
    if (!organization) {
      throw new NotFoundError('Organization');
    }
    return organization;
  }

  private async assertUserCanAccessLoadedOrganization(
    user_public_id: string,
    organization: Organization,
  ): Promise<void> {
    const canAccess = await this.repository.userCanAccessLoadedOrganization(
      user_public_id,
      organization,
    );
    if (!canAccess) {
      throw new NotFoundError('Organization');
    }
  }

  /**
   * Cross-organization read for the current user. Wraps in `withAppDatabaseContext (user scope)`
   * so the `organizations_user_discovery` and `memberships_user_self_discovery`
   * RLS policies see `app.current_user_public_id` (introduced by migration
   * `20260520000004_organization_discovery_and_invitation_lookup_rls.sql`). Without
   * this wrap the call returns empty when `DATABASE_RLS_SCOPED_CONTEXTS=true`.
   */
  async listForUser(query: unknown, user_public_id: string) {
    const parsed = validateListOrganizationsQuery(query);
    const pagination = omitUndefined({
      after: parsed.after,
      limit: parsed.limit,
    });
    return withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ userPublicId: user_public_id }),
      async () => {
        const result = await this.repository.findAllForUser(user_public_id, pagination);
        return {
          ...result,
          items: await Promise.all(result.items.map((row) => this.toOrganizationOutput(row))),
        };
      },
    );
  }

  async getByPublicId(public_id: string, user_public_id: string): Promise<OrganizationOutput> {
    return withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ userPublicId: user_public_id }),
      async () => {
        // One read, not two: the access check hands back the row it fetched.
        const organization = await this.requireAccessibleOrganization(user_public_id, public_id);
        return this.toOrganizationOutput(organization);
      },
    );
  }

  async getBySlug(slug: string, user_public_id: string): Promise<OrganizationOutput> {
    return withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ userPublicId: user_public_id }),
      async () => {
        const organization = await this.repository.findBySlug(slug);
        if (!organization) throw new NotFoundError('Organization');
        // The row is already in hand from the slug lookup, so check against it rather
        // than re-reading the same organization by public id.
        await this.assertUserCanAccessLoadedOrganization(user_public_id, organization);
        return this.toOrganizationOutput(organization);
      },
    );
  }

  async create(body: unknown, owner_user_public_id: string): Promise<OrganizationOutput> {
    // Capability gate: this endpoint only ever provisions a TEAM organization (personal organizations are
    // auto-provisioned, never created here). Enforce what `/users/me` advertises — in a
    // personal-only deployment (TEAM_ORGANIZATION_ENABLED=false) team-organization creation is rejected
    // server-side, not merely hidden by the frontend.
    if (!env.TEAM_ORGANIZATION_ENABLED) {
      throw new ForbiddenError('errors:teamOrganizationsDisabled');
    }
    const parsed = validateCreateOrganization(body);
    /**
     * INSERT must pass `organizations_user_discovery` WITH CHECK
     * (`owner_user_id` resolves to the current `app.current_user_public_id`). The slug
     * existence check runs in the same wrap so the SELECT also sees the user GUC.
     */
    return withAppDatabaseContext(
      PRINCIPAL_SCOPE.VERIFIED({ userPublicId: owner_user_public_id }),
      async () => {
        const ownerId = await this.repository.resolveUserIdByPublicId(owner_user_public_id);
        if (ownerId === null) throw new NotFoundError('User');
        // Anti-abuse: cap the number of TEAM organizations a single account may own (personal is
        // exempt — countActiveOwnedByUser already counts only type='TEAM').
        // TEN-02 / audit-#8 / audit-R12: serialize the count + insert with ONE per-owner
        // transaction-scoped advisory lock (the canonical resource-quota lock; releases at COMMIT) so
        // concurrent creates by the same owner cannot both pass the same count and overshoot the cap.
        // Previously this path ALSO took a second, redundant lock from the parallel resource-cap-lock
        // module (now removed) — either lock alone fully serializes, so the second was dead weight.
        await this.repository.acquireOwnedOrganizationQuotaLock(ownerId);
        const ownedTeamCount = await this.repository.countActiveOwnedByUser(ownerId);
        if (ownedTeamCount >= env.MAX_TEAM_ORGANIZATIONS_PER_OWNER) {
          throw new ConflictError(
            'errors:maxTeamOrganizationsReached',
            { max: env.MAX_TEAM_ORGANIZATIONS_PER_OWNER },
            `Maximum number of team organizations (${env.MAX_TEAM_ORGANIZATIONS_PER_OWNER}) reached for this account`,
          );
        }
        const existing = await this.repository.findBySlug(parsed.slug);
        if (existing)
          throw new ConflictError(
            'errors:organizationSlugExists',
            { slug: parsed.slug },
            `Organization with slug "${parsed.slug}" already exists`,
          ).withReason('organization_slug_exists');
        try {
          // Atomically create the organization AND bootstrap the owner's role + full
          // permissions + membership — without this the creator resolves zero permissions
          // on their own organization (the permission path is a strict role→membership join).
          const { organization } = await provisionOrganizationWithOwner({
            name: parsed.name,
            slug: parsed.slug,
            type: 'TEAM',
            ownerUserId: ownerId,
          });
          return this.toOrganizationOutput(organization);
        } catch (error) {
          // Two concurrent creates can both pass the findBySlug pre-check; the
          // loser hits the `idx_organizations_slug` unique index. Map the
          // Postgres unique_violation to a 409 instead of a 500.
          if (isPostgresUniqueViolation(error)) {
            throw new ConflictError(
              'errors:organizationSlugExists',
              { slug: parsed.slug },
              `Organization with slug "${parsed.slug}" already exists`,
            ).withReason('organization_slug_exists');
          }
          throw error;
        }
      },
    );
  }

  async update(
    scope: OrganizationPrincipalDatabaseScope,
    body: unknown,
    updated_by_user_public_id: string | undefined,
  ): Promise<OrganizationOutput> {
    const public_id = scope.organizationPublicId;
    const parsed = validateUpdateOrganization(body);
    return withAppDatabaseContext(scope, async () => {
      const organization = await this.repository.findByPublicId(public_id);
      if (!organization) throw new NotFoundError('Organization');
      const userId = await this.repository.resolveUserIdByPublicId(updated_by_user_public_id);
      if (parsed.slug) {
        const existing = await this.repository.findBySlug(parsed.slug);
        if (existing && existing.public_id !== public_id) {
          throw new ConflictError(
            'errors:organizationSlugExists',
            { slug: parsed.slug },
            `Organization with slug "${parsed.slug}" already exists`,
          ).withReason('organization_slug_exists');
        }
      }
      let updated: Awaited<ReturnType<typeof this.repository.update>>;
      try {
        updated = await this.repository.update(public_id, omitUndefined(parsed), userId ?? null);
      } catch (error) {
        // Two concurrent slug updates (on different organizations, to the same new slug) can both pass
        // the findBySlug pre-check above; the loser hits the `idx_organizations_slug` unique
        // index. Map the unique_violation to a 409 instead of letting it surface as a 500 —
        // mirroring the create path.
        if (parsed.slug && isPostgresUniqueViolation(error)) {
          throw new ConflictError(
            'errors:organizationSlugExists',
            { slug: parsed.slug },
            `Organization with slug "${parsed.slug}" already exists`,
          ).withReason('organization_slug_exists');
        }
        throw error;
      }
      if (!updated) throw new NotFoundError('Organization');
      return this.toOrganizationOutput(updated);
    });
  }

  /**
   * Re-drives a STUCK organization offboarding (TEN-06 reconciler entry point).
   *
   * @remarks
   * - **Algorithm:** delegates to the idempotent {@link OrganizationService.delete}
   *   sequence; `deletion_started_at` makes each step safe to re-run, so a partial
   *   offboarding resumes (logo/upload cleanup, subscription cancel, soft-delete,
   *   permission-cache purge) and completes.
   * - **Failure modes:** propagates so the reconciler can count + alert and retry on
   *   the next tick; a PERSONAL organization (never deletable standalone, and excluded by the
   *   reconciler scan) would surface `ConflictError`.
   * - **Side effects:** same as `delete`.
   * - **Notes:** thin alias kept distinct from `delete` so the reconciler's intent is
   *   explicit at the call site.
   */
  async resumeOffboarding(scope: OrganizationPrincipalDatabaseScope): Promise<void> {
    await this.delete(scope);
  }

  async delete(scope: OrganizationPrincipalDatabaseScope): Promise<void> {
    const public_id = scope.organizationPublicId;
    const organization = await withAppDatabaseContext(scope, async () => {
      const found = await this.repository.findByPublicId(public_id);
      if (!found) throw new NotFoundError('Organization');
      // A PERSONAL organization is the user's own account-level workspace — it is never
      // deletable on its own; it cascades only when the account itself is deleted.
      assertTeamOrganization(found, 'MUTATION');
      const marked = await this.repository.markDeletionStarted(public_id);
      if (!(marked || found.deletion_started_at)) {
        throw new NotFoundError('Organization');
      }
      return found;
    });
    // External I/O (S3) and the upload-service tombstone run outside the deletion transaction.
    await this.clearOrganizationLogoStorage(scope, organization.logo_url);
    if (this.offboardingDependencies) {
      await this.offboardingDependencies.uploadService.tombstoneAllByOrganizationId(
        organization.id,
      );
      // route-audit-#2: cancel the org's active subscription so deleting the organization stops Stripe
      // billing (offboarding previously never touched billing). Done BEFORE the soft-delete so a
      // Stripe failure aborts the whole delete instead of soft-deleting an organization that keeps billing.
      await this.offboardingDependencies.subscriptionService?.cancelActiveForOrganizationOffboarding(
        public_id,
      );
    }
    // The tombstoning UPDATE runs under the global-retention context: sec-new-D3 keeps
    // `deleted_at IS NULL` on the tenant SELECT arm, and Postgres requires the UPDATE's
    // NEW row to stay SELECT-visible — under the plain organization scope the soft-delete is
    // RLS-rejected (42501) AFTER Stripe cancellation already ran. The retention arm
    // covers USING, WITH CHECK, and new-row visibility; identity columns are unchanged.
    const deleted = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
      () => this.repository.softDelete(public_id),
    );
    if (!deleted) throw new NotFoundError('Organization');
    // Purge every member's cached permissions for this organization so access stops
    // immediately on soft-delete rather than lingering until the cache TTL.
    await invalidateOrganizationPermissions(public_id);
  }

  async uploadLogo(
    scope: OrganizationPrincipalDatabaseScope,
    body: unknown,
    updated_by_user_public_id: string | undefined,
  ): Promise<OrganizationOutput> {
    const public_id = scope.organizationPublicId;
    const parsed = validateUploadLogo(body);
    const expectedPrefix = buildOrganizationLogoKeyPrefix(public_id);
    if (!parsed.key.startsWith(expectedPrefix)) {
      throw new ValidationError('errors:validation.logoKeyNotOwned', undefined, {
        key: ['Logo key does not belong to this organization'],
      });
    }
    if (!this.offboardingUploadService) {
      throw new Error('UploadService is not wired for logo-attach confirmation');
    }
    // External I/O (S3) runs outside the DB context.
    const metadata = await this.objectStorage.headObject(parsed.key);
    if (!metadata) {
      throw new ValidationError('errors:validation.logoNotFound', undefined, {
        key: ['Object does not exist'],
      });
    }
    if (metadata.contentType === 'image/svg+xml') {
      throw new ValidationError('errors:uploadContentTypeNotAllowed', undefined, {
        key: ['SVG logos are not allowed for security reasons'],
      });
    }
    // TEN-07: store the object KEY (private bucket + signed-on-read), not a permanent
    // unsigned public URL. Reads mint a short-lived signed URL via toOrganizationOutput.
    const logoStorageKey = parsed.key;
    const { serialized, previousLogoUrl } = await withAppDatabaseContext(scope, async () => {
      const organization = await this.repository.findByPublicId(public_id);
      if (!organization) throw new NotFoundError('Organization');
      // Bind the upload row to THIS organization explicitly (route-audit L2) — not only via the
      // key prefix — so the ownership check holds even for a future caller that doesn't derive it.
      await this.offboardingUploadService!.assertKeyConfirmedForOwner({
        fileKey: parsed.key,
        organizationInternalId: organization.id,
      });
      const previous = organization.logo_url;
      const userId = await this.repository.resolveUserIdByPublicId(updated_by_user_public_id);
      const result = await this.repository.update(
        public_id,
        { logo_url: logoStorageKey },
        userId ?? null,
      );
      if (!result) throw new NotFoundError('Organization');
      return { serialized: await this.toOrganizationOutput(result), previousLogoUrl: previous };
    });
    // Reclaim the PREVIOUS owned logo object outside the DB context — replacing a logo previously
    // orphaned the old S3 object (storage leak). Best-effort + prefix-guarded.
    if (previousLogoUrl && previousLogoUrl !== logoStorageKey) {
      await this.deleteOwnedOrganizationLogoObject(public_id, previousLogoUrl);
    }
    return serialized;
  }

  async deleteLogo(
    scope: OrganizationPrincipalDatabaseScope,
    updated_by_user_public_id: string | undefined,
  ): Promise<OrganizationOutput> {
    const public_id = scope.organizationPublicId;
    const organization = await withAppDatabaseContext(scope, async () => {
      const found = await this.repository.findByPublicId(public_id);
      if (!found) throw new NotFoundError('Organization');
      return found;
    });
    // Reclaim the backing S3 object before clearing the column (prefix-guarded; external URLs are
    // left untouched) — previously DELETE left the object orphaned in the bucket (storage leak).
    // External I/O (S3) runs outside the DB context; best-effort, so a missing object still clears.
    await this.deleteOwnedOrganizationLogoObject(public_id, organization.logo_url);
    return withAppDatabaseContext(scope, async () => {
      const userId = await this.repository.resolveUserIdByPublicId(updated_by_user_public_id);
      const updated = await this.repository.update(public_id, { logo_url: null }, userId ?? null);
      if (!updated) throw new NotFoundError('Organization');
      return this.toOrganizationOutput(updated);
    });
  }
}
