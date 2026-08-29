import { describe, it, expect, vi } from 'vitest';
import {
  processSubscriptionSeatSyncJob,
  type SubscriptionSeatSyncService,
} from '@/domains/billing/sub-domains/subscription/workers/subscription-seat-sync.processor.js';
import type { SubscriptionSeatSyncJobData } from '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.queue.js';

describe('processSubscriptionSeatSyncJob (REQ-4)', () => {
  it('delegates to syncSeatQuantityForOrganization with the organization public id and idempotency key', async () => {
    const service: SubscriptionSeatSyncService = {
      syncSeatQuantityForOrganization: vi.fn().mockResolvedValue(undefined),
    };
    const jobData = {
      organizationPublicId: 'org_public',
      idempotencyKey: 'idem-1',
      requestId: 'req-1',
    } as SubscriptionSeatSyncJobData;

    await processSubscriptionSeatSyncJob(jobData, service);

    expect(service.syncSeatQuantityForOrganization).toHaveBeenCalledWith('org_public', 'idem-1');
  });

  it('passes undefined idempotency key through when absent', async () => {
    const service: SubscriptionSeatSyncService = {
      syncSeatQuantityForOrganization: vi.fn().mockResolvedValue(undefined),
    };
    const jobData = { organizationPublicId: 'org_public' } as SubscriptionSeatSyncJobData;

    await processSubscriptionSeatSyncJob(jobData, service);

    expect(service.syncSeatQuantityForOrganization).toHaveBeenCalledWith('org_public', undefined);
  });
});
