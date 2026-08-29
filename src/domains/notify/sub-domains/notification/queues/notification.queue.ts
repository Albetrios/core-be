import { Queue } from 'bullmq';
import { getBullMQProducerConnectionOptions } from '@/infrastructure/queue/connection.js';
import { DEFAULT_JOB_RETENTION_COUNT } from '@/infrastructure/queue/queue.constants.js';
import { captureTraceContextForPropagation } from '@/infrastructure/observability/tracing/trace-context.util.js';
import { parseBullMQJobData } from '@/shared/utils/validation/bullmq-job-validation.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { FIVE_SECONDS_MS, SEVEN_DAYS_SECONDS } from '@/shared/constants/ttl.constants.js';
import {
  notificationJobDataSchema,
  type NotificationJobDataValidated,
} from './notification.job.schema.js';

/** BullMQ queue name for asynchronous notification dispatch (in-app + email fan-out). */
export const NOTIFICATION_QUEUE_NAME = 'notification';

/** Only ids are stored in Redis; content is loaded in the worker from Postgres with organization scoping. */
export type NotificationJobData = NotificationJobDataValidated;

let notificationQueue: Queue<NotificationJobData> | null = null;

function getNotificationQueue(): Queue<NotificationJobData> {
  if (notificationQueue) return notificationQueue;
  notificationQueue = new Queue<NotificationJobData>(NOTIFICATION_QUEUE_NAME, {
    connection: getBullMQProducerConnectionOptions(),
    defaultJobOptions: {
      removeOnComplete: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
      removeOnFail: { count: DEFAULT_JOB_RETENTION_COUNT, age: SEVEN_DAYS_SECONDS },
      attempts: 3,
      backoff: { type: 'exponential', delay: FIVE_SECONDS_MS },
    },
  });
  return notificationQueue;
}

/**
 * Enqueue a notification for async delivery across configured channels.
 */
export async function enqueueNotification(
  notificationId: number,
  organizationPublicId: string | null,
  requestId?: string,
): Promise<void> {
  const queue = getNotificationQueue();
  const jobData = parseBullMQJobData(
    notificationJobDataSchema,
    omitUndefined({
      notificationId,
      organizationPublicId,
      requestId,
      ...captureTraceContextForPropagation(),
    }),
    NOTIFICATION_QUEUE_NAME,
  );
  // audit #6: deduplicate on the notification id. A recovery/redelivery path
  // (post-commit dispatch recovery, an event handler firing twice, or a
  // producer-side retry) that re-enqueues the same persisted notification must
  // not produce a second dispatch — and therefore a second outbound email — for
  // one in-app notification row. BullMQ drops an add whose jobId still exists in
  // any bucket (retained for SEVEN_DAYS_SECONDS), so a re-enqueue inside that
  // window is a no-op. notification ids are unique bigserials, so the jobId is
  // globally unique per notification.
  await queue.add('dispatch-notification', jobData, {
    jobId: `notification-${String(notificationId)}`,
  });
}

/** Close the lazily-initialised notification queue (graceful-shutdown hook for tests/runtime). */
export async function closeNotificationQueue(): Promise<void> {
  if (notificationQueue) {
    await notificationQueue.close();
    notificationQueue = null;
  }
}

/**
 * Verifies BullMQ can reach Redis through the Queue API used by producers.
 */
export async function pingNotificationQueueConnection(): Promise<void> {
  const queue = getNotificationQueue();
  await queue.waitUntilReady();
  await queue.getJobCounts('waiting');
}
