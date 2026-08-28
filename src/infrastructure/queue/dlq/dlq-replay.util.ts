import { Queue } from 'bullmq';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { eq } from 'drizzle-orm';
import { logs } from '@/domains/audit/audit.schema.js';
import { users } from '@/domains/user/user.schema.js';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import {
  DLQ_QUEUE_SUFFIX,
  type DeadLetterJobData,
  listDeadLetterQueueNames,
} from '@/infrastructure/queue/dlq/dead-letter.js';
import { MAIL_QUEUE_NAME } from '@/infrastructure/mail/queues/mail.queue.js';
import { WEBHOOK_DELIVERY_QUEUE_NAME } from '@/domains/notify/sub-domains/webhook/webhook-delivery/queues/webhook-delivery.queue.js';
import { NOTIFICATION_QUEUE_NAME } from '@/domains/notify/sub-domains/notification/queues/notification.queue.js';
import { STRIPE_WEBHOOK_QUEUE_NAME } from '@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * Source queues whose DLQ payloads {@link buildReplayJobPayload} knows how to reconstruct.
 * Retention/observability DLQs are intentionally excluded — their jobs carry no business
 * payload worth replaying, so operators must clear them manually.
 */
export const DLQ_REPLAY_SOURCE_QUEUE_NAMES = [
  MAIL_QUEUE_NAME,
  WEBHOOK_DELIVERY_QUEUE_NAME,
  NOTIFICATION_QUEUE_NAME,
  STRIPE_WEBHOOK_QUEUE_NAME,
] as const;

/** DLQ queue names accepted by the `tool:dlq-replay` CLI (derived from {@link DLQ_REPLAY_SOURCE_QUEUE_NAMES}). */
export const KNOWN_DEAD_LETTER_QUEUE_NAMES = listDeadLetterQueueNames(
  DLQ_REPLAY_SOURCE_QUEUE_NAMES,
);

/**
 * Normalises an operator-supplied queue filter (with or without the `-dlq` suffix) into a
 * concrete list of DLQ names to inspect. Throws when the filter does not match a known
 * replayable queue. With no filter, returns every replayable DLQ.
 */
export function resolveDeadLetterQueueNames(filter?: string): string[] {
  if (!filter) return [...KNOWN_DEAD_LETTER_QUEUE_NAMES];
  const normalized = filter.endsWith(DLQ_QUEUE_SUFFIX) ? filter : `${filter}${DLQ_QUEUE_SUFFIX}`;
  if (!KNOWN_DEAD_LETTER_QUEUE_NAMES.includes(normalized)) {
    throw new Error(
      `Unknown DLQ queue: ${filter}. Known: ${KNOWN_DEAD_LETTER_QUEUE_NAMES.join(', ')}`,
    );
  }
  return [normalized];
}

/** Minimal ledger fields needed to reconstruct a replay payload from Postgres. */
export type DeadLetterLedgerReplayInput = {
  source_queue: string;
  job_id: string | null;
  job_name: string;
  payload_summary: Record<string, unknown>;
  attempts_made: number;
  auto_retry_count?: number;
};

/**
 * Reconstructs a replay payload from an `audit.dead_letter_jobs` row (Postgres ledger).
 *
 * @remarks
 * - **Algorithm:** adapts ledger snake_case columns into {@link DeadLetterJobData} and
 *   delegates to {@link buildReplayJobPayload}.
 * - **Failure modes:** returns `null` when required summary keys are missing (same as manual replay).
 * - **Side effects:** none.
 * - **Notes:** `auto_retry_count` becomes `dlqReplayAttempt` on the re-enqueued job.
 */
