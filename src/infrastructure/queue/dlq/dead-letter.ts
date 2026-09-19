/**
 * Dead-letter queues: after a job exhausts retries, enqueue a snapshot to `<source>-dlq`
 * and emit one Sentry issue (grouped by queue + job name).
 */

import { Queue, UnrecoverableError, type Job, type Worker } from 'bullmq';
import { isSentryInitialized, Sentry } from '@/infrastructure/observability/sentry/sentry.js';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import { insertDeadLetterJob } from '@/infrastructure/queue/dlq/dead-letter.repository.js';
import { THIRTY_DAYS_SECONDS } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { redactSensitive } from '@/shared/utils/security/sensitive-redaction.util.js';

/** Suffix appended to a source queue name to derive its dead-letter queue (`<source>-dlq`). */
export const DLQ_QUEUE_SUFFIX = '-dlq';

const DEAD_LETTER_JOB_NAME = 'dead-letter';

/**
 * Dead-letter jobs are retained for 30 days so operators have time to inspect and replay
 * them, after which BullMQ evicts the records from Redis to prevent unbounded growth and
 * OOM. Replay flows must finish (or re-enqueue) within this window.
 */
const DEAD_LETTER_RETENTION_SECONDS = THIRTY_DAYS_SECONDS;

const deadLetterQueuesByName = new Map<string, Queue>();

/**
 * Snapshot persisted on the `<source>-dlq` queue when a job exhausts its retry budget.
 * Carries only a hand-picked metadata summary (see {@link buildReplayJobPayload}) — the
 * original payload is intentionally not stored so secrets, HTML bodies, and full webhook
 * payloads never sit in Redis past the 30-day retention window.
 */
export interface DeadLetterJobData {
  original_queue: string;
  original_job_id?: string;
  original_job_name: string;
  replay_attempt?: number;
  /** Metadata only — never store secrets, HTML, or full webhook payloads in Redis. */
  original_data_summary: Record<string, unknown>;
  failed_reason: string;
  error_stack?: string;
  attempts_made: number;
  max_attempts: number;
  failed_at: string;
}

/**
 * Extracts the non-secret replay keys from a failed job's data into the DLQ summary.
 *
 * Each replayable queue type contributes the identifiers {@link buildReplayJobPayload} needs
 * to reconstruct its job: mail (`mail_outbox_id`), webhook delivery (`delivery_attempt_id` +
 * `organization_public_id`), notification (`notification_id` + `organization_public_id`), and
 * Stripe webhook (`stripe_event_id`). These are public/internal identifiers only — full
 * payloads, HTML bodies, signing secrets, and PII are deliberately left out so nothing
 * sensitive sits in Redis or `audit.dead_letter_jobs` past the retention window.
 */
function summarizeJobDataForDeadLetter(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null) {
    return {};
  }
  const record = data as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  if (record.mailOutboxId !== undefined) summary.mail_outbox_id = record.mailOutboxId;
  if (record.deliveryAttemptId !== undefined) {
    summary.delivery_attempt_id = record.deliveryAttemptId;
  }
  if (record.webhookId !== undefined) summary.webhook_id = record.webhookId;
  if (record.eventType !== undefined) summary.event_type = record.eventType;
  if (record.notificationId !== undefined) summary.notification_id = record.notificationId;
  // Tenant scope for webhook + notification replay (notification jobs may carry an explicit null).
  if (record.organizationPublicId !== undefined) {
    summary.organization_public_id = record.organizationPublicId;
  }
  // Stripe event id is required to re-fetch and replay a Stripe webhook job.
  if (record.stripeEventId !== undefined) summary.stripe_event_id = record.stripeEventId;
  return summary;
}

/** Resolves the BullMQ dead-letter queue name (`<source>-dlq`) for a source queue. */
export function getDeadLetterQueueName(sourceQueueName: string): string {
  return `${sourceQueueName}${DLQ_QUEUE_SUFFIX}`;
}

/** Batch variant of {@link getDeadLetterQueueName}, used by the dashboard and DLQ replay tool. */
export function listDeadLetterQueueNames(sourceQueueNames: readonly string[]): string[] {
  return sourceQueueNames.map((name) => getDeadLetterQueueName(name));
}

