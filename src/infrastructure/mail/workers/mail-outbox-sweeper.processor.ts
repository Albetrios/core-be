import {
  findStalePendingMailOutboxIds,
  reclaimStaleSendingMailOutboxIds,
} from '@/infrastructure/mail/mail-outbox.repository.js';
import { enqueueMailOutboxJob } from '@/infrastructure/mail/queues/mail.queue.js';
import { MAIL_OUTBOX_RECLAIM_CIRCUIT_OPEN_MULTIPLIER } from '@/infrastructure/mail/workers/mail-outbox-sweeper.constants.js';
import { resendCircuit } from '@/infrastructure/resilience/circuit-breaker.js';
import { env } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';

const DEFAULT_SWEEP_BATCH_SIZE = 100;

/**
 * Result of one sweeper pass: rows considered (`scannedCount`), rows whose status
 * was rolled back from `sending` to `pending` (`reclaimedSendingCount`), and rows
 * successfully re-added to the mail queue (`reEnqueuedCount`).
 *
 * @remarks
 * - **Algorithm:** populated by {@link runMailOutboxSweeperJob} after reclaim +
 *   pending scan + per-id enqueue.
 * - **Failure modes:** counts are best-effort — a failed enqueue still increments
 *   `scannedCount` but not `reEnqueuedCount`.
 * - **Side effects:** none from this type alone; it's a return shape.
 * - **Notes:** logged at `info` for ops dashboards.
 */
export type MailOutboxSweeperJobResult = {
  scannedCount: number;
  reclaimedSendingCount: number;
  reEnqueuedCount: number;
};

/**
 * Re-enqueues `mail_outbox` rows that BullMQ lost track of so the transactional
 * outbox stays drained.
 *
 * @remarks
 * - **Algorithm:** runs inside a `system_table` worker context (no tenant RLS);
 *   reclaims rows stuck in `sending` beyond `MAIL_OUTBOX_RECLAIM_SENDING_MINUTES`
 *   (a cutoff comfortably above worst-case delivery time), then scans `pending`
 *   rows older than `MAIL_OUTBOX_SWEEP_PENDING_MINUTES`, and re-enqueues each id.
 *   Resend idempotency keys (set in the mail processor) de-duplicate any send
 *   that overlaps a premature reclaim (audit #20).
 * - **Circuit-aware:** when the Resend circuit breaker is OPEN the sending-reclaim
 *   window is widened by `MAIL_OUTBOX_RECLAIM_CIRCUIT_OPEN_MULTIPLIER`, so rows stuck
 *   because the provider is down are not rolled back and re-enqueued against it.
 *   The per-row retry cap + alert is BullMQ's `MAIL_QUEUE_MAX_ATTEMPTS` → `<queue>-dlq`
 *   with final-failure Sentry (no separate per-row counter needed).
 * - **Failure modes:** a failed `enqueueMailOutboxJob` per row is logged at warn
 *   and skipped — the next sweep retries it.
 * - **Side effects:** updates `auth.mail_outbox.status`/`updated_at` for reclaimed
 *   rows; adds BullMQ jobs to `MAIL_QUEUE_NAME`.
 * - **Notes:** idempotent and bounded by `MAIL_OUTBOX_SWEEP_BATCH_SIZE`; safe to
 *   run concurrently with the mail worker because the claim transition is atomic.
 */
export async function runMailOutboxSweeperJob(): Promise<MailOutboxSweeperJobResult> {
  return withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.SYSTEM_TABLE_WORKER, () =>
    runMailOutboxSweeperJobInner(),
  );
}

async function runMailOutboxSweeperJobInner(): Promise<MailOutboxSweeperJobResult> {
  const pendingOlderThanMinutes = env.MAIL_OUTBOX_SWEEP_PENDING_MINUTES;
  const reclaimSendingOlderThanMinutes = env.MAIL_OUTBOX_RECLAIM_SENDING_MINUTES;
  // Circuit-aware reclaim: when Resend is OPEN (down), widen the sending-reclaim window so stuck
  // rows are not rolled back to pending and re-enqueued against a failing provider (audit P2-14).
  const resendCircuitState = await resendCircuit.getState();
  const reclaimWindowMultiplier =
    resendCircuitState === 'OPEN' ? MAIL_OUTBOX_RECLAIM_CIRCUIT_OPEN_MULTIPLIER : 1;
  const effectiveReclaimSendingMinutes = reclaimSendingOlderThanMinutes * reclaimWindowMultiplier;
  const pendingCutoff = new Date(Date.now() - pendingOlderThanMinutes * 60_000);
  const sendingCutoff = new Date(Date.now() - effectiveReclaimSendingMinutes * 60_000);
  const batchSize = env.MAIL_OUTBOX_SWEEP_BATCH_SIZE ?? DEFAULT_SWEEP_BATCH_SIZE;

  const reclaimedSendingIds = await reclaimStaleSendingMailOutboxIds(sendingCutoff, batchSize);
  const pendingBatchSize = Math.max(0, batchSize - reclaimedSendingIds.length);
  const stalePendingIds =
    pendingBatchSize > 0
      ? await findStalePendingMailOutboxIds(pendingCutoff, pendingBatchSize)
      : [];
  const staleMailOutboxIds = [...reclaimedSendingIds, ...stalePendingIds];
  let reEnqueuedCount = 0;

  for (const mailOutboxId of staleMailOutboxIds) {
    try {
      await enqueueMailOutboxJob(mailOutboxId, { requestId: 'mail-outbox-sweeper' });
      reEnqueuedCount += 1;
    } catch (error) {
      logger.warn({ error, mailOutboxId }, 'mail-outbox-sweeper.re_enqueue.failed');
    }
  }

  logger.info(
    {
      pendingOlderThanMinutes,
      reclaimSendingOlderThanMinutes,
      resendCircuitState,
      effectiveReclaimSendingMinutes,
      scannedCount: staleMailOutboxIds.length,
      reclaimedSendingCount: reclaimedSendingIds.length,
      reEnqueuedCount,
    },
    'mail-outbox-sweeper.completed',
  );

  return {
    scannedCount: staleMailOutboxIds.length,
    reclaimedSendingCount: reclaimedSendingIds.length,
    reEnqueuedCount,
  };
}