export function buildReplayJobPayloadFromLedger(
  record: DeadLetterLedgerReplayInput,
): Record<string, unknown> | null {
  const data: DeadLetterJobData = omitUndefined({
    original_queue: record.source_queue,
    original_job_id: record.job_id ?? undefined,
    original_job_name: record.job_name,
    original_data_summary: record.payload_summary,
    failed_reason: 'auto-retry',
    attempts_made: 0,
    max_attempts: 0,
    failed_at: new Date().toISOString(),
    replay_attempt: record.auto_retry_count ?? 0,
  });
  return buildReplayJobPayload(data);
}

/**
 * Reconstructs the minimal job payload needed to re-enqueue a dead-lettered job onto its
 * original BullMQ queue. Mail, webhook delivery, notification, and Stripe webhook jobs each
 * pull their required identifiers out of {@link DeadLetterJobData.original_data_summary}:
 * mail (`mail_outbox_id`), webhook (`delivery_attempt_id` + `organization_public_id`),
 * notification (`notification_id` + nullable `organization_public_id`), Stripe
 * (`stripe_event_id`). Queues without a known shape (retention/observability DLQs), or whose
 * summary is missing a required key, return `null` so the caller skips the replay. The
 * resulting payload is tagged with {@link DlqReplayJobFields} markers so the receiving worker
 * can detect a replay.
 */
export function buildReplayJobPayload(data: DeadLetterJobData): Record<string, unknown> | null {
  const summary = data.original_data_summary;
  let basePayload: Record<string, unknown> | null = null;

  switch (data.original_queue) {
    case MAIL_QUEUE_NAME: {
      const mailOutboxId = summary.mail_outbox_id;
      if (typeof mailOutboxId !== 'number') return null;
      basePayload = { mailOutboxId };
      break;
    }
    case WEBHOOK_DELIVERY_QUEUE_NAME: {
      const deliveryAttemptId = summary.delivery_attempt_id;
      const organizationPublicId = summary.organization_public_id;
      if (typeof deliveryAttemptId !== 'number' || typeof organizationPublicId !== 'string') {
        return null;
      }
      basePayload = { deliveryAttemptId, organizationPublicId };
      break;
    }
    case NOTIFICATION_QUEUE_NAME: {
      const notificationId = summary.notification_id;
      if (typeof notificationId !== 'number') return null;
      // Notification jobs carry a nullable org scope; preserve null (global notifications)
      // and only forward a concrete public id when present.
      const organizationPublicId = summary.organization_public_id;
      basePayload = {
        notificationId,
        organizationPublicId:
          typeof organizationPublicId === 'string' ? organizationPublicId : null,
      };
      break;
    }
    case STRIPE_WEBHOOK_QUEUE_NAME: {
      const stripeEventId = summary.stripe_event_id;
      if (typeof stripeEventId !== 'string') return null;
      basePayload = { stripeEventId };
      break;
    }
    default:
      return null;
  }

  return {
    ...basePayload,
    replayFromDlq: true,
    dlqReplayAttempt: data.replay_attempt ?? 0,
  };
}

/**
 * Writes a `queue.dlq.replayed` row to `audit.logs` so every DLQ replay carries an actor
 * trail (resolves the supplied user public id to an internal numeric `actor_user_id`).
 * Throws when the actor is unknown — the caller in {@link replayDeadLetterJob} treats this
 * as a fatal pre-condition.
 */