/**
 * Returns the pooled BullMQ producer for a `<source>-dlq` queue, creating it on first use.
 *
 * @remarks
 * - **Algorithm:** one long-lived {@link Queue} per DLQ name, cached in a module map; the
 *   dead-letter writer and the depth sampler share the same client and Redis connection.
 * - **Failure modes:** none at call time — the connection is opened lazily by BullMQ, so a
 *   Redis outage surfaces on the first command, not here.
 * - **Side effects:** the first call per name opens a Redis connection that lives until
 *   {@link closeDeadLetterQueues} runs at shutdown.
 * - **Notes:** sharing the pool is what keeps `/metrics` and `/readyz` fast on a hosted Redis —
 *   a fresh connect + script load + close per DLQ costs several round trips each (sec-DLQ-scrape).
 */
export function getDeadLetterQueueClient(deadLetterQueueName: string): Queue {
  const existing = deadLetterQueuesByName.get(deadLetterQueueName);
  if (existing) return existing;
  const queue = new Queue(deadLetterQueueName, {
    connection: getBullMQConnectionOptions(),
    // Queue-level default eviction so DLQ snapshots are bounded even when they sit
    // in `waiting` state (BullMQ `removeOn{Complete,Fail}` per-add only fires on
    // state transition; a DLQ job that never completes/fails would otherwise grow
    // unbounded outside any retention policy).
    defaultJobOptions: {
      removeOnComplete: { age: DEAD_LETTER_RETENTION_SECONDS, count: 1_000 },
      removeOnFail: { age: DEAD_LETTER_RETENTION_SECONDS, count: 1_000 },
    },
  });
  deadLetterQueuesByName.set(deadLetterQueueName, queue);
  return queue;
}

/**
 * Resolves a job's retry budget as the ledger and the final-failure check understand it.
 *
 * @remarks
 * - **Algorithm:** BullMQ stores `attempts: 0` on every job added without an explicit
 *   `attempts` option (its "no retries" encoding — repeatable/cron jobs from the scheduler and
 *   most ad-hoc adds), and `undefined` never reaches a worker. Both mean "exactly one attempt",
 *   so the budget is clamped to a minimum of 1.
 * - **Failure modes:** none; pure.
 * - **Side effects:** none.
 * - **Notes:** `audit.dead_letter_jobs` enforces `CHECK (max_attempts >= 1)`. Before this
 *   clamp a cron job's terminal failure wrote `max_attempts = 0`, the insert violated the
 *   constraint and the durable ledger silently missed every scheduled-job dead-letter while the
 *   Redis mirror still recorded it (observed on `stripe-webhook-event-catchup`).
 */
export function resolveJobMaxAttempts(job: Pick<Job, 'opts'>): number {
  return Math.max(1, job.opts.attempts ?? 1);
}

/**
 * Returns true when the job has used its last retry (BullMQ `failed` event).
 */
export function isFinalJobFailure(job: Job | undefined): boolean {
  if (!job) return false;
  const maxAttempts = resolveJobMaxAttempts(job);
  return job.attemptsMade >= maxAttempts;
}

/**
 * Persists a job snapshot to `<sourceQueueName>-dlq` after the final retry has failed.
 *
 * @remarks
 * - **Algorithm:** lazily opens (or reuses) a BullMQ {@link Queue} for the DLQ, builds a
 *   safe {@link DeadLetterJobData} record via `summarizeJobDataForDeadLetter`, and adds a
 *   `dead-letter` job keyed by `dlq-<source>-<originalJobId>` for replay deduplication.
 * - **Failure modes:** any Redis error bubbles back to {@link attachDeadLetterAndAlerting},
 *   which logs `queue.dead_letter.enqueue_failed`; the original failed job remains in
 *   BullMQ's `failed` set so operators can still inspect it.
 * - **Side effects:** writes a row to the DLQ Redis stream with 30-day retention on
 *   `removeOnComplete` and `removeOnFail` (and queue-level defaults that also bound
 *   `waiting` jobs); no Postgres writes.
 * - **Notes:** the DLQ Redis `jobId` is `dlq-<source>-<originalJobId>-attempt-<attemptsMade>`
 *   so a replayed job that fails terminally again produces a FRESH snapshot rather than
 *   colliding with the prior failure's `failed_reason`/`error_stack`/`failed_at` (BullMQ's
 *   duplicate-jobId semantics would otherwise emit a `duplicated` event and keep the stale
 *   snapshot). The durable Postgres ledger (`audit.dead_letter_jobs`) is independently
 *   unique-keyed and remains the source of truth. Never store secrets here.
 */
