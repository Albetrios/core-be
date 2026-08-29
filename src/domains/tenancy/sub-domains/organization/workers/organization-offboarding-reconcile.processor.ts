import { and, isNotNull, isNull, lt, ne } from 'drizzle-orm';
import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import {
  PRINCIPAL_SCOPE,
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { captureException } from '@/infrastructure/observability/sentry/sentry.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/index.js';
import {
  ORGANIZATION_OFFBOARDING_RECONCILE_BATCH,
  ORGANIZATION_OFFBOARDING_STUCK_AFTER_MINUTES,
} from './organization-offboarding-reconcile.constants.js';

/**
 * Minimal service surface the reconciler drives — `OrganizationService.resumeOffboarding`.
 *
 * @remarks Structural (not the full `OrganizationService`) so the worker depends only
 * on the one idempotent method it calls, keeping the processor unit-testable with a stub.
 */
export interface OrganizationOffboardingReconcileService {
  resumeOffboarding(scope: OrganizationPrincipalDatabaseScope): Promise<void>;
}

/**
 * Outcome of one reconcile tick.
 *
 * @remarks `scanned` is the number of stuck rows found this tick (bounded by the
 * batch size); `resumed` + `failed` partition them by re-drive outcome.
 */
export interface OrganizationOffboardingReconcileResult {
  scanned: number;
  resumed: number;
  failed: number;
}

/**
 * Finds organization offboardings that started but never finished and re-drives
 * them (TEN-06 durable reconciler).
 *
 * @remarks
 * - **Algorithm:** under the global-retention cleanup context (no per-tenant RLS),
 *   selects up to `ORGANIZATION_OFFBOARDING_RECONCILE_BATCH` non-PERSONAL rows where
 *   `deletion_started_at` is older than `ORGANIZATION_OFFBOARDING_STUCK_AFTER_MINUTES`
 *   and `deleted_at IS NULL`, then calls `resumeOffboarding` per row OUTSIDE that scan
 *   context (the service opens its own org transactions + does Stripe/S3 I/O). The
 *   offboarding is idempotent, so a partial run resumes and completes (sets
 *   `deleted_at`), dropping out of the next scan.
 * - **Failure modes:** a per-row failure is counted, warn-logged, and reported to
 *   Sentry; the row stays for the next tick. Scan errors propagate to BullMQ
 *   retry / DLQ.
 * - **Side effects:** drives logo/upload cleanup, subscription cancel, soft-delete,
 *   and permission-cache purge per stuck row.
 * - **Notes:** PERSONAL organizations are excluded (never deletable standalone);
 *   scheduled (cron) via `infrastructure/queue/scheduler.ts`.
 */
export async function runOrganizationOffboardingReconcileJob(
  service: OrganizationOffboardingReconcileService,
): Promise<OrganizationOffboardingReconcileResult> {
  const cutoff = new Date(
    Date.now() - ORGANIZATION_OFFBOARDING_STUCK_AFTER_MINUTES * MILLISECONDS_PER_MINUTE,
  );

  const stuck = await withMaintenanceDatabaseContext(
    MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP,
    (databaseHandle) =>
      databaseHandle
        .select({ public_id: organizations.public_id })
        .from(organizations)
        .where(
          and(
            isNotNull(organizations.deletion_started_at),
            isNull(organizations.deleted_at),
            lt(organizations.deletion_started_at, cutoff),
            ne(organizations.type, 'PERSONAL'),
          ),
        )
        .limit(ORGANIZATION_OFFBOARDING_RECONCILE_BATCH),
  );

  let resumed = 0;
  let failed = 0;
  for (const { public_id } of stuck) {
    try {
      await service.resumeOffboarding(PRINCIPAL_SCOPE.JOB({ organizationPublicId: public_id }));
      resumed += 1;
    } catch (error) {
      failed += 1;
      logger.warn(
        { error, publicId: public_id },
        'organization-offboarding-reconcile.resume_failed',
      );
      captureException(error, {
        organizationId: public_id,
        tags: { source: 'organization-offboarding-reconcile' },
      });
    }
  }

  if (stuck.length > 0) {
    logger.info(
      { scanned: stuck.length, resumed, failed },
      'organization-offboarding-reconcile.completed',
    );
  }

  return { scanned: stuck.length, resumed, failed };
}
