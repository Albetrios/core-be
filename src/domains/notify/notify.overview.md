`src/domains/notify/`

# Notify

## Purpose

Two delivery surfaces: **in-app notifications** (rows users see in the UI) and **outbound webhook delivery** (HTTPS calls from this platform to customer-configured webhook endpoints).

What it owns:

- The `notify.notifications` table and its delivery worker.
- The `notify.webhooks` and `notify.webhook_delivery_attempts` tables (the outbound webhook config + its delivery/attempt records — one table is both the PENDING outbox row and the attempt record).
- The webhook delivery worker, retry policy, DLQ, and request-id forwarding.
- The in-process listener that turns `NOTIFY_EVENT.WEBHOOK_DELIVERY_REQUESTED` into BullMQ webhook-delivery jobs.

What it does not own: outbound email — that belongs to the [src/infrastructure/mail/](src/infrastructure/mail/) module. Notify enqueues mail jobs but does not send them itself.

## Key invariants

- **At-least-once outbound webhook delivery**: each pending delivery is a `webhook_delivery_attempts` row (status `PENDING`, unique per `(webhook_id, event_key)`) written inside the originating transaction. The delivery worker claims it atomically, retries with exponential backoff (`attempt_count` capped at 5), and lands final failures in DLQ.
- **Delivery record**: the `webhook_delivery_attempts` row tracks status (`PENDING → SENDING → SENT|FAILED`), HTTP status code, response body, and `attempt_count`; delivery history is queryable per webhook.
- **Request-id forwarding**: outbound deliveries include the originating `X-Request-Id` so customers can correlate their server logs with our audit log.
- **Tenant-scoped**: webhook configurations belong to organizations; deliveries fire only to URLs that organization owns.
- **No payload injection from other tenants**: the event payload always derives from the originating organization's data, never merged across tenants.

## Sub-domains

| Sub-domain | Purpose |
| --- | --- |
| [notification](src/domains/notify/sub-domains/notification/) | In-app notification rows: create, list, mark-read, delete. Cursor-paginated read API. |
| [webhook](src/domains/notify/sub-domains/webhook/) | Customer-configured webhook endpoints + the outbound delivery system (queue, worker, attempt log, DLQ). Includes nested `webhook-event` resource. |

## Patterns used

This domain implements the contracts documented in [src/PATTERNS.md](src/PATTERNS.md):

- `transactional-outbox` — the PENDING `webhook_delivery_attempts` row is the outbox; the delivery worker is the dispatcher.
- `tenant-isolation` / `rls-context` — every read and write scoped to the active organization (or the worker's pinned organization context).
- `idempotency` — webhook configuration writes accept `X-Idempotency-Key`.
- `soft-delete` — webhook configurations tombstone with `deleted_at` (subject to retention windows).

## Cross-domain flows

The notify domain does **not** subscribe to other domains' events. Its two surfaces are driven directly:

- **In-app notifications** — created via `createAndDispatchNotification` (persist the row + enqueue channel dispatch), then delivered asynchronously by the `notification` worker.
- **Outbound webhook delivery** — a `webhook_delivery_attempts` row (status `PENDING`) is written inside the originating transaction; the internal `NOTIFY_EVENT.WEBHOOK_DELIVERY_REQUESTED` listener enqueues the BullMQ delivery job on commit.

For reference, adjacent flows do **not** route through notify today: `signup-flow` / `login-flow` / `organization-invitation-flow` send email **directly via the mail outbox** ([src/infrastructure/mail/](src/infrastructure/mail/)); `subscription-change-flow` / `dunning-flow` persist Stripe state only.

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> notification_created: createAndDispatchNotification
  notification_created --> seen: user views in app
  seen --> dismissed: user dismisses
  dismissed --> [*]
  [*] --> delivery_pending: webhook config matches event
  delivery_pending --> delivery_in_flight: worker claims row
  delivery_in_flight --> delivered: 2xx response
  delivery_in_flight --> retry_scheduled: 5xx / timeout, retries left
  retry_scheduled --> delivery_in_flight: backoff elapsed
  delivery_in_flight --> dlq: retries exhausted
  delivered --> [*]
  dlq --> [*]
```

## Events

- Emits: `NOTIFY_EVENT.WEBHOOK_DELIVERY_REQUESTED` (internal — used by the outbox dispatcher).
- Consumes: `NOTIFY_EVENT.WEBHOOK_DELIVERY_REQUESTED` — the internal webhook-delivery listener (the only event this domain subscribes to).

The notify event handlers register through the `domainContainersPlugin` path (in [src/domains/notify/events/](src/domains/notify/events/)) after the DI container is composed — see [CLAUDE.md "Domain events"](CLAUDE.md).

## External integrations

- Customer webhook endpoints (HTTP/HTTPS). Outbound calls use the standard Node fetch + a circuit breaker via `opossum` to protect us from a long-tail of bad customer endpoints.

## Failure modes

- **Customer endpoint returns 5xx / times out** → retry with exponential backoff up to N attempts; final failure → DLQ. Each attempt logged.
- **Worker crash mid-delivery** → BullMQ stalls the job; another worker picks it up after `BULLMQ_WEBHOOK_LOCK_DURATION_MS = 60 000`.
- **Customer endpoint slow but eventually responds** → bounded by the per-attempt timeout (env-tunable); latency logged on the attempt row.
- **Notification fan-out failure** → notification is best-effort relative to the originating event; failure does not roll back the originating transaction.

## Policy constants

See [src/POLICIES.md](src/POLICIES.md):

- `BULLMQ_WEBHOOK_LOCK_DURATION_MS = 60 000`
- `BULLMQ_RETENTION_LOCK_DURATION_MS = 120 000` (used by retention sweepers on attempt logs)