export async function enqueueDeadLetter(
  sourceQueueName: string,
  job: Job,
  error: unknown,
): Promise<void> {
  const deadLetterQueueName = getDeadLetterQueueName(sourceQueueName);
  const queue = getDeadLetterQueueClient(deadLetterQueueName);
  const errorObject = error instanceof Error ? error : new Error(String(error));
  const maxAttempts = resolveJobMaxAttempts(job);

  const data: DeadLetterJobData = omitUndefined({
    original_queue: sourceQueueName,
    original_job_id: job.id ?? undefined,
    original_job_name: job.name,
    original_data_summary: summarizeJobDataForDeadLetter(job.data),
    // audit-#W2: scrub URL/query-embedded secrets from the free-text error fields before they land
    // in the 30-day Redis mirror, mirroring the Sentry `beforeSend` path (payload_summary is already
    // whitelisted). Latent today, but a future error message interpolating a token must not persist.
    failed_reason: redactSensitive(errorObject.message),
    error_stack: redactSensitive(errorObject.stack),
    attempts_made: job.attemptsMade,
    max_attempts: maxAttempts,
    failed_at: new Date().toISOString(),
  });

  const safeOriginalJobIdentifier = job.id ?? job.opts.jobId ?? 'unknown';
  const deadLetterJobIdentifier = `dlq-${sourceQueueName}-${String(safeOriginalJobIdentifier)}-attempt-${String(job.attemptsMade)}`;

  await queue.add(DEAD_LETTER_JOB_NAME, data, {
    jobId: deadLetterJobIdentifier,
    removeOnComplete: { age: DEAD_LETTER_RETENTION_SECONDS },
    removeOnFail: { age: DEAD_LETTER_RETENTION_SECONDS },
  });

  logger.info(
    {
      sourceQueue: sourceQueueName,
      deadLetterQueue: deadLetterQueueName,
      originalJobId: job.id,
      originalJobName: job.name,
    },
    'queue.dead_letter.enqueued',
  );
}

/**
 * Persists one terminal job failure to `audit.dead_letter_jobs` (the durable source of
 * truth) before the best-effort Redis mirror.
 *
 * @remarks
 * - **Algorithm:** builds a redacted record (reusing {@link summarizeJobDataForDeadLetter})
 *   and inserts it via {@link insertDeadLetterJob} using the base database connection.
 * - **Failure modes:** never throws — a Postgres write failure is logged
 *   (`queue.dead_letter.persist_failed`) and captured to Sentry so the `failed` listener
 *   stays stable even when both Redis and Postgres are degraded.
 * - **Side effects:** appends one row to `audit.dead_letter_jobs`; emits one structured log
 *   line (`queue.dead_letter.persisted` on success).
 * - **Notes:** runs outside any request/worker DB context; identifiers are passed
 *   explicitly (no RLS session reliance).
 */
async function persistDeadLetterFailureToPostgres(
  queueName: string,
  job: Job,
  error: unknown,
): Promise<void> {
  const errorObject = error instanceof Error ? error : new Error(String(error));
  const maxAttempts = resolveJobMaxAttempts(job);

  try {
    await insertDeadLetterJob({
      source_queue: queueName,
      dead_letter_queue: getDeadLetterQueueName(queueName),
      job_id: job.id ?? null,
      job_name: job.name,
      payload_summary: summarizeJobDataForDeadLetter(job.data),
      // audit-#W2: same value-level redaction for the durable Postgres ledger.
      failed_reason: redactSensitive(errorObject.message),
      error_stack: redactSensitive(errorObject.stack ?? null),
      attempts_made: job.attemptsMade,
      max_attempts: maxAttempts,
      failed_at: new Date(),
    });

    logger.info(
      { queue: queueName, jobId: job.id, jobName: job.name },
      'queue.dead_letter.persisted',
    );
  } catch (persistError) {
    logger.error(
      {
        persistError: persistError instanceof Error ? persistError.message : String(persistError),
        queue: queueName,
        jobId: job.id,
        jobName: job.name,
      },
      'queue.dead_letter.persist_failed',
    );
    captureDeadLetterPersistFailureInSentry(queueName, job, persistError);
  }
}

/**
 * Mirrors a terminal failure to the `<source>-dlq` Redis queue for replay convenience.
 * Best-effort: any error is logged (`queue.dead_letter.enqueue_failed`) and swallowed —
 * the durable record already lives in Postgres via {@link persistDeadLetterFailureToPostgres}.
 */
async function mirrorDeadLetterToRedis(queueName: string, job: Job, error: unknown): Promise<void> {
  try {
    await enqueueDeadLetter(queueName, job, error);
  } catch (deadLetterError) {
    logger.error(
      {
        deadLetterError:
          deadLetterError instanceof Error ? deadLetterError.message : String(deadLetterError),
        queue: queueName,
        jobId: job.id,
      },
      'queue.dead_letter.enqueue_failed',
    );
  }
}