export async function recordDlqReplayAuditEntry(input: {
  actorUserPublicId: string;
  deadLetterQueueName: string;
  deadLetterJobId: string;
  data: DeadLetterJobData;
}): Promise<void> {
  // The actor lookup needs an explicit RLS context: with no GUC set, both arms of
  // users_self_or_admin_access evaluate false under the RLS-subject application role
  // and the lookup returned zero rows — every manual DLQ replay failed at this
  // pre-condition. global_admin is the cross-user read arm the users policy grants.
  const [actorRow] = await withMaintenanceDatabaseContext(
    MAINTENANCE_SCOPE.GLOBAL_ADMIN,
    (databaseHandle) =>
      databaseHandle
        .select({ id: users.id })
        .from(users)
        .where(eq(users.public_id, input.actorUserPublicId))
        .limit(1),
  );

  if (!actorRow) {
    throw new Error(`Unknown actor user public id: ${input.actorUserPublicId}`);
  }

  // sec-r5-async-queue-1: DLQ replay rows are tenantless system events. After
  // sec-r4-D1 tightened the audit-INSERT policy to tenant-only, a bare INSERT
  // here is rejected by RLS. Use the system-audit-insert context (gated on
  // `organization_id IS NULL`, so it cannot impersonate a tenant) to write
  // the row.
  await withMaintenanceDatabaseContext(
    MAINTENANCE_SCOPE.SYSTEM_AUDIT_INSERT,
    async (databaseHandle) => {
      await databaseHandle.insert(logs).values({
        actor_user_id: actorRow.id,
        action: 'queue.dlq.replayed',
        resource_type: 'bullmq_dead_letter_job',
        severity: 'INFO',
        metadata: {
          dead_letter_queue: input.deadLetterQueueName,
          dead_letter_job_id: input.deadLetterJobId,
          original_queue: input.data.original_queue,
          original_job_id: input.data.original_job_id,
          replay_attempt: input.data.replay_attempt ?? 0,
        },
      });
    },
  );
}

/**
 * Outcome of {@link replayDeadLetterJob}: either the job was re-enqueued (or simulated in
 * dry-run mode), the DLQ entry vanished before we could read it, or the payload shape was
 * not in {@link DLQ_REPLAY_SOURCE_QUEUE_NAMES} and cannot be reconstructed.
 *
 * @remarks
 * A replay only re-enqueues the source job; whether it can actually re-deliver is decided by the
 * source processor. A terminally-`failed` mail row (body scrubbed) is re-enqueued here but the mail
 * processor immediately throws `UnrecoverableError` (audit-#W1), so the replayed job fails fast and
 * reappears in the DLQ with an explicit `mail.outbox.terminal_failed_not_replayable` reason rather
 * than silently no-opping as a success.
 */
export type ReplayDeadLetterJobResult =
  | { status: 'replayed'; originalQueue: string }
  | { status: 'not_found' }
  | { status: 'payload_not_reconstructable' };

/**
 * Outcome of {@link autoReplayDeadLetterFromLedger} — automated sweeper replay (no CLI actor).
 */
export type AutoReplayDeadLetterFromLedgerResult =
  | { status: 'replayed'; originalQueue: string }
  | { status: 'payload_not_reconstructable' };

/**
 * Writes a `queue.dlq.auto_retried` row to `audit.logs` for automated sweeper replays.
 *
 * @remarks
 * - **Algorithm:** system-initiated audit row with `actor_user_id` null.
 * - **Failure modes:** propagates Postgres errors to the caller.
 * - **Side effects:** one append to `audit.logs`.
 * - **Notes:** complements manual `queue.dlq.replayed` entries from the CLI.
 */
export async function recordDlqAutoRetryAuditEntry(input: {
  deadLetterJobId: number;
  sourceQueue: string;
  originalJobId: string | null;
  autoRetryCount: number;
}): Promise<void> {
  // sec-r5-async-queue-1: tenantless system event — see the matching comment
  // in `recordDlqReplayAuditEntry` above. Pre-fix, this INSERT was rejected
  // by RLS; the throw was swallowed by the auto-retry processor's outer
  // catch, the Redis counter never advanced, and the same 20 ledger rows
  // were re-selected at the head forever (head-of-line starvation for the
  // entire DLQ auto-retry subsystem). The system-audit-insert context fires
  // the new policy arm gated on `organization_id IS NULL`.
  await withMaintenanceDatabaseContext(
    MAINTENANCE_SCOPE.SYSTEM_AUDIT_INSERT,
    async (databaseHandle) => {
      await databaseHandle.insert(logs).values({
        actor_user_id: null,
        action: 'queue.dlq.auto_retried',
        resource_type: 'bullmq_dead_letter_job',
        severity: 'INFO',
        metadata: {
          dead_letter_job_id: input.deadLetterJobId,
          original_queue: input.sourceQueue,
          original_job_id: input.originalJobId,
          auto_retry_count: input.autoRetryCount,
        },
      });
    },
  );
}

