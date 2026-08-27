import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as fieldSecretEncryption from '@/shared/utils/security/field-secret-encryption.util.js';
import {
  processWebhookDeliveryAttempt,
  type WebhookDeliveryFetch,
} from '@/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-delivery.worker.js';
import { resetWebhookOutboundCircuitsForTesting } from '@/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-outbound-circuit.js';

vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Blanket maintenance passthrough: services this suite touches (directly or via
    // cross-domain imports) may enter maintenance contexts (tombstoning, admin reads) —
    // the real wrapper opens a database.transaction() and CI's unit lane has no Postgres.
    withMaintenanceDatabaseContext: vi.fn(
      async (_scope: unknown, callback: () => Promise<unknown>) => callback(),
    ),
    withPrincipalDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

const { deliveryContextFixture } = vi.hoisted(() => ({
  deliveryContextFixture: {
    deliveryAttemptId: 42,
    // sec-new-B2: opaque public id used as the X-Webhook-Delivery-Id header value.
    deliveryAttemptPublicId: 'wa0y8vf3ktxqnhcm1ze21',
    webhookId: 1,
    webhookUrl: 'https://example.com/hook',
    encryptedSecret: 'v1:secret',
    eventType: 'webhook.test',
    payload: { ok: true },
    attemptCount: 0,
    // sec-N1: worker re-checks the parent webhook's live state at claim time.
    // Mark the fixture explicitly enabled / non-deleted so the happy-path
    // tests below proceed through the claim → deliver → record sequence.
    webhookIsEnabled: true,
    webhookDeletedAt: null as Date | null,
    // sec-N8: dual-sign fields; null means no rotation overlap → single signature only.
    encryptedSecretPrevious: null as string | null,
    secretRotatedAt: null as Date | null,
  },
}));

vi.mock(
  '@/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery.repository.js',
  () => ({
    createWorkerWebhookDeliveryQueries: vi.fn(() => ({
      findWebhookDeliveryAttemptWithWebhook: vi.fn().mockResolvedValue(deliveryContextFixture),
    })),
    findWebhookDeliveryAttemptWithWebhook: vi.fn().mockResolvedValue(deliveryContextFixture),
  }),
);

vi.mock('@/shared/utils/security/field-secret-encryption.util.js', () => ({
  decryptFieldSecret: vi.fn(() => 'signing-secret'),
}));

vi.mock('@/shared/utils/security/webhook-url.util.js', () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue(undefined),
}));

/**
 * processWebhookDeliveryAttempt() wraps its body in `withPrincipalDatabaseContext` (real
 * `database.transaction()` setting `app.current_organization_public_id`). Run the callback
 * directly so the test exercises worker logic without needing a Postgres connection.
 */

function createDeliveryAttemptRepositoryMock() {
  return {
    tryMarkSending: vi.fn().mockResolvedValue('claimed'),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
  };
}

