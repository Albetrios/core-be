import { and, desc, eq, isNull, lt, ne, type SQL } from 'drizzle-orm';
import { countWithCap } from '@/infrastructure/database/utils/capped-count.util.js';
import type { WorkerDatabaseHandle } from '@/infrastructure/queue/worker-runtime/worker-processor.util.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { resolveRepositoryDatabaseHandle } from '@/infrastructure/database/contexts/database-context-runtime.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { assertWorkerDatabaseContext } from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  webhooks,
  webhook_delivery_attempts,
} from '@/domains/notify/sub-domains/webhook/webhook.schema.js';
import { WEBHOOK_DELIVERY_STUCK_SENDING_LEASE_MINUTES } from '@/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery.constants.js';
import { MILLISECONDS_PER_MINUTE } from '@/shared/constants/ttl.constants.js';
import {
  buildDescendingCreatedAtIdCursorCondition,
  createOpaqueCursorFromRow,
  parseListCursor,
} from '@/shared/utils/http/pagination.util.js';

/**
 * Outcome of {@link WebhookDeliveryAttemptRepository.tryMarkSending}. `claimed` means the
 * worker now owns the attempt; `in_flight` means another worker still holds a fresh lease;
 * `already_sent` means a previous attempt succeeded and the worker should no-op.
 */
export type WebhookDeliverySendingClaimResult = 'claimed' | 'in_flight' | 'already_sent';

/** Keyset pagination input for listing delivery attempts in the dashboard. */
export interface WebhookDeliveryAttemptListPagination {
  after?: string;
  limit: number;
  include_total?: boolean;
}

/**
 * Drizzle-backed access to `notify.webhook_delivery_attempts` — the immutable audit trail of
 * outbound webhook deliveries. Owns the SQL for the dashboard list, the at-most-one-in-flight
 * `PENDING → SENDING` transition with stale-lease reclaim, the terminal outcome write, and
 * inserts for both real and test deliveries. Resolves its database handle via the shared
 * request/worker context helper so it works under HTTP RLS and worker organization scopes.
 */
export class WebhookDeliveryAttemptRepository {
  constructor(private readonly databaseHandle?: RequestScopedPostgresDatabase) {}

  private db(): RequestScopedPostgresDatabase {
    return resolveRepositoryDatabaseHandle(this.databaseHandle);
  }

