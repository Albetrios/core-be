import { describe, expect, it } from 'vitest';
import {
  buildReplayJobPayload,
  buildReplayJobPayloadFromLedger,
  resolveDeadLetterQueueNames,
} from '@/infrastructure/queue/dlq/dlq-replay.util.js';
import type { DeadLetterJobData } from '@/infrastructure/queue/dlq/dead-letter.js';
import { MAIL_QUEUE_NAME } from '@/infrastructure/mail/queues/mail.queue.js';
import { WEBHOOK_DELIVERY_QUEUE_NAME } from '@/domains/notify/sub-domains/webhook/webhook-delivery/queues/webhook-delivery.queue.js';
import { NOTIFICATION_QUEUE_NAME } from '@/domains/notify/sub-domains/notification/queues/notification.queue.js';
import { STRIPE_WEBHOOK_QUEUE_NAME } from '@/domains/billing/sub-domains/stripe-webhook/queues/stripe-webhook.queue.js';

describe('dlq-replay.util', () => {
  it('resolveDeadLetterQueueNames normalizes queue names', () => {
    expect(resolveDeadLetterQueueNames('mail')).toEqual(['mail-dlq']);
  });

  it('buildReplayJobPayload adds replayFromDlq and dlqReplayAttempt for mail', () => {
    const data: DeadLetterJobData = {
      original_queue: MAIL_QUEUE_NAME,
      original_job_id: 'job-1',
      original_job_name: 'send-mail',
      original_data_summary: { mail_outbox_id: 42 },
      failed_reason: 'error',
      attempts_made: 5,
      max_attempts: 5,
      failed_at: new Date().toISOString(),
      replay_attempt: 2,
    };

    expect(buildReplayJobPayload(data)).toEqual({
      mailOutboxId: 42,
      replayFromDlq: true,
      dlqReplayAttempt: 2,
    });
  });

  it('buildReplayJobPayload reconstructs webhook and stripe payloads', () => {
    const webhookData: DeadLetterJobData = {
      original_queue: WEBHOOK_DELIVERY_QUEUE_NAME,
      original_job_id: 'wh-1',
      original_job_name: 'deliver-webhook',
      original_data_summary: {
        delivery_attempt_id: 9,
        organization_public_id: 'org_public_abc',
      },
      failed_reason: 'error',
      attempts_made: 5,
      max_attempts: 5,
      failed_at: new Date().toISOString(),
    };

    const stripeData: DeadLetterJobData = {
      original_queue: STRIPE_WEBHOOK_QUEUE_NAME,
      original_job_id: 'stripe-1',
      original_job_name: 'process-stripe-webhook',
      original_data_summary: { stripe_event_id: 'evt_123' },
      failed_reason: 'error',
      attempts_made: 5,
      max_attempts: 5,
      failed_at: new Date().toISOString(),
    };

    expect(buildReplayJobPayload(webhookData)).toMatchObject({
      deliveryAttemptId: 9,
      organizationPublicId: 'org_public_abc',
      replayFromDlq: true,
      dlqReplayAttempt: 0,
    });
    expect(buildReplayJobPayload(stripeData)).toMatchObject({
      stripeEventId: 'evt_123',
      replayFromDlq: true,
    });
  });

  it('buildReplayJobPayload reconstructs a tenant-scoped notification payload', () => {
    const notificationData: DeadLetterJobData = {
      original_queue: NOTIFICATION_QUEUE_NAME,
      original_job_id: 'notif-1',
      original_job_name: 'dispatch-notification',
      original_data_summary: {
        notification_id: 77,
        organization_public_id: 'org_public_abc',
      },
      failed_reason: 'error',
      attempts_made: 3,
      max_attempts: 3,
      failed_at: new Date().toISOString(),
      replay_attempt: 1,
    };

    expect(buildReplayJobPayload(notificationData)).toEqual({
      notificationId: 77,
      organizationPublicId: 'org_public_abc',
      replayFromDlq: true,
      dlqReplayAttempt: 1,
    });
  });

  it('buildReplayJobPayload reconstructs a global notification with null organization scope', () => {
    const notificationData: DeadLetterJobData = {
      original_queue: NOTIFICATION_QUEUE_NAME,
      original_job_id: 'notif-2',
      original_job_name: 'dispatch-notification',
      original_data_summary: { notification_id: 88 },
      failed_reason: 'error',
      attempts_made: 3,
      max_attempts: 3,
      failed_at: new Date().toISOString(),
    };

    expect(buildReplayJobPayload(notificationData)).toEqual({
      notificationId: 88,
      organizationPublicId: null,
      replayFromDlq: true,
      dlqReplayAttempt: 0,
    });
  });

  it('buildReplayJobPayload returns null when required replay keys are missing', () => {
    const base = {
      original_job_id: 'job-x',
      original_job_name: 'name-x',
      failed_reason: 'error',
      attempts_made: 5,
      max_attempts: 5,
      failed_at: new Date().toISOString(),
    } as const;

    // Webhook missing organization_public_id → cannot scope replay.
    expect(
      buildReplayJobPayload({
        ...base,
        original_queue: WEBHOOK_DELIVERY_QUEUE_NAME,
        original_data_summary: { delivery_attempt_id: 9 },
      }),
    ).toBeNull();

    // Stripe missing stripe_event_id → cannot re-fetch the event.
    expect(
      buildReplayJobPayload({
        ...base,
        original_queue: STRIPE_WEBHOOK_QUEUE_NAME,
        original_data_summary: {},
      }),
    ).toBeNull();

    // Notification missing notification_id → nothing to load.
    expect(
      buildReplayJobPayload({
        ...base,
        original_queue: NOTIFICATION_QUEUE_NAME,
        original_data_summary: { organization_public_id: 'org_public_abc' },
      }),
    ).toBeNull();
  });

  it('buildReplayJobPayloadFromLedger maps ledger columns to replay payload', () => {
    expect(
      buildReplayJobPayloadFromLedger({
        source_queue: MAIL_QUEUE_NAME,
        job_id: 'job-ledger-1',
        job_name: 'send-mail',
        payload_summary: { mail_outbox_id: 99 },
        attempts_made: 5,
        auto_retry_count: 2,
      }),
    ).toEqual({
      mailOutboxId: 99,
      replayFromDlq: true,
      dlqReplayAttempt: 2,
    });
  });
});
