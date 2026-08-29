`src/domains/notify/sub-domains/webhook/webhook-delivery/`

# Webhook delivery (nested implementation)

Parent: [webhook](../webhook.overview.md)

## Purpose

Outbound webhook HTTP delivery: durable attempt records, BullMQ queue/worker, circuit breaker, and event-bus handlers that enqueue delivery jobs after the subscription service commits.

## Layout

- `webhook-delivery.repository.ts` / `webhook-delivery-attempt.repository.ts` — persistence
- `queues/` — BullMQ job schema + enqueue helpers
- `workers/` — delivery processor + outbound circuit breaker
- `events/` — in-process emit + handlers (types remain in parent `webhook/events/notify.events.ts`)

## Key invariants

- Delivery attempts are organization-scoped; workers pass `organizationPublicId` in job payloads.
- The dashboard history read (`listByWebhook`) takes a `webhook_id` the controller already resolved for the active organization (`getWebhookId(public_id, organization_id)`), and the `webhook_delivery_attempts_tenant_isolation` RLS policy backstops it — a foreign `webhook_id` returns zero rows, so no extra organization predicate is needed on the page read.
- SSRF protections and pinned DNS apply in the worker outbound fetch path.
- Tombstone retention for old delivery rows stays on the parent `webhook/workers/` aggregate.