describe('processWebhookDeliveryAttempt', () => {
  let fetchMock: Mock<WebhookDeliveryFetch>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('ok'),
    }) as Mock<WebhookDeliveryFetch>;
  });

  afterEach(() => {
    resetWebhookOutboundCircuitsForTesting();
  });

  it('forwards X-Request-Id on outbound webhook delivery', async () => {
    const repository = createDeliveryAttemptRepositoryMock();

    await processWebhookDeliveryAttempt(
      42,
      'org_public_1',
      { id: 'job-1', attemptsMade: 0, requestId: 'req-outbound-webhook' },
      fetchMock,
      repository as never,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestInit.headers).toMatchObject({ 'X-Request-Id': 'req-outbound-webhook' });
  });

  it('invokes repository.tryMarkSending then recordOutcome(SENT) on 2xx response', async () => {
    const repository = createDeliveryAttemptRepositoryMock();

    const result = await processWebhookDeliveryAttempt(
      42,
      'org_public_1',
      { id: 'job-success', attemptsMade: 0 },
      fetchMock,
      repository as never,
    );

    expect(result).toEqual({ httpStatus: 200, success: true });
    expect(repository.tryMarkSending).toHaveBeenCalledExactlyOnceWith(42, 1);
    expect(repository.recordOutcome).toHaveBeenCalledExactlyOnceWith(42, {
      status: 'SENT',
      http_status_code: 200,
      response_body: 'ok',
    });
    expect(repository.tryMarkSending.mock.invocationCallOrder[0]!).toBeLessThan(
      repository.recordOutcome.mock.invocationCallOrder[0]!,
    );
  });

  // audit-#6: a hostile/broken endpoint returning an unbounded (or gzip-expanded) body must not
  // be buffered in full. The worker streams at most the byte read-cap then cancels the reader, so
  // a single delivery can never exhaust worker heap and poison-loop across retries.
  it('caps an oversized response body and cancels the reader instead of buffering it all', async () => {
    const repository = createDeliveryAttemptRepositoryMock();

    let cancelled = false;
    let chunksPulled = 0;
    const oversizedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        // 8 KiB per chunk; the stream never closes, so without a cap the read would run forever.
        controller.enqueue(new TextEncoder().encode('A'.repeat(8_192)));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      body: oversizedStream,
    }) as unknown as Mock<WebhookDeliveryFetch>;

    const result = await processWebhookDeliveryAttempt(
      42,
      'org_public_1',
      { id: 'job-huge', attemptsMade: 0 },
      fetchMock,
      repository as never,
    );

    expect(result).toEqual({ httpStatus: 200, success: true });
    // The reader was cancelled after the cap was hit, so only a few chunks were ever pulled
    // (16 KiB cap ÷ 8 KiB chunk ≈ 2–3 reads) — never the unbounded stream.
    expect(cancelled).toBe(true);
    expect(chunksPulled).toBeLessThan(10);
    const [, outcome] = repository.recordOutcome.mock.calls[0] as [
      number,
      { response_body: string },
    ];
    expect(outcome.response_body.length).toBeLessThanOrEqual(2_000);
    expect(outcome.response_body.endsWith('…[truncated]')).toBe(true);
  });

  it('invokes repository.recordOutcome(FAILED) with HTTP error and rethrows on non-2xx', async () => {
    const repository = createDeliveryAttemptRepositoryMock();
    fetchMock = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      text: vi.fn().mockResolvedValue('server error'),
    }) as Mock<WebhookDeliveryFetch>;

    await expect(
      processWebhookDeliveryAttempt(
        77,
        'org_public_1',
        { id: 'job-fail', attemptsMade: 1 },
        fetchMock,
        repository as never,
      ),
    ).rejects.toThrow(/HTTP 500/);

    expect(repository.tryMarkSending).toHaveBeenCalledExactlyOnceWith(77, 2);
    expect(repository.recordOutcome).toHaveBeenCalledExactlyOnceWith(77, {
      status: 'FAILED',
      http_status_code: 500,
      response_body: 'server error',
      next_retry_at: expect.any(Date),
    });
  });

  it('schedules no retry on the final attempt (attemptsMade >= 4)', async () => {
    const repository = createDeliveryAttemptRepositoryMock();
    fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('network unavailable')) as Mock<WebhookDeliveryFetch>;

    await expect(
      processWebhookDeliveryAttempt(
        91,
        'org_public_1',
        { id: 'job-final', attemptsMade: 4 },
        fetchMock,
        repository as never,
      ),
    ).rejects.toThrow(/network unavailable/);

    expect(repository.tryMarkSending).toHaveBeenCalledExactlyOnceWith(91, 5);
    expect(repository.recordOutcome).toHaveBeenCalledExactlyOnceWith(91, {
      status: 'FAILED',
      response_body: 'network unavailable',
      next_retry_at: null,
    });
  });

  // P0-#1 regression: empty signing secret must NEVER produce an outbound delivery.
  // Previously the worker silently dropped the X-Webhook-Signature header and shipped
  // the payload, leaving the receiver unable to distinguish "secret rotated to empty"
  // from "attacker stripped the header" — a forgery primitive against any receiver
  // still trusting the request.
  describe('empty signing secret (P0-#1 fail-closed)', () => {
    beforeEach(() => {
      vi.mocked(fieldSecretEncryption.decryptFieldSecret).mockReturnValueOnce('');
    });

    it('records FAILED terminally (no next_retry) before any network call', async () => {
      const repository = createDeliveryAttemptRepositoryMock();

      await expect(
        processWebhookDeliveryAttempt(
          1234,
          'org_public_1',
          { id: 'job-empty-secret', attemptsMade: 0 },
          fetchMock,
          repository as never,
        ),
      ).rejects.toThrow(/empty_signing_secret/);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(repository.recordOutcome).toHaveBeenCalledExactlyOnceWith(1234, {
        status: 'FAILED',
        response_body: 'empty_signing_secret',
        next_retry_at: null,
      });
    });

    it('throws UnrecoverableError so BullMQ skips retries and lands in the DLQ', async () => {
      const repository = createDeliveryAttemptRepositoryMock();

      const error = await processWebhookDeliveryAttempt(
        1235,
        'org_public_1',
        { id: 'job-empty-secret-2', attemptsMade: 2 },
        fetchMock,
        repository as never,
      ).catch((rejection: unknown) => rejection);

      expect(error).toBeInstanceOf(UnrecoverableError);
    });
  });
});
