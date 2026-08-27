import { ConfigurationError, NotFoundError } from '@/shared/errors/index.js';
import { isPostgresUniqueViolation } from '@/shared/utils/infrastructure/postgres-error.util.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { withUserDatabaseContext } from '@/infrastructure/database/contexts/user-database.context.js';
import { createWorkerUserDataExportRepository } from '@/domains/user/sub-domains/user-data-export/user-data-export.repository.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { GDPR_EXPORT_MAX_ROWS_PER_TABLE } from '@/shared/constants/query-limits.constants.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { ObjectStoragePort } from '@/infrastructure/storage/object-storage.port.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { UserDataExportRepository } from '@/domains/user/sub-domains/user-data-export/user-data-export.repository.js';
import { serializeUserDataExport } from '@/domains/user/sub-domains/user-data-export/user-data-export.serializer.js';
import {
  USER_DATA_EXPORT_ARTIFACT_TTL_DAYS,
  USER_DATA_EXPORT_OFFBOARDING_DELETE_BATCH_SIZE,
  USER_DATA_EXPORT_OFFBOARDING_DELETE_CONCURRENCY,
  USER_DATA_EXPORT_S3_PREFIX,
} from '@/domains/user/sub-domains/user-data-export/user-data-export.constants.js';
import {
  USER_DATA_EXPORT_STATUSES,
  UserDataExportCancelledError,
  type UserDataExport,
  type UserDataExportOutput,
} from '@/domains/user/sub-domains/user-data-export/user-data-export.types.js';
import { scheduleCommitDispatch } from '@/core/events/event-bus.js';
import { USER_DATA_EXPORT_PRESIGNED_DOWNLOAD_EXPIRY_SECONDS } from '@/shared/constants/ttl.constants.js';
import { env } from '@/shared/config/env.config.js';
import type { AuthSessionService } from '@/domains/auth/sub-domains/auth-session/auth-session.service.js';
import type { MembershipService } from '@/domains/tenancy/sub-domains/membership/membership.service.js';
import type { NotificationService } from '@/domains/notify/sub-domains/notification/notification.service.js';
import type { AuditService } from '@/domains/audit/audit.service.js';
import {
  withPrincipalDatabaseContext,
  type UserPrincipalDatabaseScope,
} from '@/infrastructure/database/contexts/principal-database.context.js';

function buildExportS3Key(userPublicId: string, exportPublicId: string): string {
  return `${USER_DATA_EXPORT_S3_PREFIX}/${userPublicId}/${exportPublicId}.json.gz`;
}

function computeArtifactExpiresAt(): Date {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + USER_DATA_EXPORT_ARTIFACT_TTL_DAYS);
  return expiresAt;
}

/**
 * Cross-domain services injected lazily into {@link UserDataExportService} so the user container
 * can be built before auth, tenancy, notify, and audit containers exist.
 *
 * @remarks
 * - **Algorithm:** wired post-construction by {@link UserDataExportService.wireCrossDomainServices}.
 * - **Failure modes:** {@link UserDataExportService.buildExportPayload} throws
 *   {@link ConfigurationError} when this bag is unset.
 * - **Side effects:** none — delegates reads to the hosted services.
 * - **Notes:** mirrors the {@link UserOffboardingDependencies} lazy-wiring pattern on
 *   {@link UserService}.
 */
export type UserDataExportCrossDomainServices = {
  authSessionService: AuthSessionService;
  membershipService: MembershipService;
  notificationService: NotificationService;
  auditService: AuditService;
};

/**
 * Caps a fetched-with-`cap + 1` export category to {@link GDPR_EXPORT_MAX_ROWS_PER_TABLE},
 * recording `category` in `truncatedCategories` when the cap was exceeded so the truncation
 * can be disclosed in the export payload rather than applied silently.
 *
 * @remarks
 * - **Algorithm:** if `rows.length` exceeds the cap, push `category` and return the first
 *   `cap` rows; otherwise return the input unchanged.
 * - **Failure modes:** none — pure function over the provided array.
 * - **Side effects:** mutates the passed `truncatedCategories` accumulator.
 * - **Notes:** callers must fetch `cap + 1` rows for the overflow signal to be reliable.
 */
export function capExportCategory<Row>(
  rows: Row[],
  category: string,
  truncatedCategories: string[],
): Row[] {
  if (rows.length > GDPR_EXPORT_MAX_ROWS_PER_TABLE) {
    truncatedCategories.push(category);
    return rows.slice(0, GDPR_EXPORT_MAX_ROWS_PER_TABLE);
  }
  return rows;
}

