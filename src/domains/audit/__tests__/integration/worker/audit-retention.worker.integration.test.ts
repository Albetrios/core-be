import { randomUUID } from 'node:crypto';
import {
  MAINTENANCE_SCOPE,
  withMaintenanceDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue, QueueEvents } from 'bullmq';

import { logs } from '@/domains/audit/audit.schema.js';
import { dead_letter_jobs } from '@/infrastructure/queue/dlq/dead-letter.schema.js';
import { createAuditRetentionWorker } from '@/domains/audit/workers/audit-retention.worker.js';
import { AUDIT_RETENTION_QUEUE_NAME } from '@/domains/audit/workers/audit-retention.constants.js';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { ensureAuditLogPartitionsForTimestamps } from '@/tests/helpers/audit-log-partition.helper.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { env } from '@/shared/config/env.config.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { database } from '@/infrastructure/database/connection.js';

/**
 * Verifies the audit retention worker purges rows older than AUDIT_RETENTION_DAYS.
 */
describe('audit-retention.worker — purge', () => {
  let workerHandle: WorkerHandle | null = null;
  let queue: Queue | null = null;
  let queueEvents: QueueEvents | null = null;

  beforeAll(async () => {
    workerHandle = createAuditRetentionWorker();
    queue = new Queue(AUDIT_RETENTION_QUEUE_NAME, {
      connection: getBullMQConnectionOptions(),
      defaultJobOptions: {
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 20 },
      },
    });
    queueEvents = new QueueEvents(AUDIT_RETENTION_QUEUE_NAME, {
      connection: getBullMQConnectionOptions(),
    });
    await queueEvents.waitUntilReady();
    await workerHandle.worker?.waitUntilReady();
  });

  afterAll(async () => {
    await workerHandle?.close();
    await queue?.close();
    await queueEvents?.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  it('deletes audit logs older than the retention cutoff', async () => {
    const user = await createTestUser();
    const retentionDays = env.AUDIT_RETENTION_DAYS;
    const staleCreatedAt = new Date();
    staleCreatedAt.setDate(staleCreatedAt.getDate() - retentionDays - 1);
    const recentCreatedAt = new Date();

    await ensureAuditLogPartitionsForTimestamps([staleCreatedAt, recentCreatedAt]);

    // Fixture seeding uses the raw superuser test pool: the retention context grants
    // read/delete only (no INSERT arm), and with DATABASE_MAINTENANCE_URL provisioned
    // locally the maintenance pool is RLS-subject core_be_maintenance — seeding through
    // it is (correctly) rejected by the audit.logs INSERT policy.
    await database.insert(logs).values([
      {
        actor_user_id: user.id,
        action: 'user.login.stale',
        resource_type: 'user',
        created_at: staleCreatedAt,
      },
      {
        actor_user_id: user.id,
        action: 'user.login.recent',
        resource_type: 'user',
        created_at: recentCreatedAt,
      },
    ]);

    const jobId = `audit-retention-${randomUUID()}`;
    const completion = waitForJobCompletion(queueEvents!, jobId);
    await queue!.add('cleanup-old-logs', {}, { jobId, attempts: 1 });
    await completion;

    const remaining = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.global_retention_cleanup,
      async (databaseHandle) => databaseHandle.select().from(logs),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.action).toBe('user.login.recent');
  });

  it('applies a strict cutoff at second resolution — keeps a boundary row, deletes one just past it', async () => {
    // Off-by-one guard: the comparator is `created_at < cutoff` (strict). A flip to `<=`,
    // a wrong unit, a sign error, or a timezone/day-arithmetic slip would silently destroy
    // or retain a full day of the compliance trail. The coarse `-1 day` case above cannot
    // see that; pin the boundary at second resolution. cutoff = now - AUDIT_RETENTION_DAYS,
    // computed exactly as the job does.
    const user = await createTestUser();
    const retentionDays = env.AUDIT_RETENTION_DAYS;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    // 1s older than the cutoff -> must be deleted. The job recomputes its cutoff a few ms
    // later, which only pushes this row further past the boundary (never the other way).
    const justPastCutoff = new Date(cutoff.getTime() - 1_000);
    // 30s newer than the cutoff -> must be kept. The 30s margin dwarfs the job's
    // compute/enqueue delay, so the keep assertion is not racy.
    const justInsideRetention = new Date(cutoff.getTime() + 30_000);

    await ensureAuditLogPartitionsForTimestamps([justPastCutoff, justInsideRetention]);

    await database.insert(logs).values([
      {
        actor_user_id: user.id,
        action: 'user.login.just_past_cutoff',
        resource_type: 'user',
        created_at: justPastCutoff,
      },
      {
        actor_user_id: user.id,
        action: 'user.login.just_inside_retention',
        resource_type: 'user',
        created_at: justInsideRetention,
      },
    ]);

    const jobId = `audit-retention-${randomUUID()}`;
    const completion = waitForJobCompletion(queueEvents!, jobId);
    await queue!.add('cleanup-old-logs', {}, { jobId, attempts: 1 });
    await completion;

    const remaining = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.global_retention_cleanup,
      async (databaseHandle) => databaseHandle.select().from(logs),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.action).toBe('user.login.just_inside_retention');
  });

  it('deletes dead-letter ledger rows older than the retention cutoff (bounds unbounded growth)', async () => {
    const retentionDays = env.AUDIT_RETENTION_DAYS;
    const staleFailedAt = new Date();
    staleFailedAt.setDate(staleFailedAt.getDate() - retentionDays - 1);
    const recentFailedAt = new Date();

    await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.global_retention_cleanup,
      async (databaseHandle) => {
        await databaseHandle.insert(dead_letter_jobs).values([
          {
            source_queue: 'mail',
            dead_letter_queue: 'mail-dlq',
            job_name: 'send-email',
            payload_summary: {},
            failed_reason: 'stale-failure',
            attempts_made: 3,
            max_attempts: 3,
            failed_at: staleFailedAt,
          },
          {
            source_queue: 'mail',
            dead_letter_queue: 'mail-dlq',
            job_name: 'send-email',
            payload_summary: {},
            failed_reason: 'recent-failure',
            attempts_made: 3,
            max_attempts: 3,
            failed_at: recentFailedAt,
          },
        ]);
      },
    );

    const jobId = `audit-retention-${randomUUID()}`;
    const completion = waitForJobCompletion(queueEvents!, jobId);
    await queue!.add('cleanup-old-logs', {}, { jobId, attempts: 1 });
    await completion;

    const remaining = await withMaintenanceDatabaseContext(
      MAINTENANCE_SCOPE.global_retention_cleanup,
      async (databaseHandle) => databaseHandle.select().from(dead_letter_jobs),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.failed_reason).toBe('recent-failure');
  });
});

function waitForJobCompletion(queueEvents: QueueEvents, expectedJobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onCompleted = (payload: { jobId: string }) => {
      if (payload.jobId !== expectedJobId) return;
      queueEvents.off('completed', onCompleted);
      resolve();
    };
    queueEvents.on('completed', onCompleted);
    setTimeout(() => reject(new Error(`timeout waiting for job ${expectedJobId}`)), 30_000);
  });
}
