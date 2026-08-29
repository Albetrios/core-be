/**
 * Webhook delivery-attempt bulk seeder (nested under `webhook`) — for every bulk-seeded webhook,
 * fills `notify.webhook_delivery_attempts` with rows in a mix of delivery states so the outbound
 * audit trail looks realistic. The `webhook-event` nested sub-domain has no table of its own
 * (it is a static catalog), so the persisted "events in mixed delivery states" are these
 * delivery-attempt rows tied to the parent webhook.
 *
 * Idempotency: count-and-resume per webhook — counts existing attempts and inserts only the
 * missing remainder up to the per-webhook target, so a re-run with the same counts is a no-op.
 */
import { eq, like, sql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  webhook_delivery_attempts,
  webhooks,
} from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import { BULK_WEBHOOK_URL_PATTERN } from '@/domains/notify/sub-domains/webhook/seed/webhook.bulk.seed.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { generateBulkWebhookEvent } from './webhook-event.faker.js';

/** Delivery attempts seeded per webhook in the base profile (spread across SENT/FAILED/PENDING). */
const BASE_ATTEMPTS_PER_WEBHOOK = 6;
/** Extra attempts seeded per webhook when `counts.edgeCases` is on (adds an in-flight SENDING row). */
const EDGE_CASE_ATTEMPTS_PER_WEBHOOK = 1;
/** Max rows per multi-row insert to keep statements bounded. */
const INSERT_BATCH_SIZE = 500;

/** Delivery-attempt status values persisted by `webhook_delivery_attempts` (`SENT` = delivered). */
type DeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';

/** A fully-resolved delivery-attempt row ready for insertion. */
interface DeliveryAttemptInsert {
  public_id: string;
  webhook_id: number;
  event_type: string;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  http_status_code: number | null;
  response_body: string | null;
  sent_at: Date | null;
  attempt_count: number;
  next_retry_at: Date | null;
}

/** Rotates SENT → FAILED → PENDING by index so every webhook gets a deterministic state mix. */
function statusForIndex(index: number, edgeCases: boolean): DeliveryStatus {
  if (edgeCases && index >= BASE_ATTEMPTS_PER_WEBHOOK) return 'SENDING';
  const cycle = index % 3;
  if (cycle === 0) return 'SENT';
  if (cycle === 1) return 'FAILED';
  return 'PENDING';
}

/**
 * Builds one delivery-attempt row, stamping status-appropriate columns: `SENT` carries a 200 +
 * `sent_at`, `FAILED` a 5xx + retry timestamp + bumped attempt count, `SENDING`/`PENDING` stay
 * un-stamped. `event_key` is left null to avoid the partial unique `(webhook_id, event_key)`
 * pending-collision guard.
 */
function buildDeliveryAttempt(
  context: SeedContext,
  options: { webhookId: number; index: number },
): DeliveryAttemptInsert {
  const content = generateBulkWebhookEvent(context.faker);
  const status = statusForIndex(options.index, context.counts.edgeCases);
  const base: DeliveryAttemptInsert = {
    // sec-new-B2: generate a unique public_id for each seeded attempt row.
    public_id: generatePublicId('webhook'),
    webhook_id: options.webhookId,
    event_type: content.event_type,
    payload: content.payload,
    status,
    http_status_code: null,
    response_body: null,
    sent_at: null,
    attempt_count: 0,
    next_retry_at: null,
  };

  if (status === 'SENT') {
    return {
      ...base,
      http_status_code: 200,
      response_body: 'OK',
      sent_at: context.faker.date.recent({ days: 14 }),
      attempt_count: 1,
    };
  }
  if (status === 'FAILED') {
    return {
      ...base,
      http_status_code: context.faker.helpers.arrayElement([500, 502, 503]),
      response_body: 'Internal Server Error',
      attempt_count: context.faker.number.int({ min: 1, max: 5 }),
      next_retry_at: context.faker.date.soon({ days: 1 }),
    };
  }
  if (status === 'SENDING') {
    return { ...base, attempt_count: 1 };
  }
  return base;
}

/**
 * Seeds delivery attempts for every bulk-seeded webhook (matched by the shared
 * {@link BULK_WEBHOOK_URL_PATTERN}).
 *
 * @remarks
 * Parents read: the `notify.webhooks` rows created by the sibling webhook seeder (selected by the
 * shared URL pattern — this seeder runs after webhooks via `composeContributions`). Algorithm:
 * per webhook, count existing attempts and insert only the remaining target (base + edge-case)
 * in chunks of {@link INSERT_BATCH_SIZE}. Side effects: inserts into
 * `notify.webhook_delivery_attempts`. Failure modes: warns and returns early when no bulk
 * webhooks exist; otherwise propagates DB errors.
 */
export async function seedWebhookEventsBulk(context: SeedContext): Promise<void> {
  const database = getRequestDatabase();
  const target =
    BASE_ATTEMPTS_PER_WEBHOOK + (context.counts.edgeCases ? EDGE_CASE_ATTEMPTS_PER_WEBHOOK : 0);

  const bulkWebhooks = await database
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(like(webhooks.url, BULK_WEBHOOK_URL_PATTERN));
  if (bulkWebhooks.length === 0) {
    context.logger.warn('seed.bulk.webhook-event: no bulk webhooks; run the webhook seeder first');
    return;
  }

  let totalInserted = 0;
  for (const webhook of bulkWebhooks) {
    const [existing] = await database
      .select({ total: sql<number>`count(*)::int` })
      .from(webhook_delivery_attempts)
      .where(eq(webhook_delivery_attempts.webhook_id, webhook.id));
    const have = existing?.total ?? 0;

    const pending: DeliveryAttemptInsert[] = [];
    for (let index = have; index < target; index += 1) {
      pending.push(buildDeliveryAttempt(context, { webhookId: webhook.id, index }));
    }

    for (let offset = 0; offset < pending.length; offset += INSERT_BATCH_SIZE) {
      const chunk = pending.slice(offset, offset + INSERT_BATCH_SIZE);
      await database.insert(webhook_delivery_attempts).values(chunk);
      totalInserted += chunk.length;
    }
  }

  context.logger.info(
    { webhooks: bulkWebhooks.length, inserted: totalInserted },
    'seed.bulk.webhook-event: delivery attempts seeded',
  );
}
