import { Worker, type Job } from 'bullmq';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/maintenance-database.context.js';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import { getDefaultWorkerOptions } from '@/infrastructure/queue/worker-runtime/worker-options.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import { parseJobDataOrDeadLetter } from '@/infrastructure/queue/dlq/poison-job.util.js';
import { runWithPropagatedTraceContext } from '@/infrastructure/observability/tracing/trace-context.util.js';
import { notificationJobDataSchema } from '@/domains/notify/sub-domains/notification/queues/notification.job.schema.js';
import {
  NOTIFICATION_QUEUE_NAME,
  type NotificationJobData,
} from '@/domains/notify/sub-domains/notification/queues/notification.queue.js';
import { createWorkerNotificationRepository } from '@/domains/notify/sub-domains/notification/notification.repository.js';
import { dispatchOutboxEmail, recordOutboxEmail } from '@/infrastructure/mail/queues/mail.queue.js';
import { withSystemTableWorkerContext } from '@/infrastructure/database/contexts/worker-database.context.js';
import { isMailConfigured } from '@/infrastructure/mail/mail.service.js';
import { buildNotificationEmailHtml } from './notification-email-content.js';
import {
  isNotificationEmailDispatched,
  markNotificationEmailDispatched,
} from './notification-email-idempotency.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { getWorkerConcurrencyNotify } from '@/shared/config/worker-concurrency.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import {
  runTenantScopedWorkerJob,
  type WorkerDatabaseHandle,
} from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { withOrganizationContext } from '@/infrastructure/database/contexts/tenant-database.context.js';
import { withUserDatabaseContext } from '@/infrastructure/database/contexts/user-database.context.js';
import type { NotificationRepository } from '@/domains/notify/sub-domains/notification/notification.repository.js';

type NotificationDispatchData = {
  channels?: ('email' | 'in_app')[];
  email?: string;
};

/**
 * Dispatch the email channel for one notification. Handles the two-phase outbox (Postgres
 * INSERT then BullMQ enqueue) under a per-notification claim so retries collapse without
 * producing duplicate sends.
 *
 * @remarks
 * - **Algorithm:** claim → record outbox row → dispatch outbox enqueue. The claim is keyed by
 *   `(notificationId, recipient)` with a TTL. If the INSERT fails, the claim is released so
 *   a BullMQ retry can try again. If the INSERT succeeds but the BullMQ enqueue fails, the
 *   claim is KEPT and the failure is logged — the mail-outbox sweeper will re-enqueue the
 *   pending row, and any concurrent BullMQ retry of THIS job must hit `claimed = false` and
 *   skip, preventing a duplicate row + duplicate Resend send.
 * - **Failure modes:** propagates `recordOutboxEmail` errors so BullMQ retries; swallows
 *   `dispatchOutboxEmail` errors because the outbox row is the durability commit.
 * - **Side effects:** Redis claim write/release, Postgres outbox insert, BullMQ enqueue.
 */
async function dispatchNotificationEmail(options: {
  notificationId: number;
  type: string;
  email: string | undefined;
  title: string;
  message: string;
  actionUrl: string | null | undefined;
  requestId: string | undefined;
}): Promise<string | null> {
  const { notificationId, type, email, title, message, actionUrl, requestId } = options;
  if (!(isMailConfigured() && email)) {
    logger.warn({ channel: 'email', notificationId }, 'notification.worker.channel_skipped');
    return null;
  }

  // audit-#7: durability-first dedup. Skip only when a prior run already PERSISTED
  // the mail-outbox row (durable marker set AFTER the insert). The previous
  // claim-before-insert model lost the email if the worker was hard-killed between
  // the claim and the insert: the fast BullMQ retry saw the claim, returned
  // `email:deduplicated` as success, and nothing ever sent.
  if (await isNotificationEmailDispatched({ notificationId, recipient: email })) {
    logger.info({ notificationId, type }, 'notification.worker.email_already_dispatched');
    return 'email:deduplicated';
  }

  const { subject, html } = buildNotificationEmailHtml({
    title,
    message,
    actionUrl: actionUrl ?? null,
  });

  // Persist the durable outbox row FIRST. If this throws, no marker was written, so
  // a BullMQ retry simply re-inserts — the email is never lost. reaudit-#4: pass a
  // dedupeKey so the insert is idempotent at the DB layer — two concurrent runs of the
  // same notification (stall → redelivery) converge on ONE outbox row (the second gets
  // back the existing id), closing the duplicate-email window the Redis marker alone left
  // open. The Redis marker below is now just a fast-path to skip the DB insert on retry.
  let mailOutboxId: number | undefined;
  await withSystemTableWorkerContext(async () => {
    mailOutboxId = await recordOutboxEmail({
      to: email,
      subject,
      html,
      tags: [{ name: 'category', value: `notification-${type}` }],
      dedupeKey: `notification:${notificationId}:email:${email.toLowerCase()}`,
    });
  });

  // Fast-path marker so a plain BullMQ retry skips re-touching the row. Correctness no
  // longer depends on it (the DB dedupe_key is the authority); a crash before this mark
  // just means the retry re-runs the idempotent insert and resolves to the same id.
  await markNotificationEmailDispatched({ notificationId, recipient: email });

  // Do NOT throw on dispatch failure — the mail-outbox sweeper re-enqueues the row.
  let dispatchSucceeded = false;
  if (mailOutboxId !== undefined) {
    try {
      await dispatchOutboxEmail(mailOutboxId, requestId ? { requestId } : undefined);
      dispatchSucceeded = true;
    } catch (dispatchError) {
      logger.warn(
        { error: dispatchError, mailOutboxId, notificationId },
        'notification.worker.dispatch_failed_outbox_row_persisted',
      );
    }
  }

  // audit #45: distinguish a durably-persisted-but-not-yet-dispatched outbox row
  // (the BullMQ enqueue failed; the mail-outbox sweeper will re-enqueue it, and
  // its depth is tracked by the `mail_outbox_pending` gauge) from a send that was
  // actually handed to the queue. The prior unconditional `email:queued` masked
  // the pending state as success, so a persistent enqueue failure looked healthy
  // in the per-channel outcome.
  return dispatchSucceeded ? 'email:queued' : 'email:outbox_pending';
}

