import { Worker } from 'bullmq';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import {
  getDefaultWorkerOptions,
  RETENTION_WORKER_CONCURRENCY,
} from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { AUDIT_OUTBOX_DRAIN_QUEUE_NAME } from '@/domains/audit/workers/audit-outbox-drain.constants.js';
import { runAuditOutboxDrainJob } from '@/domains/audit/workers/audit-outbox-drain.processor.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';

/**
 * BullMQ worker that drains `audit.outbox` PENDING rows into `audit.logs`. Runs on
 * the repeatable schedule registered in `src/infrastructure/queue/scheduler.ts`.
 *
 * @remarks
 * - **Algorithm:** each job opens {@link withMaintenanceDatabaseContext}
 *   (transaction + `app.audit_outbox_drain = 'true'`) and delegates to
 *   {@link runAuditOutboxDrainJob}. Concurrency is bounded so two drain workers
 *   never race on the same batch — {@link runAuditOutboxDrainJob} also uses
 *   `FOR UPDATE SKIP LOCKED` as belt-and-suspenders.
 * - **Failure modes:** any thrown error rolls back the drain transaction so the
 *   outbox rows stay PENDING and the next pass retries cleanly. Stalled jobs are
 *   surfaced via a `stalled` log warning. The DLQ + Sentry hook is attached by
 *   the queue bootstrap.
 * - **Side effects:** writes into `audit.logs`, updates `audit.outbox`. No
 *   external I/O.
 * - **Notes:** uses default (mail/notification) lock settings rather than the
 *   retention long lock because each pass is bounded by `AUDIT_OUTBOX_DRAIN_BATCH_SIZE`
 *   and is expected to complete in well under 30s on the default schedule.
 */
export function createAuditOutboxDrainWorker(): WorkerHandle {
  const worker = new Worker(
    AUDIT_OUTBOX_DRAIN_QUEUE_NAME,
    async () =>
      withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.audit_outbox_drain, (databaseHandle) =>
        runAuditOutboxDrainJob(databaseHandle),
      ),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: RETENTION_WORKER_CONCURRENCY,
      ...getDefaultWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn({ jobId, queue: AUDIT_OUTBOX_DRAIN_QUEUE_NAME }, 'audit.outbox.drain.stalled');
  });

  return buildWorkerHandle(worker, AUDIT_OUTBOX_DRAIN_QUEUE_NAME);
}