/**
 * Orchestrates the GDPR "right to data portability" export pipeline end-to-end.
 *
 * @remarks
 * - **Algorithm:** request → persist a `pending` row → enqueue BullMQ job on commit; worker calls
 *   {@link UserDataExportService.markProcessing}, then {@link UserDataExportService.buildExportPayload}
 *   to aggregate cross-domain rows via each owning domain's service under
 *   {@link GDPR_EXPORT_MAX_ROWS_PER_TABLE}, gzips the JSON, uploads to S3, and flips status to
 *   `completed`. On status reads, a presigned download URL is minted only when COMPLETED and
 *   `expires_at` is in the future.
 * - **Failure modes:** missing user → {@link NotFoundError}; missing S3 bucket config →
 *   {@link ConfigurationError}; cross-domain services not wired → {@link ConfigurationError};
 *   concurrent user soft-delete or row removal → throws
 *   {@link UserDataExportCancelledError} so the worker exits without retry; unexpected errors are
 *   recorded via {@link UserDataExportService.failExportJob}.
 * - **Side effects:** writes `auth.user_data_exports`, uploads/deletes objects in the GDPR S3
 *   prefix, enqueues `user-data-export` BullMQ jobs, and emits info-level audit logs. Used by
 *   `UserService` offboarding to purge every export row + S3 object on account deletion.
 * - **Notes:** cross-domain reads go through other domains' services only (see dependency rules).
 *   Self-service only — no organization context required.
 */
export class UserDataExportService {
  private crossDomainServices: UserDataExportCrossDomainServices | undefined;

  constructor(
    private readonly userService: UserService,
    private readonly exportRepository: UserDataExportRepository,
    private readonly objectStorage: ObjectStoragePort,
  ) {}

  /** Wire auth, tenancy, notify, and audit services after the composition root finishes. */
  wireCrossDomainServices(services: UserDataExportCrossDomainServices): void {
    this.crossDomainServices = services;
  }

  private requireCrossDomainServices(): UserDataExportCrossDomainServices {
    if (this.crossDomainServices === undefined) {
      throw new ConfigurationError('UserDataExportService cross-domain services are not wired');
    }
    return this.crossDomainServices;
  }

  async requestExport(
    scope: UserPrincipalDatabaseScope,
    options?: { requestId?: string },
  ): Promise<UserDataExportOutput> {
    const userPublicId = scope.userPublicId;
    const user = await this.userService.findUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');

    const existingPending = await withPrincipalDatabaseContext(scope, () =>
      this.exportRepository.findPendingOrProcessingByUserId(user.id),
    );
    if (existingPending) {
      logger.info(
        { userPublicId, exportPublicId: existingPending.public_id },
        'user-data-export.existing_pending_returned',
      );
      return serializeUserDataExport(existingPending);
    }

    const exportPublicId = generatePublicId('userDataExport');
    const s3Key = buildExportS3Key(userPublicId, exportPublicId);
    const expiresAt = computeArtifactExpiresAt();

    // auth.user_data_exports is FORCE RLS keyed on app.current_user_id — insert inside the user
    // context so the row passes the owner-access policy in default scoped-RLS mode.
    let row: Awaited<ReturnType<UserDataExportRepository['create']>>;
    try {
      row = await withPrincipalDatabaseContext(scope, () =>
        this.exportRepository.create({
          public_id: exportPublicId,
          user_id: user.id,
          status: USER_DATA_EXPORT_STATUSES.PENDING,
          s3_key: s3Key,
          expires_at: expiresAt,
        }),
      );
    } catch (error) {
      if (!isPostgresUniqueViolation(error)) {
        throw error;
      }
      const existingAfterRace = await withPrincipalDatabaseContext(scope, () =>
        this.exportRepository.findPendingOrProcessingByUserId(user.id),
      );
      if (existingAfterRace) {
        logger.info(
          { userPublicId, exportPublicId: existingAfterRace.public_id },
          'user-data-export.concurrent_pending_returned',
        );
        return serializeUserDataExport(existingAfterRace);
      }
      throw error;
    }

    await scheduleCommitDispatch(
      {
        type: 'user_data_export',
        exportPublicId,
        userPublicId,
        userInternalId: user.id,
      },
      options?.requestId !== undefined ? { requestId: options.requestId } : undefined,
    );

    logger.info({ userPublicId, exportPublicId }, 'user-data-export.requested');

    return serializeUserDataExport(row);
  }