  /**
   * Lists delivery attempts for one webhook (dashboard history), keyset-paginated.
   *
   * @remarks
   * - **Tenant-isolation precondition (audit #42):** `webhook_id` MUST be an
   *   internal id the caller resolved for the active organization — the
   *   controller obtains it via {@link getWebhookId}`(public_id, organization_id)`,
   *   so a webhook from another org never reaches this query. It is also a pure
   *   defense-in-depth backstop: this runs on the request-scoped handle, and the
   *   `webhook_delivery_attempts_tenant_isolation` RLS policy scopes visibility to
   *   `webhook_id IN (SELECT id FROM notify.webhooks WHERE organization_id =
   *   current_org)`, so even a forged `webhook_id` from a foreign org returns zero
   *   rows. No explicit org predicate is added here to avoid duplicating the RLS
   *   join on every page read.
   * - **Algorithm:** descending `(created_at, id)` keyset page of `limit + 1`
   *   rows; an optional capped total when `include_total` is set.
   * - **Side effects:** none — read-only. `payload` and `response_body` are
   *   intentionally not projected (sec-r4-D6: they can carry PII).
   */
  async listByWebhook(webhook_id: number, pagination: WebhookDeliveryAttemptListPagination) {
    const { after, limit } = pagination;
    const includeTotal = pagination.include_total === true;
    const filterConditions: SQL[] = [eq(webhook_delivery_attempts.webhook_id, webhook_id)];
    const countWhere = and(...filterConditions);
    const cursorCondition = buildDescendingCreatedAtIdCursorCondition(
      webhook_delivery_attempts.created_at,
      webhook_delivery_attempts.id,
      parseListCursor(after),
    );
    const where =
      cursorCondition !== undefined ? and(...filterConditions, cursorCondition) : countWhere;

    // sec-r4-D6: project only the columns the delivery-history UI needs.
    // `payload` (jsonb full event body) and `response_body` (text response from
    // the customer's webhook endpoint) can carry PII or sensitive business data
    // and should not surface in every list-row response. A dedicated single-
    // attempt detail endpoint can expose them when actually requested.
    const rowsPromise = this.db()
      .select({
        public_id: webhook_delivery_attempts.public_id,
        event_type: webhook_delivery_attempts.event_type,
        event_key: webhook_delivery_attempts.event_key,
        status: webhook_delivery_attempts.status,
        http_status_code: webhook_delivery_attempts.http_status_code,
        sent_at: webhook_delivery_attempts.sent_at,
        attempt_count: webhook_delivery_attempts.attempt_count,
        next_retry_at: webhook_delivery_attempts.next_retry_at,
        created_at: webhook_delivery_attempts.created_at,
        // Keep the keyset cursor columns available to the serializer.
        id: webhook_delivery_attempts.id,
      })
      .from(webhook_delivery_attempts)
      .where(where)
      .orderBy(desc(webhook_delivery_attempts.created_at), desc(webhook_delivery_attempts.id))
      .limit(limit + 1);

    const countPromise = includeTotal
      ? countWithCap({
          database: this.db(),
          table: webhook_delivery_attempts,
          where: countWhere,
        })
      : Promise.resolve(null);

    const [fetchedRows, total] = await Promise.all([rowsPromise, countPromise]);
    const hasMore = fetchedRows.length > limit;
    const items = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
    const lastItem = items.at(-1);
    return {
      items,
      total,
      limit,
      has_more: hasMore,
      next_cursor: hasMore && lastItem !== undefined ? createOpaqueCursorFromRow(lastItem) : null,
    };
  }

  /** Resolve webhook public_id + organization_id to internal webhook_id for auth */
  async getWebhookId(webhook_public_id: string, organization_id: number): Promise<number | null> {
    const rows = await this.db()
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.public_id, webhook_public_id),
          eq(webhooks.organization_id, organization_id),
          isNull(webhooks.deleted_at),
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * Atomically claims a delivery attempt for outbound HTTP (`PENDING` → `SENDING`,
   * `FAILED` → `SENDING` when BullMQ advances to the next retry, or reclaims a
   * stale `SENDING` row after the lease expires).
   */
  async tryMarkSending(
    deliveryAttemptId: number,
    attemptCount: number,
  ): Promise<WebhookDeliverySendingClaimResult> {
    const staleSendingBefore = new Date(
      Date.now() - WEBHOOK_DELIVERY_STUCK_SENDING_LEASE_MINUTES * MILLISECONDS_PER_MINUTE,
    );
    const requestDatabase = this.db();

    const claimedFromPending = await requestDatabase
      .update(webhook_delivery_attempts)
      .set({
        status: 'SENDING',
        attempt_count: attemptCount,
        sent_at: new Date(),
      })
      .where(
        and(
          eq(webhook_delivery_attempts.id, deliveryAttemptId),
          eq(webhook_delivery_attempts.status, 'PENDING'),
        ),
      )
      .returning({ id: webhook_delivery_attempts.id });

    if (claimedFromPending.length > 0) {
      return 'claimed';
    }

    const reclaimedFailedRetry = await requestDatabase
      .update(webhook_delivery_attempts)
      .set({
        status: 'SENDING',
        attempt_count: attemptCount,
        sent_at: new Date(),
        http_status_code: null,
        response_body: null,
        next_retry_at: null,
      })
      .where(
        and(
          eq(webhook_delivery_attempts.id, deliveryAttemptId),
          eq(webhook_delivery_attempts.status, 'FAILED'),
          lt(webhook_delivery_attempts.attempt_count, attemptCount),
        ),
      )
      .returning({ id: webhook_delivery_attempts.id });

    if (reclaimedFailedRetry.length > 0) {
      return 'claimed';
    }

    const reclaimedStaleSending = await requestDatabase
      .update(webhook_delivery_attempts)
      .set({
        status: 'SENDING',
        attempt_count: attemptCount,
        sent_at: new Date(),
      })
      .where(
        and(
          eq(webhook_delivery_attempts.id, deliveryAttemptId),
          eq(webhook_delivery_attempts.status, 'SENDING'),
          lt(webhook_delivery_attempts.sent_at, staleSendingBefore),
        ),
      )
      .returning({ id: webhook_delivery_attempts.id });

    if (reclaimedStaleSending.length > 0) {
      return 'claimed';
    }

    const statusRows = await requestDatabase
      .select({ status: webhook_delivery_attempts.status })
      .from(webhook_delivery_attempts)
      .where(eq(webhook_delivery_attempts.id, deliveryAttemptId))
      .limit(1);

    if (statusRows[0]?.status === 'SENT') {
      return 'already_sent';
    }

    return 'in_flight';
  }