/**
 * Hydrate a persisted notification and fan it out across its configured delivery channels
 * (in-app, email). Exported as a pure function so unit tests can drive it with an injected
 * repository instead of spinning up Redis/Postgres.
 *
 * @remarks
 * - **Algorithm:** load the notification row under the correct database context (organization
 *   scope when `organizationPublicId` is set, global retention scope otherwise), then iterate
 *   `data.channels ?? ['in_app']`; for each channel, look up the recipient and send. The email
 *   channel renders the shared transactional template and persists/dispatches via the mail
 *   outbox under `withSystemTableWorkerContext`, guarded by a one-time Redis dispatch marker
 *   so retries of the same notification job never enqueue a duplicate email.
 * - **Failure modes:** missing notification row → throws `notification.not_found:<id>`; absent
 *   mail configuration or recipient logs `notification.worker.channel_skipped` and continues;
 *   outbox write/dispatch errors propagate so BullMQ can retry.
 * - **Side effects:** Postgres reads against `notify.notifications`; mail outbox insert and
 *   BullMQ enqueue on the email channel; structured logs throughout.
 * - **Notes:** when an explicit `notificationRepository` is supplied (tests / worker-scoped
 *   factories) this function skips the database-context wrapper because the caller already
 *   established RLS scope.
 */
export async function processNotificationDispatchJob(
  notificationId: number,
  organizationPublicId: string | null | undefined,
  jobContext: { id?: string; requestId?: string },
  notificationRepository?: NotificationRepository,
): Promise<{ channels: string[] }> {
  const loadNotification = async (databaseHandle: WorkerDatabaseHandle) => {
    const repository = notificationRepository ?? createWorkerNotificationRepository(databaseHandle);
    return repository.findByIdForDispatch(notificationId, organizationPublicId ?? null);
  };

  // sec-D #10: NULL-organization notifications are user-scoped, not retention work.
  // The prior code wrapped them in `runGlobalRetentionWorkerJob`, which pins
  // `app.global_retention_cleanup = 'true'` — a wide escape hatch that also unlocks
  // DELETE on audit.logs and cross-tenant reads on every RLS-scoped table that has
  // the retention branch. Even though today's dispatch only reads then exits, that
  // GUC's blast radius is a future-regression risk: any patch that adds a write
  // inside this scope (e.g. "stamp delivered_at") would silently inherit cross-tenant
  // write privileges. Resolve the recipient's public id via the narrow SECURITY
  // DEFINER function and pin `withUserDatabaseContext` so the
  // `notifications_owner_access` policy authorises the read on its intended branch.
  const loadNotificationForScope = async () => {
    if (organizationPublicId === null || organizationPublicId === undefined) {
      const userPublicId = await withMaintenanceDatabaseContext(
        MAINTENANCE_SCOPE.global_admin,
        async (databaseHandle) => {
          const repository =
            notificationRepository ?? createWorkerNotificationRepository(databaseHandle);
          return repository.findUserPublicIdForNotificationDispatch(notificationId);
        },
      );
      if (!userPublicId) {
        throw new Error(`notification.user_unknown:${String(notificationId)}`);
      }
      return withUserDatabaseContext(userPublicId, loadNotification);
    }
    return withOrganizationContext(organizationPublicId, loadNotification);
  };
  const notificationRow =
    notificationRepository !== undefined
      ? await notificationRepository.findByIdForDispatch(
          notificationId,
          organizationPublicId ?? null,
        )
      : await loadNotificationForScope();

  if (!notificationRow) {
    throw new Error(`notification.not_found:${String(notificationId)}`);
  }

  const dispatchData = (notificationRow.data ?? {}) as NotificationDispatchData;
  const channels = dispatchData.channels ?? ['in_app'];
  // sec-N7: never let a producer-supplied `data.email` override the
  // authoritative recipient. `data` is `Record<string, unknown>`; the
  // moment any domain handler reflects request input into it, an attacker
  // could redirect system emails to a controlled inbox. Always use the
  // notification row's joined `auth.users.email`.
  const email = notificationRow.userEmail;
  const { type, title, message, actionUrl } = notificationRow;

  logger.info(
    { jobId: jobContext.id, requestId: jobContext.requestId, notificationId, type, channels },
    'notification.worker.processing',
  );

  const results: string[] = [];

  for (const channel of channels) {
    switch (channel) {
      case 'email': {
        const emailResult = await dispatchNotificationEmail({
          notificationId,
          type,
          email,
          title,
          message,
          actionUrl,
          requestId: jobContext.requestId,
        });
        if (emailResult !== null) results.push(emailResult);
        break;
      }

      case 'in_app':
        results.push('in_app:persisted');
        break;
    }
  }

  return { channels: results };
}

