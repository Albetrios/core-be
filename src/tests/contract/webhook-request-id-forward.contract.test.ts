/**
 * Outbound webhook delivery must forward the API request id for log correlation.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { eventBus, runWithOnCommitScope } from '@/core/events/event-bus.js';
import { NOTIFY_EVENT } from '@/domains/notify/sub-domains/webhook/events/notify.events.js';
import { registerWebhookDeliveryEventHandlers } from '@/domains/notify/sub-domains/webhook/webhook-delivery/events/webhook-delivery.event-handlers.js';
import { processWebhookDeliveryAttempt } from '@/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-delivery.worker.js';

// The service paths under test run inside the real principal wrapper, which
// opens a `database.transaction()` — passthrough so no Postgres is needed
// (CI's unit/contract lanes run without a database service).
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
    withAppDatabaseContext: vi.fn(async (_scope: unknown, callback: () => Promise<unknown>) =>
      callback(),
    ),
  };
});

const enqueueWebhookDeliveryByAttemptIdMock = vi.fn();
const findOrganizationPublicIdByDeliveryAttemptIdMock = vi.fn();

vi.mock(
  '@/domains/notify/sub-domains/webhook/webhook-delivery/queues/webhook-delivery.queue.js',
  () => ({
    WEBHOOK_DELIVERY_JOB_ATTEMPTS: 5,
    enqueueWebhookDeliveryByAttemptId: (...arguments_: unknown[]) =>
      enqueueWebhookDeliveryByAttemptIdMock(...arguments_),
  }),
);

vi.mock(
  '@/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery.repository.js',
  () => ({
    // sec-N1: worker re-checks `webhookIsEnabled` / `webhookDeletedAt` at claim
    // time; the contract fixture must mark the webhook explicitly enabled so the
    // delivery proceeds through the claim → deliver → header-forward path.
    findWebhookDeliveryAttemptWithWebhook: vi.fn().mockResolvedValue({
      webhookId: 1,
      webhookUrl: 'https://example.com/hook',
      encryptedSecret: 'v1:secret',
      eventType: 'webhook.test',
      payload: { ok: true },
      webhookIsEnabled: true,
      webhookDeletedAt: null,
      encryptedSecretPrevious: null,
      secretRotatedAt: null,
    }),
    createWorkerWebhookDeliveryQueries: () => ({
      findWebhookDeliveryAttemptWithWebhook: vi.fn().mockResolvedValue({
        webhookId: 1,
        webhookUrl: 'https://example.com/hook',
        encryptedSecret: 'v1:secret',
        eventType: 'webhook.test',
        payload: { ok: true },
        webhookIsEnabled: true,
        webhookDeletedAt: null,
        encryptedSecretPrevious: null,
        secretRotatedAt: null,
      }),
    }),
    findOrganizationPublicIdByDeliveryAttemptId: (...arguments_: unknown[]) =>
      findOrganizationPublicIdByDeliveryAttemptIdMock(...arguments_),
  }),
);

vi.mock('@/shared/utils/security/field-secret-encryption.util.js', () => ({
  decryptFieldSecret: vi.fn(() => 'signing-secret'),
}));

vi.mock('@/shared/utils/security/webhook-url.util.js', () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue(undefined),
}));

const deliveryAttemptRepository = {
  tryMarkSending: vi.fn().mockResolvedValue('claimed'),
  recordOutcome: vi.fn().mockResolvedValue(undefined),
};

describe('Webhook request id forward contract', () => {
  const fetchMock = vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    text: vi.fn().mockResolvedValue('ok'),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    findOrganizationPublicIdByDeliveryAttemptIdMock.mockResolvedValue('org_public_contract');
    registerWebhookDeliveryEventHandlers();
  });

  it('propagates requestId from domain event through the queue into outbound X-Request-Id', async () => {
    const correlationRequestId = 'req-api-to-subscriber';

    await runWithOnCommitScope(async () => {
      await eventBus.emit({
        type: NOTIFY_EVENT.WEBHOOK_DELIVERY_REQUESTED,
        payload: { delivery_attempt_id: 7 },
        timestamp: new Date(),
        requestId: correlationRequestId,
      });
      await eventBus.flushOnCommit();
    });

    expect(enqueueWebhookDeliveryByAttemptIdMock).toHaveBeenCalledWith(
      7,
      'org_public_contract',
      correlationRequestId,
    );

    await processWebhookDeliveryAttempt(
      7,
      'org_public_contract',
      { id: 'job-contract', attemptsMade: 0, requestId: correlationRequestId },
      fetchMock,
      deliveryAttemptRepository as never,
    );

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestInit.headers).toMatchObject({
      'X-Request-Id': correlationRequestId,
    });
  });
});