  async getExportStatus(
    scope: UserPrincipalDatabaseScope,
    exportPublicId: string,
  ): Promise<UserDataExportOutput> {
    const userPublicId = scope.userPublicId;
    const user = await this.userService.findUserRecordByPublicId(userPublicId);
    if (!user) throw new NotFoundError('User');

    const row = await withPrincipalDatabaseContext(scope, () =>
      this.exportRepository.findByPublicIdAndUserId(exportPublicId, user.id),
    );
    if (!row) throw new NotFoundError('User data export');

    let downloadUrl: string | null = null;
    if (
      row.status === USER_DATA_EXPORT_STATUSES.COMPLETED &&
      row.s3_key &&
      row.expires_at &&
      row.expires_at.getTime() > Date.now()
    ) {
      if (!env.S3_BUCKET) {
        throw new ConfigurationError('S3_BUCKET is not configured');
      }
      downloadUrl = await this.objectStorage.createPresignedDownloadUrl({
        key: row.s3_key,
        expiresInSeconds: USER_DATA_EXPORT_PRESIGNED_DOWNLOAD_EXPIRY_SECONDS,
      });
    }

    return serializeUserDataExport(row, { download_url: downloadUrl });
  }

  /**
   * Returns false when the export row was removed (offboarding) or the user was soft-deleted.
   * Worker jobs should exit without retry when this returns false.
   */
  async isExportJobCancelled(options: {
    exportPublicId: string;
    userInternalId: number;
    userPublicId: string;
    databaseHandle?: WorkerDatabaseHandle;
  }): Promise<boolean> {
    const exportRepository = this.resolveExportRepository(options.databaseHandle);
    const row = await exportRepository.findByPublicIdAndUserId(
      options.exportPublicId,
      options.userInternalId,
    );
    if (!row) {
      return true;
    }

    const user = await this.userService.findUserRecordByPublicId(options.userPublicId);
    return user === null || user.deleted_at !== null;
  }

  async markProcessing(
    exportPublicId: string,
    userInternalId: number,
    databaseHandle?: WorkerDatabaseHandle,
    userPublicId?: string,
  ): Promise<void> {
    const exportRepository = this.resolveExportRepository(databaseHandle);
    if (databaseHandle !== undefined && userPublicId !== undefined) {
      const cancelled = await this.isExportJobCancelled({
        exportPublicId,
        userInternalId,
        userPublicId,
        databaseHandle,
      });
      if (cancelled) {
        throw new UserDataExportCancelledError();
      }
    }
    const updated = await exportRepository.updateStatus(exportPublicId, userInternalId, {
      status: USER_DATA_EXPORT_STATUSES.PROCESSING,
    });
    if (!updated) {
      throw new UserDataExportCancelledError();
    }
  }

  async completeExportJob(options: {
    exportPublicId: string;
    userInternalId: number;
    userPublicId: string;
    body: Buffer;
  }): Promise<void> {
    const s3Key = await withUserDatabaseContext(
      options.userPublicId,
      async (scopedDatabaseHandle) =>
        this.resolveExportArtifactS3Key(
          {
            exportPublicId: options.exportPublicId,
            userInternalId: options.userInternalId,
            userPublicId: options.userPublicId,
          },
          scopedDatabaseHandle,
        ),
    );

    await this.objectStorage.putObject({
      key: s3Key,
      body: options.body,
      contentType: 'application/gzip',
      metadata: {
        format: 'json',
        schema_version: '1',
      },
    });

    try {
      await withUserDatabaseContext(options.userPublicId, async (scopedDatabaseHandle) => {
        await this.finalizeExportAfterUpload(
          {
            exportPublicId: options.exportPublicId,
            userInternalId: options.userInternalId,
            userPublicId: options.userPublicId,
          },
          scopedDatabaseHandle,
        );
      });
    } catch (error) {
      await this.bestEffortDeleteUploadedExportArtifact(s3Key, {
        exportPublicId: options.exportPublicId,
        userInternalId: options.userInternalId,
      });
      throw error;
    }
  }

  private async finalizeExportAfterUpload(
    options: {
      exportPublicId: string;
      userInternalId: number;
      userPublicId: string;
    },
    databaseHandle: WorkerDatabaseHandle,
  ): Promise<void> {
    const cancelled = await this.isExportJobCancelled({
      exportPublicId: options.exportPublicId,
      userInternalId: options.userInternalId,
      userPublicId: options.userPublicId,
      databaseHandle,
    });
    if (cancelled) {
      throw new UserDataExportCancelledError();
    }

    const exportRepository = this.resolveExportRepository(databaseHandle);
    const completedAt = new Date();
    const updated = await exportRepository.updateStatus(
      options.exportPublicId,
      options.userInternalId,
      {
        status: USER_DATA_EXPORT_STATUSES.COMPLETED,
        completed_at: completedAt,
        failed_at: null,
        error_code: null,
      },
    );
    if (!updated) {
      throw new UserDataExportCancelledError();
    }
  }

