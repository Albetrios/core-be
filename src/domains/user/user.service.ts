import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/shared/errors/index.js';
import { resolveGlobalRoleForEmail } from '@/shared/utils/auth/global-admin-role.util.js';
import { GLOBAL_ROLES } from '@/shared/constants/roles.constants.js';
import type { ObjectStoragePort } from '@/infrastructure/storage/object-storage.port.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { buildUserAvatarKeyPrefix } from '@/domains/upload/upload.constants.js';
import type { UserRepository } from './user.repository.js';
import { env } from '@/shared/config/env.config.js';
import { ensurePersonalOrganizationPublicId } from '@/domains/tenancy/sub-domains/organization/resolve-active-organization.js';
import { UserSerializer } from './user.serializer.js';
import { resolveStoredMediaReadUrl } from '@/shared/utils/infrastructure/media-url.util.js';
import {
  validateUpdateMe,
  validateListUsers,
  validateAdminUpdateUser,
  validateUploadAvatar,
} from './user.validator.js';
import type { UserAuthRecord, UserOutput } from './user.types.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import type { AuthMethodService } from '@/domains/auth/sub-domains/auth-method/auth-method.service.js';
import type { UploadService } from '@/domains/upload/upload.service.js';
import type { UserDataExportService } from '@/domains/user/sub-domains/user-data-export/user-data-export.service.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import {
  withPrincipalDatabaseContext,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/database-context.js';
import { resolveVerifiedUserPrincipalScope } from '@/shared/utils/identity/verified-principal-scope.util.js';

