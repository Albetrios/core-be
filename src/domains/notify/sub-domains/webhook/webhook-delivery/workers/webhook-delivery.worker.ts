import { createHmac } from 'node:crypto';
import { UnrecoverableError, Worker } from 'bullmq';
import { captureMessage } from '@/infrastructure/observability/sentry/sentry.js';
import { getBullMQConnectionOptions } from '@/infrastructure/queue/connection.js';
import { buildOutboundCallOptions, outboundCall } from '@/infrastructure/outbound/index.js';
import { createPinnedWebhookFetch } from '@/shared/utils/security/webhook-outbound-fetch.util.js';
import { getWebhookWorkerOptions } from '@/infrastructure/queue/worker-runtime/worker-options.js';
import {
  fetchWebhookWithCircuitBreaker,
  webhookDeliveryBackoffWithJitter,
} from '@/domains/notify/sub-domains/webhook/webhook-delivery/workers/webhook-outbound-circuit.js';
import { getWorkerConcurrencyWebhook } from '@/shared/config/worker-concurrency.util.js';
import { safeWebhookUrlForLogs } from '@/shared/utils/security/safe-webhook-url-for-logs.util.js';
import { omitUndefined } from '@/shared/utils/validation/omit-undefined.util.js';
import { webhookDeliveryJobDataSchema } from '@/domains/notify/sub-domains/webhook/webhook-delivery/queues/webhook-delivery.job.schema.js';
import {
  WEBHOOK_DELIVERY_JOB_ATTEMPTS,
  WEBHOOK_DELIVERY_QUEUE_NAME,
  type WebhookDeliveryJobData,
} from '@/domains/notify/sub-domains/webhook/webhook-delivery/queues/webhook-delivery.queue.js';
import { parseJobDataOrDeadLetter } from '@/infrastructure/queue/dlq/poison-job.util.js';
import { runWithPropagatedTraceContext } from '@/infrastructure/observability/tracing/trace-context.util.js';
import {
  createWorkerWebhookDeliveryQueries,
  type WebhookDeliveryAttemptWithWebhook,
} from '@/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery.repository.js';
import {
  createWorkerWebhookDeliveryAttemptRepository,
  type WebhookDeliveryAttemptRepository,
} from '@/domains/notify/sub-domains/webhook/webhook-delivery/webhook-delivery-attempt.repository.js';
import { decryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import type { WorkerHandle } from '@/infrastructure/queue/bootstrap.js';
import { buildWorkerHandle } from '@/infrastructure/queue/worker-runtime/worker-close.util.js';
import { withPrincipalDatabaseContext } from '@/infrastructure/database/contexts/principal-database.context.js';
import { resolveOrganizationJobScope } from '@/infrastructure/queue/worker-runtime/job-principal-scope.util.js';
import { MILLISECONDS_PER_HOUR, TEN_SECONDS_MS } from '@/shared/constants/ttl.constants.js';
import { env } from '@/shared/config/env.config.js';

/** Maximum response-body length persisted to the delivery-attempt record (bounds storage growth). */
const WEBHOOK_DELIVERY_RESPONSE_BODY_STORED_MAX_LENGTH = 2_000;

/**
 * audit-#6: hard cap on the number of (decompressed) response bytes the worker will read off the
 * wire before cancelling the stream. The stored body is only {@link WEBHOOK_DELIVERY_RESPONSE_BODY_STORED_MAX_LENGTH}
 * characters, so 16 KiB is comfortably more than we keep while preventing a hostile or broken
 * endpoint from returning a multi-gigabyte / gzip-bomb body that exhausts worker heap (a poison
 * job that OOM-loops across retries and starves every tenant sharing the worker).
 */
const WEBHOOK_DELIVERY_RESPONSE_BODY_READ_MAX_BYTES = 16_384;

/** Suffix appended to a stored response body that was truncated (read cap or stored-length cap). */
const WEBHOOK_DELIVERY_RESPONSE_BODY_TRUNCATION_MARKER = '…[truncated]';

/**
 * Reads at most `maxBytes` of a fetch response body by streaming the reader and cancelling once the
 * cap is hit, so the worker never materialises an unbounded (or gzip-expanded) body in memory.
 *
 * @remarks
 * - **Algorithm:** pulls chunks from `response.body.getReader()` (which yields **decompressed**
 *   bytes, so the cap also bounds a gzip bomb), accumulating until `maxBytes`; the chunk that would
 *   cross the cap is sliced to the remaining budget and the reader is cancelled.
 * - **Failure modes:** when there is no readable stream (e.g. a mocked/empty body) it falls back to
 *   the bounded `response.text()`; the reader is always cancelled in a `finally` to release the
 *   socket.
 * - **Side effects:** consumes (and cancels) the response stream.
 */
async function readResponseBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return { body: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return {
    body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'),
    truncated,
  };
}

/**
 * Clamps a decoded response body to the stored-length cap, appending a truncation marker when the
 * body was cut at either the byte read-cap or the stored-length cap (audit-#6).
 */
function formatStoredResponseBody(decoded: string, networkTruncated: boolean): string {
  const overStoredLimit = decoded.length > WEBHOOK_DELIVERY_RESPONSE_BODY_STORED_MAX_LENGTH;
  if (!(networkTruncated || overStoredLimit)) {
    return decoded;
  }
  return (
    decoded.slice(
      0,
      WEBHOOK_DELIVERY_RESPONSE_BODY_STORED_MAX_LENGTH -
        WEBHOOK_DELIVERY_RESPONSE_BODY_TRUNCATION_MARKER.length,
    ) + WEBHOOK_DELIVERY_RESPONSE_BODY_TRUNCATION_MARKER
  );
}

/** Derived from queue config: `attemptsMade` at or above this value means it is the final attempt. */
const WEBHOOK_DELIVERY_MAX_RETRY_ATTEMPTS = WEBHOOK_DELIVERY_JOB_ATTEMPTS - 1;

/** Base delay (ms) for the persisted `next_retry_at` hint, doubled per attempt. */
const WEBHOOK_DELIVERY_RETRY_BASE_DELAY_MS = TEN_SECONDS_MS;

/**
 * Sign a webhook payload with HMAC-SHA256 (Stripe-style signature).
 */
function signPayload(secret: string, payload: string, timestamp: number): string {
  const signedPayload = `${timestamp}.${payload}`;
  return createHmac('sha256', secret).update(signedPayload).digest('hex');
}

/** Compute the persisted `next_retry_at` hint, or `null` on the final attempt. */
function computeNextRetryAt(attemptsMade: number): Date | null {
  if (attemptsMade >= WEBHOOK_DELIVERY_MAX_RETRY_ATTEMPTS) return null;
  return new Date(Date.now() + WEBHOOK_DELIVERY_RETRY_BASE_DELAY_MS * 2 ** attemptsMade);
}

/**
 * Type of the outbound fetch implementation used by the webhook delivery worker — kept as a
 * separate alias so unit tests can swap in a mock without `as unknown as typeof fetch`.
 *
 * @remarks
 * - **Algorithm:** identical signature to the global `fetch`.
 * - **Failure modes:** errors propagate from the underlying implementation.
 * - **Side effects:** none on its own.
 * - **Notes:** the worker substitutes a DNS-pinned, allowlisted `fetch` for production calls
 *   and accepts the raw global `fetch` only as the test default.
 */
export type WebhookDeliveryFetch = typeof fetch;

const defaultWebhookDeliveryFetch = globalThis.fetch;

/** Job-level context threaded through the three delivery phases. */
interface WebhookDeliveryJobContext {
  id?: string;
  attemptsMade: number;
  requestId?: string;
}

/** Result of the claim phase — either a no-op (idempotent skip) or a claimed attempt to deliver. */
type WebhookDeliveryClaim =
  | { status: 'no_op'; reason: 'already_sent' | 'in_flight' | 'webhook_disabled' }
  | { status: 'claimed'; deliveryContext: WebhookDeliveryAttemptWithWebhook };

/**
 * Phase 1 (short DB transaction): load the attempt + webhook under the organization RLS scope
 * and atomically transition `PENDING → SENDING` (or reclaim a stale lease). Returns the loaded
 * context for the network phase, or a no-op when another worker already sent / holds the lease.
 * The transaction closes before the caller performs any network IO.
 */
async function claimWebhookDeliveryAttempt(options: {
  deliveryAttemptId: number;
  organizationPublicId: string;
  attemptNumber: number;
  deliveryAttemptRepository?: WebhookDeliveryAttemptRepository | undefined;
}): Promise<WebhookDeliveryClaim> {
  const { deliveryAttemptId, organizationPublicId, attemptNumber, deliveryAttemptRepository } =
    options;
  return withPrincipalDatabaseContext(
    resolveOrganizationJobScope(organizationPublicId),
    async (databaseHandle) => {
      const attemptRepository =
        deliveryAttemptRepository ?? createWorkerWebhookDeliveryAttemptRepository(databaseHandle);
      const webhookDeliveryQueries = createWorkerWebhookDeliveryQueries(databaseHandle);
      const deliveryContext = await webhookDeliveryQueries.findWebhookDeliveryAttemptWithWebhook(
        deliveryAttemptId,
        organizationPublicId,
      );
      if (!deliveryContext) {
        throw new Error(`webhook.delivery.attempt_not_found:${String(deliveryAttemptId)}`);
      }
      // sec-N1: the fan-out filter on is_enabled / deleted_at does NOT apply to
      // BullMQ retries — without this re-check, attempts continue firing the
      // signed payload to a URL operators have just disabled or soft-deleted.
      // Record FAILED (terminal, no retry) and return no_op so BullMQ does not
      // re-attempt. tryMarkSending is intentionally skipped — there's no point
      // claiming a row we're about to terminate.
      if (!deliveryContext.webhookIsEnabled || deliveryContext.webhookDeletedAt !== null) {
        await attemptRepository.recordOutcome(deliveryAttemptId, {
          status: 'FAILED',
          response_body: 'webhook_disabled',
          next_retry_at: null,
        });
        return { status: 'no_op', reason: 'webhook_disabled' };
      }
      const sendingClaim = await attemptRepository.tryMarkSending(deliveryAttemptId, attemptNumber);
      if (sendingClaim === 'already_sent' || sendingClaim === 'in_flight') {
        return { status: 'no_op', reason: sendingClaim };
      }
      return { status: 'claimed', deliveryContext };
    },
  );
}

/**
 * Phase 3 (short DB transaction): persist a delivery outcome under the organization RLS scope.
 * Opened fresh (not held across the network call) so a slow endpoint never pins a pool checkout.
 */
async function recordWebhookDeliveryOutcome(options: {
  deliveryAttemptId: number;
  organizationPublicId: string;
  outcome: {
    status: string;
    http_status_code?: number | null;
    response_body?: string | null;
    next_retry_at?: Date | null;
  };
  deliveryAttemptRepository?: WebhookDeliveryAttemptRepository | undefined;
}): Promise<void> {
  const { deliveryAttemptId, organizationPublicId, outcome, deliveryAttemptRepository } = options;
  await withPrincipalDatabaseContext(
    resolveOrganizationJobScope(organizationPublicId),
    async (databaseHandle) => {
      const attemptRepository =
        deliveryAttemptRepository ?? createWorkerWebhookDeliveryAttemptRepository(databaseHandle);
      await attemptRepository.recordOutcome(deliveryAttemptId, outcome);
    },
  );
}

/**
 * Computes the optional `X-Webhook-Signature-Previous` header during the secret-rotation overlap
 * window, or `undefined` when no previous secret applies or the window has closed.
 *
 * @remarks
 * sec-N8 dual-sign: while `now() < secretRotatedAt + WEBHOOK_SECRET_ROTATION_OVERLAP_HOURS`, sign
 * with the previous secret too so a customer mid-rotation still sees a matching signature. A
 * decryption failure on the previous secret is swallowed (drop the header, never fail delivery).
 */
function computeWebhookPreviousSignatureHeader(options: {
  encryptedSecretPrevious: string | null;
  secretRotatedAt: Date | null;
  payloadString: string;
  timestamp: number;
  webhookId: number;
}): string | undefined {
  const { encryptedSecretPrevious, secretRotatedAt, payloadString, timestamp, webhookId } = options;
  if (
    encryptedSecretPrevious === null ||
    encryptedSecretPrevious.length === 0 ||
    secretRotatedAt === null
  ) {
    return undefined;
  }
  const overlapWindowMs = env.WEBHOOK_SECRET_ROTATION_OVERLAP_HOURS * MILLISECONDS_PER_HOUR;
  const rotatedAtMs =
    secretRotatedAt instanceof Date ? secretRotatedAt.getTime() : Number(secretRotatedAt);
  if (!Number.isFinite(rotatedAtMs) || Date.now() >= rotatedAtMs + overlapWindowMs) {
    return undefined;
  }
  try {
    const previousSecret = decryptFieldSecret(encryptedSecretPrevious);
    const previousSignature = signPayload(previousSecret, payloadString, timestamp);
    return `t=${timestamp},v1=${previousSignature}`;
  } catch (decryptError) {
    logger.warn(
      { webhookId, error: decryptError },
      'webhook.delivery.previous_secret_decrypt_failed',
    );
    return undefined;
  }
}

/**
 * Builds the outbound webhook request headers (signature + optional dual-sign / request-id).
 *
 * @remarks
 * sec-N3 + sec-new-B2: `X-Webhook-Delivery-Id` carries the stable per-delivery public id (the same
 * BullMQ job reads the same row → same public id), so receivers can dedupe at-least-once
 * redeliveries without the bigserial leaking table cardinality or enabling enumeration.
 */
function buildWebhookRequestHeaders(options: {
  timestamp: number;
  signature: string;
  eventType: string;
  deliveryAttemptPublicId: string;
  previousSignatureHeader: string | undefined;
  requestId: string | undefined;
}): Record<string, string> {
  const {
    timestamp,
    signature,
    eventType,
    deliveryAttemptPublicId,
    previousSignatureHeader,
    requestId,
  } = options;
  return {
    'Content-Type': 'application/json',
    'X-Webhook-Signature': `t=${timestamp},v1=${signature}`,
    'X-Webhook-Event': eventType,
    'X-Webhook-Timestamp': String(timestamp),
    'X-Webhook-Delivery-Id': deliveryAttemptPublicId,
    ...(previousSignatureHeader ? { 'X-Webhook-Signature-Previous': previousSignatureHeader } : {}),
    ...(requestId ? { 'X-Request-Id': requestId } : {}),
  };
}

/**
 * Reads the delivery response body under the byte cap, returning the stored-form string and never
 * throwing — a read/parse failure is logged and yields a `'[parse error]'` placeholder so the
 * delivery outcome is still recorded.
 *
 * @remarks
 * audit-#6: streams at most {@link WEBHOOK_DELIVERY_RESPONSE_BODY_READ_MAX_BYTES} off the wire so a
 * hostile or broken endpoint cannot OOM the shared worker via a huge / gzip-expanded body.
 */
async function readWebhookResponseBodyOrPlaceholder(options: {
  response: Response;
  jobContext: WebhookDeliveryJobContext;
  deliveryAttemptId: number;
  webhookId: number;
  webhookUrlLogFields: ReturnType<typeof safeWebhookUrlForLogs>;
}): Promise<string> {
  const { response, jobContext, deliveryAttemptId, webhookId, webhookUrlLogFields } = options;
  try {
    const capped = await readResponseBodyCapped(
      response,
      WEBHOOK_DELIVERY_RESPONSE_BODY_READ_MAX_BYTES,
    );
    return formatStoredResponseBody(capped.body, capped.truncated);
  } catch (parseError) {
    logger.warn(
      {
        jobId: jobContext.id,
        requestId: jobContext.requestId,
        deliveryAttemptId,
        webhookId,
        ...webhookUrlLogFields,
        parseError: parseError instanceof Error ? parseError.message : 'Unknown error',
      },
      'webhook.response.body.parse.failed',
    );
    return '[parse error]';
  }
}

/**
 * Phase 2 (no DB context): HMAC-sign the payload and POST it through the per-webhook circuit
 * breaker / DNS-pinned fetch, then record the outcome via a fresh short transaction. Runs with
 * no open Postgres transaction so the up-to-~35s outbound call cannot starve the pool.
 */
async function deliverClaimedWebhook(options: {
  deliveryAttemptId: number;
  organizationPublicId: string;
  jobContext: WebhookDeliveryJobContext;
  fetchImplementation: WebhookDeliveryFetch;
  deliveryAttemptRepository?: WebhookDeliveryAttemptRepository | undefined;
  deliveryContext: WebhookDeliveryAttemptWithWebhook;
}): Promise<{ httpStatus: number; success: true }> {
  const {
    deliveryAttemptId,
    organizationPublicId,
    jobContext,
    fetchImplementation,
    deliveryAttemptRepository,
    deliveryContext,
  } = options;
  const {
    webhookId,
    webhookUrl,
    encryptedSecret,
    eventType,
    payload,
    encryptedSecretPrevious,
    secretRotatedAt,
    // sec-new-B2: opaque public identifier read from the DB row (generated once at
    // insert) — stable across BullMQ retries so receivers can use it as a dedupe
    // key without seeing the bigserial.
    deliveryAttemptPublicId,
  } = deliveryContext;
  const payloadString = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signingSecret = decryptFieldSecret(encryptedSecret);
  // P0-#1: fail-closed on empty signing secret. Previously we skipped the signature header
  // and shipped the payload anyway, leaving the receiver unable to distinguish "secret
  // rotated to empty" from "attacker stripped the header". An attacker who can flip a
  // webhook into that state — or read an unsigned legitimate delivery — gets forge
  // capability against any receiver still trusting the request. Treat it as a
  // configuration regression: record FAILED terminally, page on-call via Sentry, and
  // mark the BullMQ job UnrecoverableError so it skips retries and lands in the DLQ.
  if (signingSecret.length === 0) {
    captureMessage('webhook.delivery.empty_signing_secret', {
      level: 'error',
      extra: { webhookId, deliveryAttemptId, eventType },
    });
    logger.error(
      { webhookId, deliveryAttemptId, eventType },
      'webhook.delivery.empty_signing_secret',
    );
    await recordWebhookDeliveryOutcome({
      deliveryAttemptId,
      organizationPublicId,
      deliveryAttemptRepository,
      outcome: {
        status: 'FAILED',
        response_body: 'empty_signing_secret',
        next_retry_at: null,
      },
    });
    throw new UnrecoverableError('webhook.delivery.empty_signing_secret');
  }
  const signature = signPayload(signingSecret, payloadString, timestamp);

  // sec-N8: dual-sign while inside the rotation overlap window so a customer who has not yet
  // rolled their verifier still sees a matching signature (decrypt failures drop the header).
  const previousSignatureHeader = computeWebhookPreviousSignatureHeader({
    encryptedSecretPrevious,
    secretRotatedAt,
    payloadString,
    timestamp,
    webhookId,
  });

  const webhookUrlLogFields = safeWebhookUrlForLogs(webhookUrl);

  logger.info(
    {
      jobId: jobContext.id,
      requestId: jobContext.requestId,
      deliveryAttemptId,
      webhookId,
      eventType,
      ...webhookUrlLogFields,
      attempt: jobContext.attemptsMade + 1,
    },
    'webhook.delivery.sending',
  );

  try {
    const pinnedFetch =
      fetchImplementation === defaultWebhookDeliveryFetch
        ? await createPinnedWebhookFetch(webhookUrl)
        : fetchImplementation;

    const requestHeaders = buildWebhookRequestHeaders({
      timestamp,
      signature,
      eventType,
      deliveryAttemptPublicId,
      previousSignatureHeader,
      requestId: jobContext.requestId,
    });

    const response = await outboundCall(
      buildOutboundCallOptions({
        name: 'webhook',
        circuit: null,
        requestId: jobContext.requestId,
        operation: async (signal) =>
          fetchWebhookWithCircuitBreaker({
            webhookId,
            webhookUrl,
            init: {
              method: 'POST',
              headers: requestHeaders,
              body: payloadString,
              signal,
            },
            fetchImplementation: pinnedFetch,
          }),
      }),
    );

    const responseBody = await readWebhookResponseBodyOrPlaceholder({
      response,
      jobContext,
      deliveryAttemptId,
      webhookId,
      webhookUrlLogFields,
    });
    const httpStatus = response.status;
    const isSuccess = httpStatus >= 200 && httpStatus < 300;

    if (isSuccess) {
      await recordWebhookDeliveryOutcome({
        deliveryAttemptId,
        organizationPublicId,
        deliveryAttemptRepository,
        outcome: {
          status: 'SENT',
          http_status_code: httpStatus,
          response_body: responseBody,
        },
      });
      return { httpStatus, success: true };
    }

    await recordWebhookDeliveryOutcome({
      deliveryAttemptId,
      organizationPublicId,
      deliveryAttemptRepository,
      outcome: {
        status: 'FAILED',
        http_status_code: httpStatus,
        response_body: responseBody,
        next_retry_at: computeNextRetryAt(jobContext.attemptsMade),
      },
    });
    throw new Error(`Webhook delivery failed with HTTP ${String(httpStatus)}`);
  } catch (error) {
    const isRecordedHttpFailure =
      error instanceof Error && error.message.startsWith('Webhook delivery failed with HTTP');
    if (!isRecordedHttpFailure) {
      await recordWebhookDeliveryOutcome({
        deliveryAttemptId,
        organizationPublicId,
        deliveryAttemptRepository,
        outcome: {
          status: 'FAILED',
          response_body: error instanceof Error ? error.message : 'Unknown error',
          next_retry_at: computeNextRetryAt(jobContext.attemptsMade),
        },
      });
    }

    throw error;
  }
}

/**
 * Delivers a single webhook attempt (testable with an injected fetch implementation).
 *
 * @remarks
 * - **Algorithm:** three sequential phases, each owning its own short Postgres transaction so no
 *   pool checkout is held across the network call:
 *   1. **claim** (short txn) — load the attempt + webhook secret under `withPrincipalDatabaseContext`
 *      and atomically transition `PENDING → SENDING` (or reclaim a stale lease; no-op on
 *      `already_sent` / `in_flight`);
 *   2. **deliver** (no DB context) — HMAC-SHA256 sign `<timestamp>.<payload>` and POST through
 *      the per-webhook circuit breaker / DNS-pinned fetch;
 *   3. **record** (short txn) — write `SENT` (2xx) or `FAILED` with the truncated response body.
 * - **Failure modes:** rethrows any error after writing a `FAILED` outcome with `next_retry_at`
 *   for the next exponential backoff slot (10s × 2^attemptsMade for the first 4 retries; null on
 *   the final attempt so BullMQ promotes the job to the DLQ via `dead-letter.ts`).
 *   `attempt_not_found` (missing or cross-tenant attempt) short-circuits without a failure record.
 * - **Side effects:** outbound HTTPS POST; updates to `webhook_delivery_attempts`; structured
 *   logs at every transition.
 * - **Notes:** the dependency-injection seam (`fetchImplementation`, `deliveryAttemptRepository`)
 *   is exclusively for unit tests; production paths must use the pinned fetch and the
 *   worker-scoped repository factories.
 */
export async function processWebhookDeliveryAttempt(
  deliveryAttemptId: number,
  organizationPublicId: string,
  jobContext: WebhookDeliveryJobContext,
  fetchImplementation: WebhookDeliveryFetch = globalThis.fetch,
  deliveryAttemptRepository?: WebhookDeliveryAttemptRepository,
): Promise<{ httpStatus: number; success: true }> {
  let claim: WebhookDeliveryClaim;
  try {
    claim = await claimWebhookDeliveryAttempt({
      deliveryAttemptId,
      organizationPublicId,
      attemptNumber: jobContext.attemptsMade + 1,
      deliveryAttemptRepository,
    });
  } catch (error) {
    const isAttemptNotFound =
      error instanceof Error && error.message.startsWith('webhook.delivery.attempt_not_found:');
    if (deliveryAttemptRepository === undefined && !isAttemptNotFound) {
      await recordWebhookDeliveryOutcome({
        deliveryAttemptId,
        organizationPublicId,
        outcome: {
          status: 'FAILED',
          response_body: error instanceof Error ? error.message : 'Unknown error',
          next_retry_at: computeNextRetryAt(jobContext.attemptsMade),
        },
      });
    }
    throw error;
  }

  if (claim.status === 'no_op') {
    logger.info(
      { deliveryAttemptId, requestId: jobContext.requestId },
      `webhook.delivery.${claim.reason}`,
    );
    return { httpStatus: 200, success: true };
  }

  return deliverClaimedWebhook({
    deliveryAttemptId,
    organizationPublicId,
    jobContext,
    fetchImplementation,
    deliveryAttemptRepository,
    deliveryContext: claim.deliveryContext,
  });
}

/**
 * Creates a BullMQ worker that delivers outbound webhooks with HMAC signing.
 *
 * @remarks
 * - **Algorithm:** registers a BullMQ worker on {@link WEBHOOK_DELIVERY_QUEUE_NAME} that parses
 *   the job payload through {@link webhookDeliveryJobDataSchema} and delegates to
 *   {@link processWebhookDeliveryAttempt}, which manages its own short organization-scoped
 *   transactions around (not across) the outbound HMAC-signed POST.
 * - **Failure modes:** delivery failures (timeout, non-2xx, network error) are persisted on
 *   the attempt row and rethrown so BullMQ retries up to 5 times using the custom backoff
 *   {@link webhookDeliveryBackoffWithJitter} (~10s × 2^attempt with up to 30% jitter); the
 *   final failure routes the job to the per-queue DLQ via the bootstrap dead-letter wiring.
 * - **Side effects:** subscribes a `Worker` to Redis with webhook-tuned options; performs
 *   outbound HTTPS calls via a pinned fetch wrapped in a per-webhook circuit breaker; writes the
 *   audit trail to `notify.webhook_delivery_attempts`.
 * - **Notes:** the worker no longer holds a Postgres pool checkout while the outbound request is
 *   in flight (claim and record run in separate short transactions); concurrency comes from
 *   `getWorkerConcurrencyWebhook()`; the returned handle is wired into bootstrap for graceful
 *   shutdown and lock release.
 */
export function createWebhookDeliveryWorker(): WorkerHandle {
  const worker = new Worker<WebhookDeliveryJobData>(
    WEBHOOK_DELIVERY_QUEUE_NAME,
    async (job) => {
      const { deliveryAttemptId, organizationPublicId, requestId, traceparent, tracestate } =
        await parseJobDataOrDeadLetter({
          schema: webhookDeliveryJobDataSchema,
          job,
          queueName: WEBHOOK_DELIVERY_QUEUE_NAME,
        });
      return runWithPropagatedTraceContext({ traceparent, tracestate }, job.name, () =>
        processWebhookDeliveryAttempt(
          deliveryAttemptId,
          organizationPublicId,
          omitUndefined({
            id: job.id,
            attemptsMade: job.attemptsMade,
            requestId,
          }),
        ),
      );
    },
    {
      connection: getBullMQConnectionOptions(),
      concurrency: getWorkerConcurrencyWebhook(),
      ...getWebhookWorkerOptions(),
      settings: {
        backoffStrategy: webhookDeliveryBackoffWithJitter,
      },
    },
  );

  worker.on('stalled', (jobId) => {
    logger.warn({ jobId, queue: WEBHOOK_DELIVERY_QUEUE_NAME }, 'webhook.delivery.stalled');
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job?.id }, 'webhook.delivery.completed');
  });

  return buildWorkerHandle(worker, WEBHOOK_DELIVERY_QUEUE_NAME);
}