async function processTenantScopedNotificationJob(
  databaseHandle: WorkerDatabaseHandle,
  job: Job<NotificationJobData>,
): Promise<{ channels: string[] }> {
  const { notificationId, organizationPublicId, requestId } = job.data;
  return processNotificationDispatchJob(
    notificationId,
    organizationPublicId,
    omitUndefined({ id: job.id, requestId }),
    createWorkerNotificationRepository(databaseHandle),
  );
}

/**
 * Creates a BullMQ worker that processes notification dispatch jobs.
 * Routes notifications to configured channels (email, in-app).
 *
 * @remarks
 * - **Algorithm:** for each job, branch on `organizationPublicId`: tenant-scoped jobs run inside
 *   `runTenantScopedWorkerJob` (`withOrganizationContext`) so RLS pins reads to the org;
 *   tenant-less notifications delegate directly to {@link processNotificationDispatchJob}
 *   which then enters its own `loadNotificationForScope` flow — resolving the recipient
 *   public id under `withMaintenanceDatabaseContext` and pinning `withUserDatabaseContext`
 *   for the load (sec-re-01: the prior wiring wrapped this branch in
 *   `runGlobalRetentionWorkerJob` and injected a repository, which short-circuited the new
 *   `loadNotificationForScope` flow — making the sec-D #10 user-context fix dead code).
 *   Both paths produce a worker-scoped {@link NotificationRepository} (via injection on the
 *   tenant-scoped path, via the loadNotificationForScope helper on the tenant-less path)
 *   and delegate to {@link processNotificationDispatchJob} for per-channel fan-out.
 * - **Failure modes:** BullMQ retries on thrown errors using the queue's exponential backoff
 *   (3 attempts); stalls and completions are logged via the worker listeners.
 * - **Side effects:** subscribes a `Worker` to {@link NOTIFICATION_QUEUE_NAME}; reads notification
 *   rows; writes to the mail outbox and enqueues mail jobs for the email channel.
 * - **Notes:** concurrency comes from `getWorkerConcurrencyNotify()`; default worker options
 *   provide stall + lock tuning. The returned handle wires graceful shutdown into bootstrap.
 */
export function createNotificationWorker(): WorkerHandle {
  const worker = new Worker<NotificationJobData>(
    NOTIFICATION_QUEUE_NAME,
    async (job) => {
      const { notificationId, organizationPublicId, requestId, traceparent, tracestate } =
        await parseJobDataOrDeadLetter({
          schema: notificationJobDataSchema,
          job,
          queueName: NOTIFICATION_QUEUE_NAME,
        });

      return runWithPropagatedTraceContext({ traceparent, tracestate }, job.name, () => {
        // sec-re-01: tenant-less notifications delegate directly to
        // processNotificationDispatchJob so it can enter its own loadNotificationForScope
        // flow (withMaintenanceDatabaseContext → withUserDatabaseContext). The prior
        // wiring wrapped this branch in runGlobalRetentionWorkerJob AND injected a
        // repository, which short-circuited the new flow and left the sec-D #10 fix
        // dead code.
        if (organizationPublicId === null || organizationPublicId === undefined) {
          return processNotificationDispatchJob(
            notificationId,
            organizationPublicId,
            omitUndefined({ id: job.id, requestId }),
          );
        }

        return runTenantScopedWorkerJob(
          { organizationPublicId, notificationId, requestId },
          (databaseHandle) => processTenantScopedNotificationJob(databaseHandle, job),
        );
      });
    },
    {
      connection: getBullMQConnectionOptions(),
      concurrency: getWorkerConcurrencyNotify(),
      ...getDefaultWorkerOptions(),
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn({ jobId, queue: NOTIFICATION_QUEUE_NAME }, 'notification.worker.stalled');
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job?.id }, 'notification.worker.completed');
  });

  return buildWorkerHandle(worker, NOTIFICATION_QUEUE_NAME);
}