  private async bestEffortDeleteUploadedExportArtifact(
    s3Key: string,
    context: { exportPublicId: string; userInternalId: number },
  ): Promise<void> {
    const objectDeleted = await this.objectStorage.deleteObject(s3Key);
    if (!objectDeleted) {
      logger.warn({ ...context, s3Key }, 'user-data-export.complete.s3DeleteFailed');
    }
  }

  private async resolveExportArtifactS3Key(
    options: {
      exportPublicId: string;
      userInternalId: number;
      userPublicId: string;
    },
    databaseHandle: WorkerDatabaseHandle,
  ): Promise<string> {
    const cancelled = await this.isExportJobCancelled({
      exportPublicId: options.exportPublicId,
      userInternalId: options.userInternalId,
      userPublicId: options.userPublicId,
      databaseHandle,
    });
    if (cancelled) {
      throw new UserDataExportCancelledError();
    }

    const exportRepository = this.resolveExportRepository(databaseHandle);
    const row = await exportRepository.findByPublicIdAndUserId(
      options.exportPublicId,
      options.userInternalId,
    );
    if (!row?.s3_key) {
      throw new UserDataExportCancelledError();
    }

    return row.s3_key;
  }

  async failExportJob(
    exportPublicId: string,
    userInternalId: number,
    errorCode: string,
    databaseHandle?: WorkerDatabaseHandle,
  ): Promise<void> {
    const exportRepository = this.resolveExportRepository(databaseHandle);
    await exportRepository.updateStatus(exportPublicId, userInternalId, {
      status: USER_DATA_EXPORT_STATUSES.FAILED,
      failed_at: new Date(),
      error_code: errorCode,
    });
  }

  async deleteAllExportsForUser(userInternalId: number, userPublicId: string): Promise<void> {
    // auth.user_data_exports is FORCE RLS keyed on app.current_user_id. Offboarding can be initiated
    // by an admin, so pin the context to the TARGET user (not the caller) so the owner-access policy
    // matches and the rows are actually removed in default scoped-RLS mode.
    //
    // sec-r4-R2: stream the user's export S3 keys in bounded keyset batches and
    // delete the objects with bounded concurrency. The previous version loaded
    // every export row into memory and fanned out one in-flight S3 request per
    // row via `Promise.all`, which is unbounded in both heap and outbound
    // throughput for a user with a large export history. Mirrors the upload
    // domain's `tombstoneAllByUserId` offboarding pattern.
    let afterId = 0;
    for (;;) {
      const rows = await withUserDatabaseContext(userPublicId, () =>
        this.exportRepository.findS3KeysByUserIdAfter(
          userInternalId,
          afterId,
          USER_DATA_EXPORT_OFFBOARDING_DELETE_BATCH_SIZE,
        ),
      );
      if (rows.length === 0) {
        break;
      }
      await this.deleteS3ObjectsWithBoundedConcurrency({
        s3Keys: rows.map((row) => row.s3_key).filter((s3Key): s3Key is string => s3Key !== null),
        userInternalId,
      });
      afterId = rows[rows.length - 1]!.id;
      if (rows.length < USER_DATA_EXPORT_OFFBOARDING_DELETE_BATCH_SIZE) {
        break;
      }
    }
    const deletedCount = await withUserDatabaseContext(userPublicId, () =>
      this.exportRepository.deleteAllByUserId(userInternalId),
    );
    if (deletedCount > 0) {
      logger.info({ userInternalId, deletedCount }, 'user-data-export.offboarding.deleted');
    }
  }

  /**
   * Deletes S3 objects in fixed-size concurrent chunks (sec-r4-R2). Failures
   * are logged but never rethrown — offboarding must continue to the database
   * delete regardless of upstream S3 hiccups, mirroring the upload domain's
   * tombstoneAllByUserId behaviour.
   */
  private async deleteS3ObjectsWithBoundedConcurrency(options: {
    s3Keys: readonly string[];
    userInternalId: number;
  }): Promise<void> {
    const { s3Keys, userInternalId } = options;
    for (
      let index = 0;
      index < s3Keys.length;
      index += USER_DATA_EXPORT_OFFBOARDING_DELETE_CONCURRENCY
    ) {
      const chunk = s3Keys.slice(index, index + USER_DATA_EXPORT_OFFBOARDING_DELETE_CONCURRENCY);
      await Promise.all(
        chunk.map(async (s3Key) => {
          const objectDeleted = await this.objectStorage.deleteObject(s3Key);
          if (!objectDeleted) {
            logger.warn({ userInternalId, s3Key }, 'user-data-export.offboarding.s3DeleteFailed');
          }
        }),
      );
    }
  }