/**
 * Re-enqueues one dead-letter ledger row onto its source queue and removes the Redis DLQ mirror.
 *
 * @remarks
 * - **Algorithm:** builds payload from Postgres summary, adds to source queue **without**
 *   re-using the original `jobId` (BullMQ treats a re-`add` with the same id as a `duplicated`
 *   event when the original failed job is still in Redis under `removeOnFail`, returning the
 *   existing id without enqueueing — silently turning replay into a no-op). The source-queue
 *   worker re-runs the job under app-layer idempotency (Stripe `tryClaimEvent` ledger,
 *   mail outbox `tryClaimPendingMailOutbox`, webhook delivery `tryMarkSending`, notification
 *   Redis `SET NX` dispatch marker), so a fresh BullMQ id cannot produce duplicate work.
 *   The Redis DLQ mirror is best-effort removed and an audit row is appended.
 * - **Failure modes:** `payload_not_reconstructable` when summary keys are missing; Redis/Postgres
 *   errors propagate after a successful source enqueue.
 * - **Side effects:** BullMQ add + optional DLQ remove + audit insert.
 * - **Notes:** does not mutate ledger rows. App-layer idempotency keys are the canonical
 *   dedup boundary — never the BullMQ `jobId`.
 */
export async function autoReplayDeadLetterFromLedger(input: {
  ledgerRow: DeadLetterLedgerReplayInput & { id: number; dead_letter_queue: string };
  autoRetryCount: number;
}): Promise<AutoReplayDeadLetterFromLedgerResult> {
  const payload = buildReplayJobPayloadFromLedger({
    ...input.ledgerRow,
    auto_retry_count: input.autoRetryCount,
  });
  if (!payload) {
    return { status: 'payload_not_reconstructable' };
  }

  const sourceQueue = new Queue(input.ledgerRow.source_queue, {
    connection: getBullMQConnectionOptions(),
  });
  try {
    // Intentionally omit `jobId` — see TSDoc. App-layer idempotency dedups execution.
    await sourceQueue.add(input.ledgerRow.job_name, payload);

    const deadLetterQueue = new Queue(input.ledgerRow.dead_letter_queue, {
      connection: getBullMQConnectionOptions(),
    });
    try {
      const safeOriginalJobIdentifier = input.ledgerRow.job_id ?? 'unknown';
      // Identifier format mirrors `enqueueDeadLetter` (`dlq-<source>-<originalId>-attempt-<n>`)
      // so we look up the snapshot for the specific terminal failure recorded in the ledger.
      const deadLetterJobIdentifier = `dlq-${input.ledgerRow.source_queue}-${String(safeOriginalJobIdentifier)}-attempt-${String(input.ledgerRow.attempts_made)}`;
      const deadLetterJob = await deadLetterQueue.getJob(deadLetterJobIdentifier);
      if (deadLetterJob) {
        await deadLetterJob.remove();
      }
    } finally {
      await deadLetterQueue.close();
    }

    await recordDlqAutoRetryAuditEntry({
      deadLetterJobId: input.ledgerRow.id,
      sourceQueue: input.ledgerRow.source_queue,
      originalJobId: input.ledgerRow.job_id,
      autoRetryCount: input.autoRetryCount,
    });

    return { status: 'replayed', originalQueue: input.ledgerRow.source_queue };
  } finally {
    await sourceQueue.close();
  }
}