const ALLOWED_AVATAR_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * Structural port for the organization-ownership check during user offboarding (route-audit-#2).
 *
 * @remarks
 * - **Algorithm:** a minimal interface (not an import of `OrganizationService`) so user offboarding
 *   can count the user's owned organizations without user depending on tenancy at the type level.
 * - **Failure modes:** the implementer surfaces DB errors; offboarding propagates them.
 * - **Side effects:** none on this type — the implementer runs the count read.
 * - **Notes:** the composition root supplies `OrganizationService` structurally (it already exposes
 *   `countOrganizationsOwnedByUser`).
 */
export type UserOrganizationOwnershipPort = {
  countOrganizationsOwnedByUser(userPublicId: string, userInternalId: number): Promise<number>;
};

/**
 * Cross-domain services injected lazily into {@link UserService} so account deletion can fan out
 * its side effects.
 *
 * @remarks
 * - **Algorithm:** wired post-construction by `wireOffboardingServices` so the user container can
 *   be built before the auth, upload, data-export, and tenancy containers exist (breaks circular DI).
 * - **Failure modes:** if any dependency is missing at deletion time, the service falls back to a
 *   plain soft-delete and emits no fan-out (see {@link UserService} `softDeleteUserWithOffboarding`).
 * - **Side effects:** none directly — the hosted services are responsible for queue / DB / S3 effects.
 * - **Notes:** intentionally typed as a record rather than an interface so the optional wiring path
 *   stays explicit at the call site; `organizationOwnership` is optional (offboarding still runs
 *   without it, just without the owned-organizations guard).
 */
export type UserOffboardingDependencies = {
  authSessionService: AuthSessionService;
  authMethodService: AuthMethodService;
  uploadService: UploadService;
  userDataExportService: UserDataExportService;
  /**
   * route-audit-#2 follow-up: blocks deleting a user who still owns organizations (the org — with
   * its members + billing — would be orphaned at a tombstoned owner). Require transfer/delete first.
   */
  organizationOwnership?: UserOrganizationOwnershipPort | undefined;
};

/**
 * Owns the canonical `users` row and the self-service / admin flows that read or mutate it.
 *
 * @remarks
 * - **Algorithm:** profile reads/writes go through {@link UserRepository}; admin list builds
 *   keyset pagination over `(created_at, id)`; avatar upload validates the S3 key against the
 *   user's owned namespace, calls `headObject` for content-type sanity, and asserts the upload
 *   row is `confirmed` inside the user-database context. Suspending a user (or any admin status
 *   change away from `ACTIVE`) revokes all of that user's sessions so an outstanding token cannot
 *   survive the deactivation. Account deletion runs
 *   `softDeleteUserWithOffboarding`: revoke all auth sessions, revoke all auth methods, then
 *   sequentially tombstone uploads + purge data-export rows + soft-delete the user (each step owns
 *   its per-user RLS transaction; no wrapping transaction since the steps span S3 + multiple domains
 *   and cannot be made atomic).
 * - **Failure modes:** missing user → {@link NotFoundError}; avatar key outside owner namespace
 *   or content type not in `ALLOWED_AVATAR_CONTENT_TYPES` → {@link ValidationError}; missing
 *   wired dependencies → fall back to plain soft-delete and warn-log; S3 delete failures during
 *   offboarding are warn-logged but do not abort offboarding.
 * - **Side effects:** writes `auth.users`; deletes S3 avatar objects; revokes sessions /
 *   credentials via auth services; tombstones uploads; purges data-export rows + S3 objects.
 *   No domain events emitted (offboarding is synchronous; export completion uses direct mail).
 * - **Notes:** password / MFA / email-verification updates run inside `withUserDatabaseContext`
 *   so RLS policies on user-scoped child tables continue to work; `wireOffboardingServices` is
 *   the only seam for cross-domain dependencies — keep them off the constructor to avoid
 *   circular DI between user, auth, upload, and user-data-export.
 */
export class UserService {
  private offboardingUploadService: UploadService | null = null;
  private offboardingUserDataExportService: UserDataExportService | null = null;
  private offboardingOrganizationOwnership: UserOrganizationOwnershipPort | null = null;
  private authSessionService: AuthSessionService | null = null;
  private authMethodService: AuthMethodService | null = null;

  constructor(
    private readonly repository: UserRepository,
    private readonly objectStorage: ObjectStoragePort,
  ) {}

  wireOffboardingServices(dependencies: UserOffboardingDependencies): void {
    this.authSessionService = dependencies.authSessionService;
    this.authMethodService = dependencies.authMethodService;
    this.offboardingUploadService = dependencies.uploadService;
    this.offboardingUserDataExportService = dependencies.userDataExportService;
    this.offboardingOrganizationOwnership = dependencies.organizationOwnership ?? null;
  }

  private get offboardingDependencies(): UserOffboardingDependencies | null {
    if (
      !(
        this.authSessionService &&
        this.authMethodService &&
        this.offboardingUploadService &&
        this.offboardingUserDataExportService
      )
    ) {
      return null;
    }
    return {
      authSessionService: this.authSessionService,
      authMethodService: this.authMethodService,
      uploadService: this.offboardingUploadService,
      userDataExportService: this.offboardingUserDataExportService,
      organizationOwnership: this.offboardingOrganizationOwnership ?? undefined,
    };
  }

  /**
   * Best-effort reclaim of the S3 object backing an owned avatar key. Prefix-guarded, so an
   * external OAuth-provider avatar URL is left untouched. Does NOT mutate the DB column — callers
   * decide what to write — so it can be reused by per-asset delete, replacement, and offboarding.
   */
  private async deleteOwnedAvatarObject(
    public_id: string,
    avatar_url: string | null,
  ): Promise<void> {
    if (!avatar_url) return;
    const expectedPrefix = buildUserAvatarKeyPrefix(public_id);
    if (!avatar_url.startsWith(expectedPrefix)) return;
    const objectDeleted = await this.objectStorage.deleteObject(avatar_url);
    if (!objectDeleted) {
      logger.warn({ publicId: public_id, avatarKey: avatar_url }, 'user.avatar.deleteFailed');
    }
  }

  private async clearAvatarStorage(public_id: string, avatar_url: string | null): Promise<void> {
    if (!avatar_url) return;
    const expectedPrefix = buildUserAvatarKeyPrefix(public_id);
    if (!avatar_url.startsWith(expectedPrefix)) return;
    await this.deleteOwnedAvatarObject(public_id, avatar_url);
    await withPrincipalDatabaseContext(resolveVerifiedUserPrincipalScope(public_id), () =>
      this.repository.update(public_id, { avatar_url: null }),
    );
  }

  private async softDeleteUserWithOffboarding(public_id: string): Promise<void> {
    // Offboarding can be initiated by the user (deleteMe) or an admin (deleteUser); both know the
    // TARGET public_id, so pin the target user context — the owner WITH CHECK then authorizes the
    // FORCE RLS soft-delete without entering the broader global-admin context from the self path.
    const user = await this.requireUserRecordByPublicId(public_id).catch(() => null);
    if (!user) throw new NotFoundError('User');
    const offboarding = this.offboardingDependencies;
    if (!offboarding) {
      const marked = await withPrincipalDatabaseContext(
        resolveVerifiedUserPrincipalScope(public_id),
        () => this.repository.markDeletionStarted(public_id),
      );
      if (!marked) throw new NotFoundError('User');
      // The tombstoning UPDATE must run under global_admin: the users SELECT arm gates on
      // `deleted_at IS NULL`, and Postgres requires the UPDATE's NEW row to stay
      // SELECT-visible — under the plain user scope the soft-delete is RLS-rejected (42501).
      const deleted = await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_admin, () =>
        this.repository.softDelete(public_id),
      );
      if (!deleted) throw new NotFoundError('User');
      return;
    }
    // route-audit-#2 follow-up: refuse to delete a user who still owns organizations — the org (and
    // its members + active subscription) would be orphaned at a tombstoned owner. The user must
    // transfer ownership (or delete the org, which now cancels its subscription) first. Checked
    // before markDeletionStarted so a blocked delete leaves no half-state.
    if (offboarding.organizationOwnership) {
      const ownedCount = await offboarding.organizationOwnership.countOrganizationsOwnedByUser(
        user.public_id,
        user.id,
      );
      if (ownedCount > 0) {
        throw new ConflictError('errors:userOwnsOrganizations');
      }
    }
    const marked = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(public_id),
      () => this.repository.markDeletionStarted(public_id),
    );
    if (!marked) {
      const current = await withPrincipalDatabaseContext(
        resolveVerifiedUserPrincipalScope(public_id),
        () => this.repository.findByPublicId(public_id),
      );
      if (!current?.deletion_started_at || current.deleted_at) {
        throw new NotFoundError('User');
      }
    }
    // Persist offboarding DB effects before external cleanup. Each step uses its own per-user RLS
    // transaction (FORCE RLS keys writes on app.current_user_public_id), so a single wrapping transaction
    // is not feasible — but ordering matters for correctness:
    //
    //   (1) revoke sessions → kills any in-flight bearer immediately, so no concurrent request
    //       can race the purge steps below and create orphan PENDING rows (sec-U8).
    //   (2) revoke auth methods → no fresh login can re-mint a session.
    //   (3) invalidate verification tokens → magic-link / password-reset issued seconds before
    //       deletion can no longer mint a session for the soon-to-be-deleted user (sec-U1).
    //   (4) purge data-exports + uploads → now that sessions/tokens are dead, no concurrent
    //       writer can re-introduce rows.
    //   (5) softDelete → flip deleted_at; this is the final DB-state mutation.
    //   (6) clearAvatarStorage → S3 cleanup after soft-delete succeeds.
    //
    // If an early DB step fails, sessions and avatar must remain intact (deletion is retryable
    // from `deletion_started_at`); S3 avatar deletion only runs after soft-delete succeeds.
    await offboarding.authSessionService.revokeAllSessions(public_id);
    await offboarding.authMethodService.revokeAllForUser(public_id);
    await offboarding.authMethodService.invalidateAllVerificationTokensForUser(public_id);
    await offboarding.uploadService.tombstoneAllByUserId(user.id);
    await offboarding.userDataExportService.deleteAllExportsForUser(user.id, public_id);
    // global_admin for the same NEW-row SELECT-visibility reason as the short-circuit path
    // above — the self arm can never see its own tombstoned row.
    const deleted = await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_admin, () =>
      this.repository.softDelete(public_id),
    );
    if (!deleted) throw new NotFoundError('User');
    await this.clearAvatarStorage(public_id, user.avatar_url);
  }

  // ── Cross-domain read/write (auth, audit, notify, tenancy) ───

  async findByEmail(email: string): Promise<UserAuthRecord | null> {
    return this.repository.findByEmail(email);
  }

  async findById(identifier: number): Promise<UserAuthRecord | null> {
    return this.repository.findById(identifier);
  }

  async findUserRecordByPublicId(public_id: string): Promise<UserAuthRecord | null> {
    // auth.users is FORCE RLS (audit #7); a by-public-id lookup pins the matching owner context so
    // the owner policy returns exactly that one row (it can never enumerate the table). Works for
    // self reads and single-target admin/system lookups alike.
    return withPrincipalDatabaseContext(resolveVerifiedUserPrincipalScope(public_id), () =>
      this.repository.findByPublicId(public_id),
    );
  }

  async requireUserRecordByPublicId(public_id: string): Promise<UserAuthRecord> {
    const user = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(public_id),
      () => this.repository.findByPublicId(public_id),
    );
    if (!user || user.deleted_at) throw new NotFoundError('User');
    return user;
  }

  async createFromOAuth(data: {
    email: string;
    first_name?: string;
    last_name?: string;
    avatar_url?: string;
    is_email_verified: boolean;
  }): Promise<UserAuthRecord> {
    // FORCE RLS owner WITH CHECK requires public_id = app.current_user_public_id. Generate the id first,
    // enter that user's context, then insert with the exact id so the policy passes. The retry
    // regenerates id + re-enters context on the (rare) public_id unique collision.
    return runInsertWithPublicIdentifierRetry(async () => {
      const publicId = generatePublicId('user');
      return withPrincipalDatabaseContext(resolveVerifiedUserPrincipalScope(publicId), () =>
        this.repository.insertOAuthUser(publicId, data),
      );
    });
  }

  /**
   * Find-or-create the user an organization invite is addressed to (REQ-1: add member by email).
   *
   * @remarks
   * - **Algorithm:** resolve by email via the SECURITY DEFINER resolver ({@link UserService.findByEmail});
   *   return an existing live (non-deleted) user; otherwise mint a bare ACTIVE user with
   *   `is_email_verified=false` and no password/auth method by reusing {@link UserService.createFromOAuth}.
   * - **Failure modes:** propagates a Postgres email-unique violation on a rare create race; never throws
   *   `NotFoundError` (find-or-create always resolves to a user).
   * - **Side effects:** may INSERT one `auth.users` row (its own transaction via `createFromOAuth`).
   * - **Notes:** the invitee *claims* the account on first OAuth/magic-link login — both already
   *   find-or-create by email, so they reuse this row and attach the auth method, then accept the
   *   invitation. Call this OUTSIDE any organization context so the public-id retry can open its own
   *   transaction (a pinned org transaction would abort on the rare public-id collision).
   */
  async findOrCreateInvitedByEmail(data: { email: string }): Promise<UserAuthRecord> {
    const existing = await this.findByEmail(data.email);
    if (existing && !existing.deleted_at) return existing;
    return this.createFromOAuth({
      email: data.email,
      is_email_verified: false,
    });
  }

  /**
   * Creates a passwordless user for email verification-code auto-signup with `is_email_verified=false`.
   *
   * @remarks
   * Delegates to {@link UserService.createFromOAuth} (the shared passwordless-insert path: generate
   * `public_id`, enter the owner `withUserDatabaseContext` so the FORCE-RLS owner WITH CHECK passes,
   * retry on the rare public-id collision). Used when `POST /auth/email/send-code` receives an
   * unknown email — the account is created on the spot (no password) and the verification code it then
   * receives is the proof-of-email-control that flips `is_email_verified` on login.
   */
  async createForEmailCode(data: { email: string }): Promise<UserAuthRecord> {
    return this.createFromOAuth({
      email: data.email,
      is_email_verified: false,
    });
  }

  async updatePassword(public_id: string, password_hash: string): Promise<UserAuthRecord | null> {
    return withPrincipalDatabaseContext(resolveVerifiedUserPrincipalScope(public_id), () =>
      this.repository.updatePassword(public_id, password_hash),
    );
  }

  /**
   * Clears `users.password_hash = NULL` for the given user (sec-r5-auth-session-info-1).
   *
   * @remarks
   * Called by {@link AuthMethodService.delete} when the user revokes their
   * PASSWORD auth_method row so the credential is no longer accepted by
   * `POST /auth/login`. Without this, the auth-method list reports "no
   * password" but the stale hash on `auth.users` continues to authenticate.
   */
  async clearPasswordHash(public_id: string): Promise<UserAuthRecord | null> {
    return withPrincipalDatabaseContext(resolveVerifiedUserPrincipalScope(public_id), () =>
      this.repository.clearPasswordHash(public_id),
    );
  }

  async updateLoginAttempt(
    public_id: string,
    failed_login_count: number,
    account_locked_until: Date | null,
  ): Promise<UserAuthRecord | null> {
    // Login is pre-session, but the TARGET public_id is known after the email resolver, so pin the
    // owner context — the owner WITH CHECK authorizes the lockout-counter write under FORCE RLS.
    return withPrincipalDatabaseContext(resolveVerifiedUserPrincipalScope(public_id), () =>
      this.repository.updateLoginAttempt(public_id, failed_login_count, account_locked_until),
    );
  }

  /**
   * Atomically record one failed login attempt (SQL `count + 1` plus a
   * conditional lockout once the threshold is reached), so concurrent failures
   * cannot lose increments. Delegates the lockout policy from the caller and
   * pins the owner database context like {@link UserService.updateLoginAttempt}.
   */
  async registerFailedLoginAttempt(
    public_id: string,
    options: { maxAttempts: number; lockoutMinutes: number },
  ): Promise<UserAuthRecord | null> {
    return withPrincipalDatabaseContext(resolveVerifiedUserPrincipalScope(public_id), () =>
      this.repository.incrementFailedLoginAttempt(public_id, options),
    );
  }

  async updateMfaEnabled(public_id: string, enabled: boolean): Promise<UserAuthRecord | null> {
    return withPrincipalDatabaseContext(resolveVerifiedUserPrincipalScope(public_id), () =>
      this.repository.updateMfaEnabled(public_id, enabled),
    );
  }

  async updateEmailVerified(public_id: string): Promise<UserAuthRecord | null> {
    // Email-verify consumes a token pre-session; the TARGET public_id is known, so pin the owner
    // context so the owner WITH CHECK authorizes the verified-flag write under FORCE RLS.
    return withPrincipalDatabaseContext(resolveVerifiedUserPrincipalScope(public_id), () =>
      this.repository.updateEmailVerified(public_id),
    );
  }

  async resolveInternalIdByPublicId(public_id: string): Promise<number | null> {
    const user = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(public_id),
      () => this.repository.findByPublicId(public_id),
    );
    return user?.id ?? null;
  }

  private async assertAvatarObjectInStorage(
    avatarKey: string,
    ownerPublicId: string,
  ): Promise<void> {
    const expectedPrefix = buildUserAvatarKeyPrefix(ownerPublicId);
    if (!avatarKey.startsWith(expectedPrefix)) {
      throw new ValidationError('errors:validation.avatarKeyNotOwned', undefined, {
        avatar_key: ['Avatar key does not belong to this user'],
      });
    }
    if (!this.offboardingUploadService) {
      throw new Error('UploadService is not wired for avatar-attach confirmation');
    }
    // External I/O (S3) runs outside the DB context; the confirmed-status read of the
    // user-scoped upload row runs in the user context so the owner RLS policy applies.
    const objectInfo = await this.objectStorage.headObject(avatarKey);
    if (!objectInfo) {
      throw new ValidationError('errors:validation.avatarNotFound');
    }
    if (
      objectInfo.contentType &&
      !ALLOWED_AVATAR_CONTENT_TYPES.includes(
        objectInfo.contentType as (typeof ALLOWED_AVATAR_CONTENT_TYPES)[number],
      )
    ) {
      throw new ValidationError(
        'errors:validation.avatarInvalidContentType',
        { contentType: objectInfo.contentType },
        `Invalid avatar content type: ${objectInfo.contentType}`,
      );
    }
    // Bind the upload row to this owner explicitly (not just via the key prefix) so the ownership
    // check survives any future caller that doesn't derive the key from the prefix convention.
    const ownerInternalId = await this.resolveInternalIdByPublicId(ownerPublicId);
    if (ownerInternalId === null) {
      throw new ValidationError('errors:validation.avatarNotFound');
    }
    await withPrincipalDatabaseContext(resolveVerifiedUserPrincipalScope(ownerPublicId), () =>
      this.offboardingUploadService!.assertKeyConfirmedForOwner({
        fileKey: avatarKey,
        userInternalId: ownerInternalId,
      }),
    );
  }

  /**
   * Serializes a user row to {@link UserOutput} with `avatar_url` resolved to a
   * short-lived signed read URL (USER-10: private bucket + signed-on-read). The
   * presign is a network-free local signature, so it is safe to call from within a
   * database context.
   */
  private async toUserOutput(user: Parameters<typeof UserSerializer.one>[0]): Promise<UserOutput> {
    const serialized = UserSerializer.one(user);
    return {
      ...serialized,
      avatar_url: await resolveStoredMediaReadUrl(this.objectStorage, user.avatar_url),
    };
  }

  // ── Self-service ────────────────────────────────────────────

  async getMe(scope: UserPrincipalDatabaseScope): Promise<UserOutput> {
    const publicId = scope.userPublicId;
    const user = await withPrincipalDatabaseContext(scope, () =>
      this.repository.findByPublicId(publicId),
    );
    if (!user || user.deleted_at) throw new NotFoundError('User');
    // Self-heal: when personal orgs are enabled, provision on demand if missing so
    // `personal_organization_id` is reliably non-null (never dead-ends onboarding). When
    // personal is disabled this returns undefined and we report null, unchanged.
    const personalOrganizationId = env.PERSONAL_ORGANIZATION_ENABLED
      ? ((await ensurePersonalOrganizationPublicId(user.id)) ?? null)
      : null;
    return {
      ...(await this.toUserOutput(user)),
      personal_organization_id: personalOrganizationId,
    };
  }

  async updateMe(scope: UserPrincipalDatabaseScope, body: unknown): Promise<UserOutput> {
    const publicId = scope.userPublicId;
    const parsed = validateUpdateMe(body);

    const { avatar_key: avatarKey, ...profileFields } = parsed;
    let avatarUrl: string | undefined;
    let previousAvatarUrl: string | null = null;
    if (avatarKey) {
      await this.assertAvatarObjectInStorage(avatarKey, publicId);
      avatarUrl = avatarKey;
      const previous = await withPrincipalDatabaseContext(scope, () =>
        this.repository.findByPublicId(publicId),
      );
      previousAvatarUrl = previous?.avatar_url ?? null;
    }
    const user = await withPrincipalDatabaseContext(scope, () =>
      this.repository.update(
        publicId,
        omitUndefined({
          ...profileFields,
          ...(avatarUrl !== undefined ? { avatar_url: avatarUrl } : {}),
        }),
      ),
    );
    if (!user) throw new NotFoundError('User');
    // Reclaim the previous owned avatar object when the avatar changed (storage leak / GDPR).
    if (avatarUrl !== undefined && previousAvatarUrl && previousAvatarUrl !== avatarUrl) {
      await this.deleteOwnedAvatarObject(publicId, previousAvatarUrl);
    }
    return this.toUserOutput(user);
  }

  /**
   * Marks the caller's onboarding as complete (idempotent) and returns the fresh
   * self context. The frontend calls this when the user finishes the wizard so the
   * next post-login resolution routes them to the dashboard instead of re-onboarding.
   */
  async completeOnboarding(scope: UserPrincipalDatabaseScope): Promise<UserOutput> {
    const publicId = scope.userPublicId;
    await withPrincipalDatabaseContext(scope, () =>
      this.repository.markOnboardingComplete(publicId),
    );
    return this.getMe(scope);
  }

  async deleteMe(publicId: string): Promise<void> {
    await this.softDeleteUserWithOffboarding(publicId);
  }

  /**
   * Re-drives a STUCK user offboarding (USER-04 / USER-09 reconciler entry point).
   *
   * @remarks
   * - **Algorithm:** delegates to the same idempotent `softDeleteUserWithOffboarding`
   *   sequence used by self/admin delete; `deletion_started_at` makes every step
   *   safe to re-run, so a partial offboarding resumes from where it stalled.
   * - **Failure modes:** propagates so the reconciler can count + alert and retry on
   *   the next tick.
   * - **Side effects:** same as the original offboarding (session/credential revoke,
   *   upload/export purge, soft-delete, S3 avatar cleanup).
   * - **Notes:** deliberately skips the admin-entry `assertTargetNotProtectedAdmin`
   *   guard — the offboarding has ALREADY been authorized and started; this only
   *   completes it.
   */
  async resumeOffboarding(public_id: string): Promise<void> {
    await this.softDeleteUserWithOffboarding(public_id);
  }

  async uploadAvatar(publicId: string, body: unknown): Promise<UserOutput> {
    const { avatar_key: avatarKey } = validateUploadAvatar(body);
    await this.assertAvatarObjectInStorage(avatarKey, publicId);
    const previous = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(publicId),
      () => this.repository.findByPublicId(publicId),
    );
    const user = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(publicId),
      () => this.repository.update(publicId, { avatar_url: avatarKey }),
    );
    if (!user) throw new NotFoundError('User');
    // Reclaim the PREVIOUS owned avatar object now the new one is attached — otherwise replacing an
    // avatar orphaned the old S3 object indefinitely (storage leak / incomplete GDPR erasure).
    if (previous?.avatar_url && previous.avatar_url !== avatarKey) {
      await this.deleteOwnedAvatarObject(publicId, previous.avatar_url);
    }
    return this.toUserOutput(user);
  }

  async deleteAvatar(publicId: string): Promise<UserOutput> {
    const existing = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(publicId),
      () => this.repository.findByPublicId(publicId),
    );
    if (!existing || existing.deleted_at) throw new NotFoundError('User');
    // Reclaim the backing S3 object before clearing the column — previously `DELETE` left the bytes
    // in the bucket (storage leak + incomplete GDPR erasure on the per-asset delete path).
    await this.deleteOwnedAvatarObject(publicId, existing.avatar_url);
    const user = await withPrincipalDatabaseContext(
      resolveVerifiedUserPrincipalScope(publicId),
      () => this.repository.update(publicId, { avatar_url: null }),
    );
    if (!user) throw new NotFoundError('User');
    return this.toUserOutput(user);
  }

  // ── Admin operations ────────────────────────────────────────

  async listUsers(query: unknown) {
    const parsed = validateListUsers(query);
    // Admin cross-user listing must read every row → global-admin context (route is guarded by
    // requireRole(SUPER_ADMIN, ADMIN), so entering the admin RLS escape hatch is authorized).
    const result = await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_admin, () =>
      this.repository.findMany(
        omitUndefined({
          after: parsed.after,
          limit: parsed.limit,
          status: parsed.status,
          search: parsed.search,
          include_total: parsed.include_total === 'true',
        }),
      ),
    );
    return {
      items: await Promise.all(result.items.map((user) => this.toUserOutput(user))),
      limit: result.limit,
      total: result.total,
      has_more: result.has_more,
      next_cursor: result.next_cursor,
    };
  }

  async getUser(publicId: string): Promise<UserOutput> {
    // Admin read of another user → global-admin context (route guarded by requireRole).
    const user = await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_admin, () =>
      this.repository.findByPublicId(publicId),
    );
    if (!user) throw new NotFoundError('User');
    return this.toUserOutput(user);
  }

  /**
   * Guards an admin mutation that would deactivate/remove a target (reaudit route-#1).
   *
   * @remarks
   * Refuses to suspend / delete / deactivate a user whose email is in the global-admin allowlist.
   * Super-admins are managed exclusively via `GLOBAL_ADMIN_EMAILS` (env), so the admin API must
   * not be able to suspend or delete one — which previously let a super-admin self-lock-out, take
   * down a peer admin, or remove the LAST super-admin (total admin-tier lockout). To rotate a
   * super-admin, change the env allowlist, not this endpoint.
   */
  private async assertTargetNotProtectedAdmin(targetPublicId: string): Promise<void> {
    const target = await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_admin, () =>
      this.repository.findByPublicId(targetPublicId),
    );
    if (!target) throw new NotFoundError('User');
    if (resolveGlobalRoleForEmail(target.email) === GLOBAL_ROLES.SUPER_ADMIN) {
      throw new ForbiddenError('errors:cannotModifyProtectedAdmin');
    }
  }

  async adminUpdateUser(publicId: string, body: unknown): Promise<UserOutput> {
    const parsed = validateAdminUpdateUser(body);
    // Only a status change away from ACTIVE is destructive; profile-only edits stay allowed.
    if (parsed.status !== undefined && parsed.status !== 'ACTIVE') {
      await this.assertTargetNotProtectedAdmin(publicId);
    }
    const user = await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_admin, () =>
      this.repository.adminUpdate(publicId, omitUndefined(parsed)),
    );
    if (!user) throw new NotFoundError('User');
    if (parsed.status !== undefined && parsed.status !== 'ACTIVE') {
      await this.revokeAllSessionsForDeactivatedUser(publicId);
    }
    return this.toUserOutput(user);
  }

  async deleteUser(publicId: string): Promise<void> {
    await this.assertTargetNotProtectedAdmin(publicId);
    await this.softDeleteUserWithOffboarding(publicId);
  }

  async suspendUser(publicId: string): Promise<UserOutput> {
    await this.assertTargetNotProtectedAdmin(publicId);
    const user = await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_admin, () =>
      this.repository.suspend(publicId),
    );
    if (!user) throw new NotFoundError('User');
    await this.revokeAllSessionsForDeactivatedUser(publicId);
    return this.toUserOutput(user);
  }

  /**
   * Revokes every active session for a user that just transitioned out of `ACTIVE`
   * (suspend or admin status change) so an outstanding bearer/cookie session cannot
   * outlive the deactivation. Session-validity cache invalidation is handled by
   * {@link AuthSessionService.revokeAllSessions}. No-ops when the auth-session
   * dependency has not been wired (e.g. minimal containers / unit tests).
   */
  private async revokeAllSessionsForDeactivatedUser(publicId: string): Promise<void> {
    if (!this.authSessionService) return;
    await this.authSessionService.revokeAllSessions(publicId);
  }

  async unsuspendUser(publicId: string): Promise<UserOutput> {
    const user = await withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.global_admin, () =>
      this.repository.unsuspend(publicId),
    );
    if (!user) throw new NotFoundError('User');
    return this.toUserOutput(user);
  }
}
