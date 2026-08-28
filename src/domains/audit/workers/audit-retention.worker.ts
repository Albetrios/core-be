import { Worker } from 'bullmq';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import {
  getRetentionWorkerOptions,
  RETENTION_WORKER_CONCURRENCY,
} from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import { AUDIT_RETENTION_QUEUE_NAME } from '@/domains/audit/workers/audit-retention.constants.js';
import { runAuditRetentionJob } from '@/domains/audit/workers/audit-retention.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';

/**
 * BullMQ worker that deletes audit logs older than the configured retention period.
 * Repeatable schedule is registered in `src/infrastructure/queue/scheduler.ts`.
 *
 * @remarks
 * - **Algorithm:** wraps each job in {@link withMaintenanceDatabaseContext}
 *   (sets `app.global_retention_cleanup=true` so the tenant-isolation policy on
 *   `audit.logs` permits cross-tenant deletes) and delegates to `runAuditRetentionJob`.
 * - **Failure modes:** processor errors are bubbled to BullMQ for retry; stalled
 *   jobs are surfaced via a `stalled` log warning. The retention DLQ + Sentry hook
 *   is attached by the queue bootstrap.
 * - **Side effects:** hard-deletes expired rows from `audit.logs` in batches.
 *   No events or external calls.
 * - **Notes:** concurrency is bounded by {@link RETENTION_WORKER_CONCURRENCY};
 *   stall/lock tuning comes from {@link getRetentionWorkerOptions} so the job
 *   can run for the duration of a full retention sweep without being reclaimed.
 */
export function createAuditRetentionWorker(): WorkerHandle {
  const worker = new Worker(
    AUDIT_RETENTION_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.GLOBAL_RETENTION_CLEANUP, (databaseHandle) =>
        runAuditRetentionJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getRetentionWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn({ jobId, queue: AUDIT_RETENTION_QUEUE_NAME }, 'audit-retention.stalled');
  });

  return buildWorkerHandle(worker, AUDIT_RETENTION_QUEUE_NAME);
}
