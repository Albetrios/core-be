import { beforeEach, describe, expect, it, vi } from 'vitest';

const addMock = vi.fn().mockResolvedValue(undefined);

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
    close = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('@/infrastructure/queue/connection.js', () => ({
  getBullMQProducerConnectionOptions: () => ({}),
}));

vi.mock('@/infrastructure/observability/tracing/trace-context.util.js', () => ({
  captureTraceContextForPropagation: () => ({}),
}));

import { enqueueSubscriptionSeatSync } from '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.queue.js';

describe('enqueueSubscriptionSeatSync', () => {
  beforeEach(() => {
    addMock.mockClear();
  });

  // sec-review: a STABLE per-organization jobId (`seat-sync-${organization}`) is silently no-op'd by BullMQ while a
  // prior job with that id is still RETAINED (completed OR failed) — the exact duplicate-jobId trap
  // the Stripe webhook reclaim path documents as sec-re-02. That would leave Stripe billing a stale
  // seat count until the retained job aged out (up to 7 days). Each enqueue must get a UNIQUE jobId so
  // a later member change always schedules a fresh sync (the worker re-reads the live member count).
  it('gives every enqueue a unique jobId so a retained completed/failed job never blocks a re-enqueue', async () => {
    await enqueueSubscriptionSeatSync({ organizationPublicId: 'org_abc' });
    await enqueueSubscriptionSeatSync({ organizationPublicId: 'org_abc' });

    expect(addMock).toHaveBeenCalledTimes(2);
    const firstJobId = (addMock.mock.calls[0]![2] as { jobId: string }).jobId;
    const secondJobId = (addMock.mock.calls[1]![2] as { jobId: string }).jobId;
    expect(firstJobId).toMatch(/^seat-sync-org_abc-/);
    expect(secondJobId).toMatch(/^seat-sync-org_abc-/);
    expect(firstJobId).not.toBe(secondJobId);
  });

  it('carries the organization id and idempotency token in the job data', async () => {
    await enqueueSubscriptionSeatSync({
      organizationPublicId: 'org_xyz',
      idempotencyKey: 'sub-seat-sync:org_xyz:client-1',
    });

    const [jobName, jobData] = addMock.mock.calls[0]!;
    expect(jobName).toBe('sync-subscription-seats');
    expect(jobData).toMatchObject({
      organizationPublicId: 'org_xyz',
      idempotencyKey: 'sub-seat-sync:org_xyz:client-1',
    });
  });
});
