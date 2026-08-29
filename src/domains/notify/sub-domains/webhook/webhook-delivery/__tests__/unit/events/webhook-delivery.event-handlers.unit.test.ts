import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
    findOrganizationPublicIdByDeliveryAttemptId: (...arguments_: unknown[]) =>
      findOrganizationPublicIdByDeliveryAttemptIdMock(...arguments_),
  }),
);

describe('webhook delivery event handlers', () => {
  let eventBus: typeof import('@/core/events/event-bus.js').eventBus;
  let runWithOnCommitScope: typeof import('@/core/events/event-bus.js').runWithOnCommitScope;
  let NOTIFY_EVENT: typeof import('@/domains/notify/sub-domains/webhook/events/notify.events.js').NOTIFY_EVENT;

  beforeAll(async () => {
    // One cold import + handler registration for the file — avoids per-test
    // `vi.resetModules()` + event-bus re-import that flakes under parallel fork load.
    const eventBusModule = await import('@/core/events/event-bus.js');
    const notifyEvents = await import(
      '@/domains/notify/sub-domains/webhook/events/notify.events.js'
    );
    const { registerWebhookDeliveryEventHandlers } = await import(
      '@/domains/notify/sub-domains/webhook/webhook-delivery/events/webhook-delivery.event-handlers.js'
    );
    eventBus = eventBusModule.eventBus;
    runWithOnCommitScope = eventBusModule.runWithOnCommitScope;
    NOTIFY_EVENT = notifyEvents.NOTIFY_EVENT;
    registerWebhookDeliveryEventHandlers();
  }, 60_000);

  beforeEach(() => {
    enqueueWebhookDeliveryByAttemptIdMock.mockReset();
    findOrganizationPublicIdByDeliveryAttemptIdMock.mockReset();
    findOrganizationPublicIdByDeliveryAttemptIdMock.mockResolvedValue('org_public_test_99');
  });

  it('enqueues webhook delivery on notify.webhook_delivery.requested', async () => {
    await runWithOnCommitScope(async () => {
      await eventBus.emit({
        type: NOTIFY_EVENT.WEBHOOK_DELIVERY_REQUESTED,
        payload: { delivery_attempt_id: 99 },
        timestamp: new Date(),
      });
      await eventBus.flushOnCommit();
    });

    expect(enqueueWebhookDeliveryByAttemptIdMock).toHaveBeenCalledOnce();
    expect(enqueueWebhookDeliveryByAttemptIdMock).toHaveBeenCalledWith(99, 'org_public_test_99');
  });

  it('enqueues webhook delivery immediately when no HTTP onCommit scope is active', async () => {
    await eventBus.emit({
      type: NOTIFY_EVENT.WEBHOOK_DELIVERY_REQUESTED,
      payload: { delivery_attempt_id: 42 },
      timestamp: new Date(),
    });

    expect(enqueueWebhookDeliveryByAttemptIdMock).toHaveBeenCalledOnce();
    expect(enqueueWebhookDeliveryByAttemptIdMock).toHaveBeenCalledWith(42, 'org_public_test_99');
  });

  it('does not enqueue an unscoped delivery when the attempt has no resolvable organization', async () => {
    // The handler resolves the organization so delivery is enqueued tenant-scoped. A null (attempt/organization gone)
    // makes it throw `organization_not_found`, which the handler CATCHES and logs — it must never
    // enqueue an organization-less delivery, and the throw must not escape the event bus (a failing
    // handler must not fail the originating request).
    findOrganizationPublicIdByDeliveryAttemptIdMock.mockResolvedValue(null);

    await eventBus.emit({
      type: NOTIFY_EVENT.WEBHOOK_DELIVERY_REQUESTED,
      payload: { delivery_attempt_id: 7 },
      timestamp: new Date(),
    });

    expect(enqueueWebhookDeliveryByAttemptIdMock).not.toHaveBeenCalled();
  });
});