  private resolveExportRepository(databaseHandle?: WorkerDatabaseHandle): UserDataExportRepository {
    return databaseHandle !== undefined
      ? createWorkerUserDataExportRepository(databaseHandle)
      : this.exportRepository;
  }

  async buildExportPayload(userPublicId: string): Promise<UserDataExport> {
    const user = await this.userService.requireUserRecordByPublicId(userPublicId);
    const crossDomain = this.requireCrossDomainServices();
    const fetchLimit = GDPR_EXPORT_MAX_ROWS_PER_TABLE + 1;

    const {
      memberships: userMembershipsRaw,
      sessions: userSessionsRaw,
      notifications: userNotificationsRaw,
      auditLogs: userAuditLogsRaw,
    } = await this.fetchExportCategoryRows({
      userPublicId,
      userInternalId: user.id,
      fetchLimit,
      crossDomain,
    });

    const truncatedCategories: string[] = [];
    const userMemberships = capExportCategory(
      userMembershipsRaw,
      'organizations',
      truncatedCategories,
    );
    const userSessions = capExportCategory(userSessionsRaw, 'sessions', truncatedCategories);
    const userNotifications = capExportCategory(
      userNotificationsRaw,
      'notifications',
      truncatedCategories,
    );
    const userAuditLogs = capExportCategory(
      userAuditLogsRaw,
      'audit_activity',
      truncatedCategories,
    );

    if (truncatedCategories.length > 0) {
      logger.warn(
        {
          userPublicId,
          rowCap: GDPR_EXPORT_MAX_ROWS_PER_TABLE,
          truncatedCategories,
        },
        'user-data-export.payload.truncated',
      );
    }

    return {
      user: {
        id: user.public_id,
        email: user.email,
        full_name: [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
        created_at: user.created_at.toISOString(),
      },
      organizations: userMemberships.map((membership) => ({
        name: membership.name,
        slug: membership.slug,
        role: membership.status,
        joined_at: membership.created_at.toISOString(),
      })),
      sessions: userSessions.map((session) => ({
        ip_address: session.ip_address,
        last_active_at: session.last_active_at.toISOString(),
        created_at: session.created_at.toISOString(),
      })),
      notifications: userNotifications.map((notification) => ({
        type: notification.type,
        title: notification.title,
        message: notification.message,
        created_at: notification.created_at.toISOString(),
      })),
      audit_activity: userAuditLogs.map((log) => ({
        action: log.action,
        resource_type: log.resource_type,
        created_at: log.created_at.toISOString(),
      })),
      truncation: {
        row_cap: GDPR_EXPORT_MAX_ROWS_PER_TABLE,
        truncated_categories: truncatedCategories,
      },
      exported_at: new Date().toISOString(),
    };
  }

  /**
   * Loads each export category via the owning domain's service, fetching one row beyond
   * {@link GDPR_EXPORT_MAX_ROWS_PER_TABLE} so the caller can detect and disclose truncation.
   */
  private async fetchExportCategoryRows(options: {
    userPublicId: string;
    userInternalId: number;
    fetchLimit: number;
    crossDomain: UserDataExportCrossDomainServices;
  }) {
    const [memberships_, sessions_, notifications_, auditLogs_] = await Promise.all([
      options.crossDomain.membershipService.listOrganizationsForUserDataExport({
        userPublicId: options.userPublicId,
        userInternalId: options.userInternalId,
        limit: options.fetchLimit,
      }),
      options.crossDomain.authSessionService.listForUserDataExport({
        userPublicId: options.userPublicId,
        limit: options.fetchLimit,
      }),
      options.crossDomain.notificationService.listForUserDataExport({
        userPublicId: options.userPublicId,
        limit: options.fetchLimit,
      }),
      options.crossDomain.auditService.listActivityForUserDataExport({
        userPublicId: options.userPublicId,
        limit: options.fetchLimit,
      }),
    ]);

    return {
      memberships: memberships_,
      sessions: sessions_,
      notifications: notifications_,
      auditLogs: auditLogs_,
    };
  }
}
