import {
  findDeadLetterJobsForAutoRetry,
  markDeadLetterJobAutoRetryResolved,
} from '@/infrastructure/queue/dlq/dead-letter.repository.js';
import { isDeadLetterSourceQueueCircuitClosed } from '@/infrastructure/queue/dlq/dlq-auto-retry-circuit.util.js';
import {
  getDlqAutoRetryState,
  isDeadLetterJobEligibleForAutoRetry,
  recordDlqAutoRetryAttempt,
} from '@/infrastructure/queue/dlq/dlq-auto-retry.store.js';
import {
  autoReplayDeadLetterFromLedger,
  DLQ_REPLAY_SOURCE_QUEUE_NAMES,
} from '@/infrastructure/queue/dlq/dlq-replay.util.js';
import { env } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/maintenance-database.context.js';

/**
 * Outcome counters for one DLQ auto-retry sweeper pass.
 *
 * @remarks
 * - **Algorithm:** populated by {@link runDlqAutoRetryJob} after scanning ledger rows.
 * - **Failure modes:** counts are best-effort — skipped rows still increment `scannedCount`.
 * - **Side effects:** none from this type alone.
 * - **Notes:** logged at `info` when any row was replayed.
 */
export type DlqAutoRetryJobResult = {
  scannedCount: number;
  replayedCount: number;
  skippedCircuitOpenCount: number;
  skippedCooldownCount: number;
  skippedBudgetCount: number;
  skippedPayloadCount: number;
};

/**
 * Scans `audit.dead_letter_jobs` and re-enqueues replayable work when outbound circuits are
 * CLOSED, the cooldown has elapsed, and the auto-retry budget allows another attempt.
 *
 * @remarks
 * - **Algorithm:** query oldest ledger rows past the cooldown cutoff, filter by Redis retry
 *   budget + circuit state, replay via {@link autoReplayDeadLetterFromLedger}, increment Redis counter.
 * - **Failure modes:** per-row replay errors log at warn; Postgres scan errors propagate to BullMQ.
 * - **Side effects:** BullMQ re-enqueue, optional DLQ mirror removal, audit log, Redis counter write.
 * - **Notes:** no-op when `DLQ_AUTO_RETRY_ENABLED` is false; bounded by `DLQ_AUTO_RETRY_BATCH_SIZE`.
 */
export async function runDlqAutoRetryJob(): Promise<DlqAutoRetryJobResult> {
  if (!env.DLQ_AUTO_RETRY_ENABLED) {
    return {
      scannedCount: 0,
      replayedCount: 0,
      skippedCircuitOpenCount: 0,
      skippedCooldownCount: 0,
      skippedBudgetCount: 0,
      skippedPayloadCount: 0,
    };
  }

  return withMaintenanceDatabaseContext(MAINTENANCE_SCOPE.system_table_worker, () =>
    runDlqAutoRetryJobInner(),
  );
}

async function runDlqAutoRetryJobInner(): Promise<DlqAutoRetryJobResult> {
  const cooldownMs = env.DLQ_AUTO_RETRY_COOLDOWN_MINUTES * 60_000;
  const failedBefore = new Date(Date.now() - cooldownMs);
  const batchSize = env.DLQ_AUTO_RETRY_BATCH_SIZE;

  const ledgerRows = await findDeadLetterJobsForAutoRetry({
    sourceQueues: DLQ_REPLAY_SOURCE_QUEUE_NAMES,
    failedBefore,
    limit: batchSize,
  });

  const result: DlqAutoRetryJobResult = {
    scannedCount: ledgerRows.length,
    replayedCount: 0,
    skippedCircuitOpenCount: 0,
    skippedCooldownCount: 0,
    skippedBudgetCount: 0,
    skippedPayloadCount: 0,
  };

  for (const ledgerRow of ledgerRows) {
    const state = await getDlqAutoRetryState(ledgerRow.id);
    if ((state?.count ?? 0) >= env.DLQ_AUTO_RETRY_MAX_COUNT) {
      result.skippedBudgetCount += 1;
      // Budget exhausted: stamp the ledger row resolved so it leaves the scan permanently. Without
      // this it would be re-fetched at the head every tick (starving newer rows) and would replay
      // again once the Redis budget counter's TTL expires.
      await markDeadLetterJobAutoRetryResolved(ledgerRow.id);
      continue;
    }
    if (
      !isDeadLetterJobEligibleForAutoRetry({
        state,
        failedAt: ledgerRow.failed_at,
        maxCount: env.DLQ_AUTO_RETRY_MAX_COUNT,
        cooldownMs,
      })
    ) {
      result.skippedCooldownCount += 1;
      continue;
    }

    const circuitClosed = await isDeadLetterSourceQueueCircuitClosed(ledgerRow.source_queue);
    if (!circuitClosed) {
      result.skippedCircuitOpenCount += 1;
      continue;
    }

    const nextAttemptCount = (state?.count ?? 0) + 1;
    try {
      const replayResult = await autoReplayDeadLetterFromLedger({
        ledgerRow,
        autoRetryCount: nextAttemptCount,
      });
      if (replayResult.status === 'payload_not_reconstructable') {
        result.skippedPayloadCount += 1;
        continue;
      }

      await recordDlqAutoRetryAttempt(ledgerRow.id);
      result.replayedCount += 1;
    } catch (error) {
      logger.warn({ error, deadLetterJobId: ledgerRow.id }, 'dlq-auto-retry.replay.failed');
    }
  }

  if (result.replayedCount > 0 || result.scannedCount > 0) {
    logger.info(result, 'dlq-auto-retry.completed');
  }

  return result;
}