  /**
   * Persist terminal or in-progress delivery outcome (used by webhook-delivery worker).
   *
   * @remarks
   * - **Side effects:** updates one `webhook_delivery_attempts` row, guarded so a terminal
   *   `SENT` row is never overwritten.
   * - **Notes:** a delivery whose lease expired can be reclaimed and re-sent by another
   *   worker. If the original (slow) worker's outcome lands late, it must NOT flip an
   *   already-delivered (`SENT`) webhook back to `FAILED` — that would resurrect a
   *   delivered attempt and trigger a spurious redelivery. `SENT` is terminal, so the
   *   `ne(status, 'SENT')` guard makes a late write against an already-delivered row a
   *   no-op. The benign at-least-once duplicate that the reclaim itself can cause is
   *   covered receiver-side by the `X-Webhook-Delivery-Id` header.
   */
  async recordOutcome(
    deliveryAttemptId: number,
    outcome: {
      status: string;
      http_status_code?: number | null;
      response_body?: string | null;
      next_retry_at?: Date | null;
    },
  ): Promise<void> {
    await this.db()
      .update(webhook_delivery_attempts)
      .set({
        status: outcome.status,
        http_status_code: outcome.http_status_code ?? null,
        response_body: outcome.response_body ?? null,
        next_retry_at: outcome.next_retry_at ?? null,
      })
      .where(
        and(
          eq(webhook_delivery_attempts.id, deliveryAttemptId),
          ne(webhook_delivery_attempts.status, 'SENT'),
        ),
      );
  }

  /** Record a delivery attempt (used for both real events and test deliveries). */
  async create(data: {
    webhook_id: number;
    event_type: string;
    payload: unknown;
    status: string;
    http_status_code: number | null;
    response_body: string | null;
    sent_at: Date | null;
    attempt_count: number;
  }) {
    const rows = await this.db()
      .insert(webhook_delivery_attempts)
      .values({
        webhook_id: data.webhook_id,
        event_type: data.event_type,
        payload: data.payload,
        status: data.status,
        http_status_code: data.http_status_code,
        response_body: data.response_body,
        sent_at: data.sent_at,
        attempt_count: data.attempt_count,
        // sec-new-B2: generate a public_id for every inserted attempt row so the NOT
        // NULL constraint introduced by the migration is satisfied on both the
        // event-driven path (createPendingWebhookDeliveryAttempt) and this
        // test-delivery / direct-insert path.
        public_id: generatePublicId('webhookDeliveryAttempt'),
      })
      .returning();
    return rows[0]!;
  }
}

/** Worker-only factory — requires an explicit handle from `withAppDatabaseContext`. */
export function createWorkerWebhookDeliveryAttemptRepository(
  databaseHandle: WorkerDatabaseHandle,
): WebhookDeliveryAttemptRepository {
  assertWorkerDatabaseContext(['organization']);
  return new WebhookDeliveryAttemptRepository(databaseHandle);
}
