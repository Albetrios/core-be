import { describe, expect, it } from 'vitest';
import { subscriptionSeatSyncJobDataSchema } from '@/domains/billing/sub-domains/subscription/queues/subscription-seat-sync.job.schema.js';

/**
 * Asymmetry closed: `stripe-webhook.job.schema` had a unit test and this one did not, even
 * though both parse **untrusted payloads read back off Redis** at the worker boundary via
 * `parseJobDataOrDeadLetter`. A payload that fails here is dead-lettered; one that wrongly
 * passes reaches `processSubscriptionSeatSyncJob`, which uses `organizationPublicId` to
 * re-enter the organization RLS context — so this schema is the tenant boundary for the seat-sync worker.
 */
describe('subscription-seat-sync.job.schema', () => {
  it('accepts a minimal tenant-scoped payload', () => {
    const parsed = subscriptionSeatSyncJobDataSchema.safeParse({
      organizationPublicId: 'org_a1b2c3d4e5f6g7h8i9j0k',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.organizationPublicId).toBe('org_a1b2c3d4e5f6g7h8i9j0k');
    }
  });

  it('accepts the optional request-id, idempotency-key, trace, and DLQ-replay fields', () => {
    const parsed = subscriptionSeatSyncJobDataSchema.safeParse({
      organizationPublicId: 'org_a1b2c3d4e5f6g7h8i9j0k',
      requestId: 'req-abc',
      idempotencyKey: 'idem-abcdefghijklmnop',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      tracestate: 'vendor=value',
      replayFromDlq: true,
      dlqReplayAttempt: 2,
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects a payload with no organizationPublicId', () => {
    // Without the organization id the worker has no tenant to enter — the job MUST be dead-lettered
    // rather than run against whatever RLS context the connection happens to carry.
    expect(subscriptionSeatSyncJobDataSchema.safeParse({ requestId: 'req-abc' }).success).toBe(
      false,
    );
    expect(subscriptionSeatSyncJobDataSchema.safeParse({ organizationPublicId: '' }).success).toBe(
      false,
    );
  });

  it('rejects wrong-typed fields', () => {
    expect(
      subscriptionSeatSyncJobDataSchema.safeParse({ organizationPublicId: 12345 }).success,
    ).toBe(false);
    expect(
      subscriptionSeatSyncJobDataSchema.safeParse({
        organizationPublicId: 'org_a1b2c3d4e5f6g7h8i9j0k',
        dlqReplayAttempt: 'two',
      }).success,
    ).toBe(false);
  });

  it('rejects an over-long organizationPublicId (64-char bound)', () => {
    expect(
      subscriptionSeatSyncJobDataSchema.safeParse({ organizationPublicId: 'o'.repeat(65) }).success,
    ).toBe(false);
  });

  it('strips unknown keys rather than forwarding them to the processor', () => {
    // The schema is not `.strict()`, so an unknown key is dropped, not rejected. Pinning the
    // stripping behaviour matters: the processor receives the PARSED object, so a stale field
    // left on a Redis payload by an older producer can never influence the worker.
    const parsed = subscriptionSeatSyncJobDataSchema.safeParse({
      organizationPublicId: 'org_a1b2c3d4e5f6g7h8i9j0k',
      seatCount: 99,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('seatCount');
    }
  });
});
