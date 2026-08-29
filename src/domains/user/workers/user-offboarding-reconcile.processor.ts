import { and, isNotNull, isNull, lt } from 'drizzle-orm';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { users } from '@/domains/user/user.schema.js';
import { captureException } from '@/infrastructure/observability/sentry/sentry.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/index.js';
import {
  USER_OFFBOARDING_RECONCILE_BATCH,
  USER_OFFBOARDING_STUCK_AFTER_MINUTES,
} from './user-offboarding-reconcile.constants.js';

/**
 * Minimal service surface the reconciler drives — `UserService.resumeOffboarding`.
 *
 * @remarks Structural (not the full `UserService`) so the worker depends only on the
 * one idempotent method it calls, keeping the processor unit-testable with a stub.
 */
export interface UserOffboardingReconcileService {
  resumeOffboarding(public_id: string): Promise<void>;
}

/**
 * Outcome of one reconcile tick.
 *
 * @remarks `scanned` is the number of stuck rows found this tick (bounded by the
 * batch size); `resumed` + `failed` partition them by re-drive outcome.
 */
export interface UserOffboardingReconcileResult {
  scanned: number;
  resumed: number;
  failed: number;
}

/**
 * Finds user offboardings that started but never finished and re-drives them
 * (USER-04 / USER-09 durable reconciler).
 *
 * @remarks
 * - **Algorithm:** under the global-retention cleanup context (no per-tenant RLS),
 *   selects up to `USER_OFFBOARDING_RECONCILE_BATCH` rows where
 *   `deletion_started_at` is older than `USER_OFFBOARDING_STUCK_AFTER_MINUTES` and
 *   `deleted_at IS NULL`, then calls `resumeOffboarding` for each OUTSIDE that scan
 *   context (the service opens its own per-user transactions). Each step of
 *   `softDeleteUserWithOffboarding` is idempotent, so a partial offboarding resumes
 *   from where it stalled and completes (sets `deleted_at`), dropping out of the
 *   next scan.
 * - **Failure modes:** a per-row failure is counted, warn-logged, and reported to
 *   Sentry; the row stays for the next tick. Unexpected scan errors propagate to
 *   BullMQ retry / DLQ.
 * - **Side effects:** drives the full user offboarding (session/credential revoke,
 *   upload/export purge, soft-delete, S3 avatar cleanup) for each stuck row.
 * - **Notes:** scheduled (cron) via `infrastructure/queue/scheduler.ts`; never wire
 *   workers directly in `bootstrap.ts`.
 */
export async function runUserOffboardingReconcileJob(
  service: UserOffboardingReconcileService,
): Promise<UserOffboardingReconcileResult> {
  const cutoff = new Date(
    Date.now() - USER_OFFBOARDING_STUCK_AFTER_MINUTES * MILLISECONDS_PER_MINUTE,
  );

  const stuck = await withMaintenanceDatabaseContext(
    MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
    (databaseHandle) =>
      databaseHandle
        .select({ public_id: users.public_id })
        .from(users)
        .where(
          and(
            isNotNull(users.deletion_started_at),
            isNull(users.deleted_at),
            lt(users.deletion_started_at, cutoff),
          ),
        )
        .limit(USER_OFFBOARDING_RECONCILE_BATCH),
  );

  let resumed = 0;
  let failed = 0;
  for (const { public_id } of stuck) {
    try {
      await service.resumeOffboarding(public_id);
      resumed += 1;
    } catch (error) {
      failed += 1;
      logger.warn({ error, publicId: public_id }, 'user-offboarding-reconcile.resume_failed');
      captureException(error, {
        userId: public_id,
        tags: { source: 'user-offboarding-reconcile' },
      });
    }
  }

  if (stuck.length > 0) {
    logger.info({ scanned: stuck.length, resumed, failed }, 'user-offboarding-reconcile.completed');
  }

  return { scanned: stuck.length, resumed, failed };
}
