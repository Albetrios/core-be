import { describe, expect, it } from 'vitest';
import { webhookDeliveryJobDataSchema } from '@/domains/notify/sub-domains/webhook/webhook-delivery/queues/webhook-delivery.job.schema.js';

/**
 * The `webhook-delivery` queue's payload gate.
 *
 * This is the schema that stands between an untrusted Redis payload and the worker that makes
 * outbound HTTP to a customer-controlled URL, so it is the higher-consequence of notify's two
 * job schemas and had no test at all.
 *
 * Unlike the notification schema, `organizationPublicId` is **non-nullable**: every delivery
 * attempt belongs to a tenant, and the worker uses this value to open the organization database context
 * that RLS keys on. A null slipping through would mean an unscoped read.
 */
describe('webhookDeliveryJobDataSchema', () => {
  const validPayload = {
    deliveryAttemptId: 7,
    organizationPublicId: 'org_abcdefghijklmnopqrstu',
    requestId: 'request-1',
  };

  it('accepts a well-formed payload', () => {
    const parsed = webhookDeliveryJobDataSchema.safeParse(validPayload);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({
      deliveryAttemptId: 7,
      organizationPublicId: 'org_abcdefghijklmnopqrstu',
      requestId: 'request-1',
    });
  });

  it('accepts a payload without the optional requestId', () => {
    const parsed = webhookDeliveryJobDataSchema.safeParse({
      deliveryAttemptId: 7,
      organizationPublicId: 'org_abcdefghijklmnopqrstu',
    });

    expect(parsed.success).toBe(true);
  });

  it('carries the merged trace-context and DLQ-replay fields through', () => {
    const parsed = webhookDeliveryJobDataSchema.safeParse({
      ...validPayload,
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      tracestate: 'vendor=value',
      replayFromDlq: true,
      dlqReplayAttempt: 1,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      replayFromDlq: true,
      dlqReplayAttempt: 1,
    });
  });

  it('rejects a payload with no deliveryAttemptId', () => {
    const parsed = webhookDeliveryJobDataSchema.safeParse({
      organizationPublicId: 'org_abcdefghijklmnopqrstu',
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects a null organizationPublicId — every delivery is tenant-scoped', () => {
    // The worker opens withAppDatabaseContext from this value. A null here would mean the
    // attempt row is read outside the RLS scope it belongs to.
    const parsed = webhookDeliveryJobDataSchema.safeParse({
      deliveryAttemptId: 7,
      organizationPublicId: null,
    });

    expect(parsed.success).toBe(false);
  });

  it.each([
    [
      'a string deliveryAttemptId',
      { deliveryAttemptId: '7', organizationPublicId: 'org_abcdefghijklmnopqrstu' },
    ],
    [
      'a fractional deliveryAttemptId',
      { deliveryAttemptId: 2.5, organizationPublicId: 'org_abcdefghijklmnopqrstu' },
    ],
    [
      'a zero deliveryAttemptId',
      { deliveryAttemptId: 0, organizationPublicId: 'org_abcdefghijklmnopqrstu' },
    ],
    ['an empty organizationPublicId', { deliveryAttemptId: 7, organizationPublicId: '' }],
    [
      'an over-long organizationPublicId',
      { deliveryAttemptId: 7, organizationPublicId: 'o'.repeat(29) },
    ],
    [
      'an over-long requestId',
      {
        deliveryAttemptId: 7,
        organizationPublicId: 'org_abcdefghijklmnopqrstu',
        requestId: 'r'.repeat(129),
      },
    ],
  ])('rejects %s', (_label, payload) => {
    expect(webhookDeliveryJobDataSchema.safeParse(payload).success).toBe(false);
  });

  it('strips unknown keys rather than rejecting them', () => {
    // Same deliberate non-strict contract as the notification schema — pinned so a switch to
    // .strict() is a conscious decision about DLQ replay compatibility.
    const parsed = webhookDeliveryJobDataSchema.safeParse({
      ...validPayload,
      targetUrl: 'https://attacker.example.com',
    });

    expect(parsed.success).toBe(true);
    // Especially important here: the destination URL is loaded from Postgres in the worker and
    // must never be takeable from the job payload.
    expect(parsed.success && parsed.data).not.toHaveProperty('targetUrl');
  });
});
