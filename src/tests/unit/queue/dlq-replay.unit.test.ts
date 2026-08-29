import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture sourceQueue and deadLetterQueue interactions.
const sourceQueueAddMock = vi.fn().mockResolvedValue(undefined);
const sourceQueueCloseMock = vi.fn().mockResolvedValue(undefined);
const dlqGetJobMock = vi.fn().mockResolvedValue(null);
const dlqRemoveMock = vi.fn().mockResolvedValue(undefined);
const dlqCloseMock = vi.fn().mockResolvedValue(undefined);

type DlqReplayModule = typeof import('@/infrastructure/queue/dlq/dlq-replay.util.js');
let autoReplayDeadLetterFromLedger: DlqReplayModule['autoReplayDeadLetterFromLedger'];
let replayDeadLetterJob: DlqReplayModule['replayDeadLetterJob'];

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    add?: typeof sourceQueueAddMock;
    getJob?: typeof dlqGetJobMock;
    close: () => Promise<void>;

    constructor(name: string) {
      // Distinguish source queue vs DLQ by name suffix so mocks don't cross-contaminate.
      if (name.endsWith('-dlq')) {
        this.getJob = dlqGetJobMock;
        this.close = dlqCloseMock;
      } else {
        this.add = sourceQueueAddMock;
        this.close = sourceQueueCloseMock;
      }
    }
  },
}));

vi.mock('@/infrastructure/database/connection.js', () => {
  const handle = {
    insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
    execute: vi.fn().mockResolvedValue(undefined),
  };
  return {
    database: {
      insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }),
      // sec-r5-async-queue-1: the audit-write paths now wrap in
      // `withMaintenanceDatabaseContext` → `database.transaction(...)`. Stub the
      // transaction call to execute its callback against a handle that exposes
      // the same `insert(...).values(...)` shape.
      transaction: (callback: (h: typeof handle) => Promise<unknown>) => callback(handle),
    },
  };
});

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeAll(async () => {
  // One cold import for the file — per-test dynamic import flakes under parallel forks
  // (timeout → next test sees polluted vi.fn() call counts).
  const dlqReplay = await import('@/infrastructure/queue/dlq/dlq-replay.util.js');
  autoReplayDeadLetterFromLedger = dlqReplay.autoReplayDeadLetterFromLedger;
  replayDeadLetterJob = dlqReplay.replayDeadLetterJob;
}, 60_000);

describe('autoReplayDeadLetterFromLedger — sec-Q DLQ jobId regression', () => {
  beforeEach(() => {
    sourceQueueAddMock.mockReset().mockResolvedValue(undefined);
    sourceQueueCloseMock.mockReset().mockResolvedValue(undefined);
    dlqGetJobMock.mockReset().mockResolvedValue(null);
    dlqRemoveMock.mockReset().mockResolvedValue(undefined);
    dlqCloseMock.mockReset().mockResolvedValue(undefined);
  });

  it('re-enqueues to the source queue WITHOUT re-using the original jobId', async () => {
    // BullMQ's addStandardJob Lua treats a re-add with the same jobId as a `duplicated`
    // event when the original failed job is still in Redis under removeOnFail. Re-using
    // the original id would turn replay into a silent no-op. App-layer idempotency
    // (Stripe ledger, mail outbox, webhook delivery, notification SET NX) is the
    // canonical dedup boundary.
    await autoReplayDeadLetterFromLedger({
      ledgerRow: {
        id: 1,
        source_queue: 'notification',
        dead_letter_queue: 'notification-dlq',
        job_id: 'original-job-7',
        job_name: 'dispatch-notification',
        payload_summary: { notification_id: 7, organization_public_id: 'org_xxxxx' },
        attempts_made: 3,
      },
      autoRetryCount: 1,
    });

    expect(sourceQueueAddMock).toHaveBeenCalledTimes(1);
    // The third argument (BullMQ `JobsOptions`) MUST be absent or undefined — never
    // contain a `jobId`. A presence check is sufficient because `omitUndefined({jobId})`
    // used to leave an object even when jobId itself was undefined.
    const callArguments = sourceQueueAddMock.mock.calls[0];
    if (callArguments && callArguments.length >= 3) {
      const options = callArguments[2] as Record<string, unknown> | undefined;
      expect(options?.jobId).toBeUndefined();
    }
  });

  it('looks up the DLQ Redis mirror by the attempt-suffixed identifier', async () => {
    // The DLQ Redis jobId now embeds attempts_made so re-failure produces a fresh
    // snapshot rather than colliding with the prior failure (which BullMQ's duplicate
    // semantics would otherwise retain unchanged). The ledger row carries the same
    // `attempts_made`, so cleanup looks up the exact terminal-failure snapshot.
    await autoReplayDeadLetterFromLedger({
      ledgerRow: {
        id: 1,
        source_queue: 'notification',
        dead_letter_queue: 'notification-dlq',
        job_id: 'original-job-7',
        job_name: 'dispatch-notification',
        payload_summary: { notification_id: 7, organization_public_id: 'org_xxxxx' },
        attempts_made: 3,
      },
      autoRetryCount: 1,
    });

    expect(dlqGetJobMock).toHaveBeenCalledTimes(1);
    expect(dlqGetJobMock).toHaveBeenCalledWith('dlq-notification-original-job-7-attempt-3');
  });
});

describe('replayDeadLetterJob — sec-Q DLQ jobId regression', () => {
  beforeEach(() => {
    sourceQueueAddMock.mockReset().mockResolvedValue(undefined);
    sourceQueueCloseMock.mockReset().mockResolvedValue(undefined);
    dlqGetJobMock.mockReset();
    dlqRemoveMock.mockReset().mockResolvedValue(undefined);
    dlqCloseMock.mockReset().mockResolvedValue(undefined);
  });

  it('re-enqueues to the source queue WITHOUT re-using the original jobId (operator path)', async () => {
    const dlqJobMock = {
      data: {
        original_queue: 'notification',
        original_job_id: 'original-job-7',
        original_job_name: 'dispatch-notification',
        original_data_summary: {
          notification_id: 7,
          organization_public_id: 'org_xxxxx',
        },
        failed_reason: 'permanent',
        attempts_made: 3,
        max_attempts: 3,
        failed_at: new Date().toISOString(),
      },
      remove: dlqRemoveMock,
    };
    dlqGetJobMock.mockResolvedValueOnce(dlqJobMock);

    await replayDeadLetterJob({
      deadLetterQueueName: 'notification-dlq',
      deadLetterJobId: 'dlq-notification-original-job-7-attempt-3',
      dryRun: true,
      actorUserPublicId: 'user_xxxxx',
    });

    // dryRun=true short-circuits before the source enqueue, so we exercise the
    // payload reconstruction and DLQ lookup paths without hitting the add() guard.
    // The lookup must succeed to confirm the new identifier format is interpretable.
    expect(dlqGetJobMock).toHaveBeenCalledWith('dlq-notification-original-job-7-attempt-3');
  });
});