/**
 * Replays a single dead-lettered job: looks it up, reconstructs its payload, adds it back
 * to the source queue with a fresh BullMQ id, removes the DLQ entry, and writes an audit row.
 * In `dryRun` mode no Redis or Postgres writes happen and `actorUserPublicId` is not required.
 *
 * @remarks
 * `jobId` is intentionally NOT re-used from `data.original_job_id`. BullMQ's `addStandardJob`
 * Lua treats a re-`add` against an existing `jobIdKey` as a `duplicated` event and returns the
 * existing id without enqueueing a new job; because source queues retain failed jobs for 7 days
 * under `removeOnFail`, the original key is essentially always present, so re-using it turns
 * replay into a silent no-op. App-layer idempotency (Stripe ledger, mail outbox, webhook
 * delivery attempts, notification dispatch markers) is the canonical dedup boundary and is
 * unaffected by a fresh BullMQ id.
 */
export async function replayDeadLetterJob(input: {
  deadLetterQueueName: string;
  deadLetterJobId: string;
  dryRun: boolean;
  actorUserPublicId?: string;
}): Promise<ReplayDeadLetterJobResult> {
  const queue = new Queue(input.deadLetterQueueName, { connection: getBullMQConnectionOptions() });
  try {
    const job = await queue.getJob(input.deadLetterJobId);
    if (!job) {
      return { status: 'not_found' };
    }

    const data = job.data as DeadLetterJobData;
    const payload = buildReplayJobPayload(data);
    if (!payload) {
      return { status: 'payload_not_reconstructable' };
    }

    if (input.dryRun) {
      logger.info({ originalQueue: data.original_queue, payload }, 'dlq.replay.dry_run');
      return { status: 'replayed', originalQueue: data.original_queue };
    }

    if (!input.actorUserPublicId) {
      throw new Error('--actor-user-public-id is required for DLQ replay (audit log)');
    }

    const sourceQueue = new Queue(data.original_queue, {
      connection: getBullMQConnectionOptions(),
    });
    try {
      // Intentionally omit `jobId` — see TSDoc. App-layer idempotency dedups execution.
      await sourceQueue.add(data.original_job_name, payload);
      await job.remove();
      await recordDlqReplayAuditEntry({
        actorUserPublicId: input.actorUserPublicId,
        deadLetterQueueName: input.deadLetterQueueName,
        deadLetterJobId: input.deadLetterJobId,
        data,
      });
      return { status: 'replayed', originalQueue: data.original_queue };
    } finally {
      await sourceQueue.close();
    }
  } finally {
    await queue.close();
  }
}

/**
 * Prints the first 100 waiting/failed jobs from a DLQ to stdout in a tab-separated layout
 * (`jobId\toriginal_queue\toriginal_job_name\treplay_attempt=N\tfailed_reason`). Used only
 * by the `tool:dlq-replay` CLI; never call from API or worker code.
 */
export async function listDeadLetterJobs(deadLetterQueueName: string): Promise<void> {
  const queue = new Queue(deadLetterQueueName, { connection: getBullMQConnectionOptions() });
  try {
    const jobs = await queue.getJobs(['waiting', 'failed'], 0, 99);
    if (jobs.length === 0) {
      // biome-ignore lint/suspicious/noConsole: tabular CLI output for tool:dlq-replay (terminal user, not log aggregator).
      console.log(`${deadLetterQueueName}: (empty)`);
      return;
    }
    for (const job of jobs) {
      const data = job.data as DeadLetterJobData;
      // biome-ignore lint/suspicious/noConsole: tabular CLI output for tool:dlq-replay (terminal user, not log aggregator).
      console.log(
        [
          job.id,
          data.original_queue,
          data.original_job_name,
          `replay_attempt=${String(data.replay_attempt ?? 0)}`,
          data.failed_reason?.slice(0, 60) ?? '',
        ].join('\t'),
      );
    }
    // biome-ignore lint/suspicious/noConsole: tabular CLI output for tool:dlq-replay (terminal user, not log aggregator).
    console.log(`${deadLetterQueueName}: ${jobs.length} job(s)`);
  } finally {
    await queue.close();
  }
}
