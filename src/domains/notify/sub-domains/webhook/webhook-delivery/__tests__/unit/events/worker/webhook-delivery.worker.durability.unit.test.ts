import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest';
import {
  processWebhookDeliveryAttempt,
  type WebhookDeliveryFetch,
} from '@/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-delivery.worker.js';
import { resetWebhookOutboundCircuitsForTesting } from '@/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-outbound-circuit.js';

// The service paths under test run inside the real principal wrapper, which
// opens a `database.transaction()` — passthrough so no Postgres is needed
// (CI's unit/contract lanes run without a database service).
vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withPrincipalDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

const { activeContextFixture, disabledContextFixture, deletedContextFixture, findWebhook } =
  vi.hoisted(() => {
    const activeContextFixture = {
      deliveryAttemptId: 42,
      // sec-new-B2: opaque public id used as the X-Webhook-Delivery-Id header value.
      deliveryAttemptPublicId: 'wa0y8vf3ktxqnhcm1ze21',
      webhookId: 1,
      webhookUrl: 'https://example.com/hook',
      encryptedSecret: 'v1:secret',
      eventType: 'webhook.test',
      payload: { ok: true },
      attemptCount: 0,
      webhookIsEnabled: true,
      webhookDeletedAt: null as Date | null,
      encryptedSecretPrevious: null as string | null,
      secretRotatedAt: null as Date | null,
    };
    const disabledContextFixture = {
      ...activeContextFixture,
      deliveryAttemptId: 43,
      webhookIsEnabled: false,
    };
    const deletedContextFixture = {
      ...activeContextFixture,
      deliveryAttemptId: 44,
      webhookDeletedAt: new Date('2026-06-01T00:00:00Z'),
    };
    const findWebhook = vi.fn();
    return { activeContextFixture, disabledContextFixture, deletedContextFixture, findWebhook };
  });

vi.mock(
  '@/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery.repository.js',
  () => ({
    createWorkerWebhookDeliveryQueries: vi.fn(() => ({
      findWebhookDeliveryAttemptWithWebhook: findWebhook,
    })),
    findWebhookDeliveryAttemptWithWebhook: findWebhook,
  }),
);

vi.mock('@/shared/utils/security/field-secret-encryption.util.js', () => ({
  decryptFieldSecret: vi.fn(() => 'signing-secret'),
}));

vi.mock('@/shared/utils/security/webhook-url.util.js', () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue(undefined),
}));

function createDeliveryAttemptRepositoryMock() {
  return {
    tryMarkSending: vi.fn().mockResolvedValue('claimed'),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Regressions for sec-N1 + sec-N3 (notify durability).
 *
 * sec-N1 (Medium): the worker join did not filter on `webhooks.is_enabled` or
 * `webhooks.deleted_at`, so BullMQ retries continued firing signed POSTs to a
 * URL operators had just disabled or soft-deleted. The worker now treats the
 * disabled state as a terminal outcome: record FAILED with `webhook_disabled`
 * + `next_retry_at: null` AND return normally (no throw) so BullMQ does not
 * re-attempt. The test asserts both: outcome recorded AND no outbound POST.
 *
 * sec-N3 (Medium): outbound headers carried `X-Webhook-Signature`,
 * `X-Webhook-Event`, `X-Webhook-Timestamp` but no stable per-delivery id —
 * `timestamp` regenerates per attempt so the signature also changes, and
 * receivers cannot dedupe an at-least-once redelivery. The worker now sends
 * `X-Webhook-Delivery-Id: <deliveryAttemptPublicId>` (stable across BullMQ retries
 * because the same DB row carries the same `public_id`) so receivers have a
 * deterministic dedupe key without the bigserial leaking cardinality.
 *
 * sec-new-B2 (Low): the original implementation used `String(deliveryAttemptId)` —
 * the bigserial PK — which lets a receiver infer table size or enumerate attempts.
 * Replaced with the row's `public_id` (opaque, crypto-random 21-char string).
 */
describe('processWebhookDeliveryAttempt — notify durability (sec-N1 + sec-N3)', () => {
  let fetchMock: Mock<WebhookDeliveryFetch>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('ok'),
    }) as Mock<WebhookDeliveryFetch>;
    findWebhook.mockReset();
  });

  afterEach(() => {
    resetWebhookOutboundCircuitsForTesting();
  });

  it('sec-N3 + sec-new-B2: outbound headers include X-Webhook-Delivery-Id matching the public_id (not the numeric id)', async () => {
    findWebhook.mockResolvedValue(activeContextFixture);
    const repository = createDeliveryAttemptRepositoryMock();

    await processWebhookDeliveryAttempt(
      42,
      'org_public_1',
      { id: 'job-1', attemptsMade: 0 },
      fetchMock,
      repository as never,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    // sec-new-B2: must be the opaque public_id — not the numeric bigserial.
    expect(requestInit.headers).toMatchObject({
      'X-Webhook-Delivery-Id': 'wa0y8vf3ktxqnhcm1ze21',
    });
    const headers = requestInit.headers as Record<string, string>;
    expect(headers['X-Webhook-Delivery-Id']).not.toBe('42');
  });

  it('sec-N1: marks FAILED with webhook_disabled + null retry when webhook.is_enabled is false', async () => {
    findWebhook.mockResolvedValue(disabledContextFixture);
    const repository = createDeliveryAttemptRepositoryMock();

    const result = await processWebhookDeliveryAttempt(
      43,
      'org_public_1',
      { id: 'job-disabled', attemptsMade: 0 },
      fetchMock,
      repository as never,
    );

    // Returns normally (no throw) → BullMQ does NOT re-attempt the job.
    expect(result).toEqual({ httpStatus: 200, success: true });
    // No outbound POST — the attacker URL is not contacted again.
    expect(fetchMock).not.toHaveBeenCalled();
    // Outcome recorded as terminal FAILED (no further retry).
    expect(repository.recordOutcome).toHaveBeenCalledExactlyOnceWith(43, {
      status: 'FAILED',
      response_body: 'webhook_disabled',
      next_retry_at: null,
    });
    // We MUST NOT consume the claim if the webhook is disabled — leave the
    // PENDING row in whatever state the recordOutcome above sets it to.
    expect(repository.tryMarkSending).not.toHaveBeenCalled();
  });

  it('sec-N1: marks FAILED with webhook_disabled when webhook is soft-deleted', async () => {
    findWebhook.mockResolvedValue(deletedContextFixture);
    const repository = createDeliveryAttemptRepositoryMock();

    const result = await processWebhookDeliveryAttempt(
      44,
      'org_public_1',
      { id: 'job-deleted', attemptsMade: 0 },
      fetchMock,
      repository as never,
    );

    expect(result).toEqual({ httpStatus: 200, success: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repository.recordOutcome).toHaveBeenCalledExactlyOnceWith(44, {
      status: 'FAILED',
      response_body: 'webhook_disabled',
      next_retry_at: null,
    });
  });
});