/**
 * Writes the durable Postgres record first, then the best-effort Redis mirror.
 *
 * @remarks
 * - **Algorithm:** awaits {@link persistDeadLetterFailureToPostgres} (the durable source of
 *   truth) then {@link mirrorDeadLetterToRedis} (replay convenience). Each branch swallows its
 *   own errors so this resolves without throwing.
 * - **Failure modes:** never rejects — both sub-writes log + capture on failure, so it is safe
 *   to `void` from the synchronous `failed` listener and safe to `await` from the poison-job
 *   guard (`parseJobDataOrDeadLetter`) without a surrounding try/catch.
 * - **Side effects:** one Postgres insert into `audit.dead_letter_jobs` plus one best-effort
 *   `<source>-dlq` Redis enqueue; structured logs on both paths.
 * - **Notes:** runs outside any request/worker DB context; identifiers are passed explicitly.
 */
export async function recordDeadLetterFailure(
  queueName: string,
  job: Job,
  error: unknown,
): Promise<void> {
  await persistDeadLetterFailureToPostgres(queueName, job, error);
  await mirrorDeadLetterToRedis(queueName, job, error);
}

function captureFinalFailureInSentry(queueName: string, job: Job, error: unknown): void {
  if (!isSentryInitialized()) return;

  const errorObject = error instanceof Error ? error : new Error(String(error));

  Sentry.withScope((scope) => {
    scope.setLevel('error');
    scope.setFingerprint(['worker_final_failure', queueName, job.name]);
    scope.setTag('queue', queueName);
    scope.setTag('job_id', String(job.id ?? 'unknown'));
    scope.setTag('job_name', job.name);
    scope.setTag('final_failure', 'true');
    Sentry.captureException(errorObject);
  });
}

function captureDeadLetterPersistFailureInSentry(
  queueName: string,
  job: Job,
  error: unknown,
): void {
  if (!isSentryInitialized()) return;

  const errorObject = error instanceof Error ? error : new Error(String(error));

  Sentry.withScope((scope) => {
    scope.setLevel('error');
    scope.setFingerprint(['dead_letter_persist_failure', queueName, job.name]);
    scope.setTag('queue', queueName);
    scope.setTag('job_id', String(job.id ?? 'unknown'));
    scope.setTag('job_name', job.name);
    scope.setTag('dead_letter_persist_failure', 'true');
    Sentry.captureException(errorObject);
  });
}

/**
 * Subscribes once to `failed`: warn on transient retries; on final failure, persist the
 * durable Postgres record + mirror to Redis + alert Sentry.
 *
 * @remarks
 * - **Notes:** `UnrecoverableError` is treated as already-handled — the poison-job guard
 *   (`parseJobDataOrDeadLetter`) records the dead-letter and skips BullMQ's retry path, so this
 *   listener logs `queue.job.unrecoverable` and returns without recording a second time.
 */
export function attachDeadLetterAndAlerting(worker: Worker, queueName: string): void {
  worker.on('failed', (job, error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (!job) {
      logger.error({ queue: queueName, error: errorMessage }, 'queue.job.failed_without_job');
      return;
    }

    if (error instanceof UnrecoverableError) {
      logger.error(
        { queue: queueName, jobId: job.id, jobName: job.name, error: errorMessage },
        'queue.job.unrecoverable',
      );
      return;
    }

    if (!isFinalJobFailure(job)) {
      logger.warn(
        {
          queue: queueName,
          jobId: job.id,
          jobName: job.name,
          attempt: job.attemptsMade,
          maxAttempts: resolveJobMaxAttempts(job),
          error: errorMessage,
        },
        'queue.job.retry',
      );
      return;
    }

    logger.error(
      {
        queue: queueName,
        jobId: job.id,
        jobName: job.name,
        attemptsMade: job.attemptsMade,
        maxAttempts: resolveJobMaxAttempts(job),
        error: errorMessage,
      },
      'queue.job.final_failure',
    );

    void recordDeadLetterFailure(queueName, job, error).catch((err) => {
      logger.error({ err, queue: queueName, jobId: job?.id }, 'queue.dead_letter.record_failed');
    });

    captureFinalFailureInSentry(queueName, job, error);
  });
}

/**
 * Closes every BullMQ DLQ producer this module has lazily created and clears the cache.
 * Called by the worker shutdown sequence so Redis connections drain cleanly. Failures are
 * swallowed via `Promise.allSettled` so one stuck queue cannot block the others.
 */
export async function closeDeadLetterQueues(): Promise<void> {
  const queues = [...deadLetterQueuesByName.values()];
  deadLetterQueuesByName.clear();
  await Promise.allSettled(queues.map((queue) => queue.close()));
}
