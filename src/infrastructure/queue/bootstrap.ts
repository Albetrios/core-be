/**
 * Queue bootstrap: registers BullMQ repeatable jobs, then starts domain workers.
 * Processor registration lives in domain worker files; queue families and pool demand
 * are centralized in worker-registration.registry.ts and worker-connection-budget.ts.
 */

import type { Worker } from 'bullmq';
import { isWorkerRuntime } from '@/infrastructure/database/contexts/worker-database.context.js';
import { STRIPE_WEBHOOK_QUEUE_NAME } from '@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js';
import { MAIL_QUEUE_NAME } from '@/infrastructure/mail/queues/mail.queue.js';
import { attachDeadLetterAndAlerting } from '@/infrastructure/queue/dlq/dead-letter.js';
import { registerScheduledJobs } from '@/infrastructure/queue/scheduler.js';
import { auditSchedulerRegistryConsistency } from '@/infrastructure/queue/worker-runtime/scheduler-registry-audit.js';
import {
  computeWorkerPostgresPoolDemand,
  resolveActiveWorkerQueueNames,
} from '@/infrastructure/queue/worker-runtime/worker-connection-budget.js';
import { getSelectedWorkerQueueFamilies } from '@/infrastructure/queue/worker-runtime/worker-queue-family.util.js';
import { getWorkerRegistrationsForFamilies } from '@/infrastructure/queue/worker-runtime/worker-registration.registry.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { env } from '@/shared/config/env.config.js';
import {
  startProcessMemoryMonitoring,
  stopProcessMemoryMonitoring,
} from '@/shared/utils/infrastructure/process-memory-monitor.util.js';
import type { DomainContainers } from '@/worker-containers.js';

export { closeDeadLetterQueues } from '@/infrastructure/queue/dlq/dead-letter.js';

/**
 * Lifecycle handle returned by every worker factory (and the scheduler) so the
 * shutdown sequence can drain them uniformly. `worker` and `queueName` are present
 * for BullMQ workers and consumed by {@link attachDeadLetterAndAlerting}; they are
 * absent for the scheduler-only handle which has no `failed` event source.
 */
export interface WorkerHandle {
  close: () => Promise<void>;
  /** Set for BullMQ worker processors; omitted for the scheduler-only handle. */
  worker?: Worker;
  queueName?: string;
}

/** Stops the worker RSS monitor on shutdown (delegates to the shared process memory monitor). */
export function stopRssMonitoring(): void {
  stopProcessMemoryMonitoring();
}

function pushWorkerWithDeadLetterHook(
  workers: WorkerHandle[],
  createWorker: () => WorkerHandle,
): void {
  const handle = createWorker();
  workers.push(handle);
  if (handle.worker !== undefined && handle.queueName !== undefined) {
    attachDeadLetterAndAlerting(handle.worker, handle.queueName);
  }
}

/**
 * Boots every BullMQ worker selected by `WORKER_QUEUE_FAMILIES` for the current
 * process: starts RSS monitoring, audits the registry against the scheduler cron
 * list, registers repeatable jobs for queues that have a worker locally, then
 * instantiates each worker (skipping `mail` / `stripe-webhook` when their secrets
 * are missing) and attaches the DLQ + Sentry `failed` listener via
 * {@link attachDeadLetterAndAlerting}. Returned handles are drained in reverse
 * order during shutdown.
 */
export async function registerDomainWorkers(
  workerContainers: DomainContainers,
): Promise<WorkerHandle[]> {
  // C1 (context-layer audit): every worker-runtime database guard —
  // assertWorkerDatabaseContext, the FORCE-RLS table asserts, the unpinned-pool
  // throw — is gated on isWorkerRuntime(). Starting BullMQ processors without the
  // flag would silently disable that entire guard net, so fail the boot instead.
  if (!isWorkerRuntime()) {
    throw new Error(
      'registerDomainWorkers requires CORE_BE_RUNTIME=worker — the worker-runtime RLS guard net is disabled without it. ' +
        'Start workers via src/worker.ts (which sets it) or set the variable explicitly.',
    );
  }
  const workers: WorkerHandle[] = [];
  const selectedFamilies = getSelectedWorkerQueueFamilies();
  const poolDemand = computeWorkerPostgresPoolDemand({
    families: selectedFamilies,
    workerContainers,
  });

  startProcessMemoryMonitoring({
    processLabel: 'worker',
    thresholdMegabytes: env.PROCESS_RSS_WARN_THRESHOLD_MB,
  });

  logger.info(
    {
      selectedFamilies,
      peakPostgresConcurrency: poolDemand.peakPostgresConcurrency,
      peakPostgresConcurrencyHoldingExternalIo: poolDemand.peakPostgresConcurrencyHoldingExternalIo,
      enabledPostgresQueues: poolDemand.queues
        .filter((entry) => entry.enabled && entry.postgresConcurrency > 0)
        .map((entry) => ({
          queueName: entry.queueName,
          postgresConcurrency: entry.postgresConcurrency,
          holdsConnectionDuringExternalIo: entry.holdsConnectionDuringExternalIo,
          criticality: entry.criticality,
        })),
    },
    'worker.queue_families.selected',
  );

  auditSchedulerRegistryConsistency();

  const activeQueueNames = resolveActiveWorkerQueueNames({
    families: selectedFamilies,
    workerContainers,
  });
  const schedulerHandle = await registerScheduledJobs({ activeQueueNames });
  workers.push(schedulerHandle);

  const registrations = getWorkerRegistrationsForFamilies(selectedFamilies);

  for (const registration of registrations) {
    if (registration.isEnabled !== undefined && !registration.isEnabled(workerContainers)) {
      if (registration.queueName === MAIL_QUEUE_NAME) {
        logger.warn('RESEND_API_KEY not configured — mail worker skipped');
      } else if (registration.queueName === STRIPE_WEBHOOK_QUEUE_NAME) {
        logger.warn(
          'STRIPE_WEBHOOK_SECRET not configured — stripe webhook ingress and worker skipped',
        );
      }
      continue;
    }

    pushWorkerWithDeadLetterHook(workers, () => registration.create(workerContainers));
    logger.info({ queueName: registration.queueName }, `Registered ${registration.logLabel}`);
  }

  return workers;
}
