# BullMQ Board (Bull Board)

The app uses [Bull Board](https://github.com/felixmosh/bull-board) to inspect BullMQ queues at a web UI.

---

## Flow

```mermaid
flowchart LR
  A[ENABLE_QUEUE_DASHBOARD=true] --> B[Start server]
  B --> C[Get super_admin JWT]
  C --> D[/admin/queues]
```

Set ENABLE_QUEUE_DASHBOARD → start server → super_admin JWT → /admin/queues.

---

## Enable the dashboard

1. Set in `.env`:

   ```bash
   ENABLE_QUEUE_DASHBOARD=true
   ```

2. Start the API server: `pnpm dev`
3. The dashboard is mounted at **`/admin/queues`**

## Dead-letter queues (DLQ)

When a job exhausts retries, the worker enqueues a snapshot to **`<queue-name>-dlq`** (see [`dead-letter.ts`](../../../src/infrastructure/queue/dlq/dead-letter.ts)). The dashboard lists DLQ queues alongside producers.

**Operational playbook:**

1. Inspect failed jobs in Bull Board (`*-dlq` queues).
2. Read `original_data_summary` (metadata only — no secrets or full payloads).
3. Fix root cause (code, config, downstream vendor).
4. Re-queue manually from Postgres source rows (mail outbox, webhook delivery attempts, `billing.stripe_webhook_events` with `processing_status = failed`) or replay with a one-off script — there is no automatic DLQ consumer.
5. Alert on Sentry fingerprint `worker_final_failure` for sustained failure rates.
6. Watch scheduled **`queue.dlq.depth.high`** warnings (`DLQ_DEPTH_WARN_THRESHOLD`, default 10 jobs waiting + failed per DLQ).

### Per-queue replay notes

| DLQ queue              | Prefer replay from                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `mail-dlq`             | `auth.mail_outbox` row (`status = failed`) — re-enqueue mail job with `mailOutboxId`                                                |
| `webhook-delivery-dlq` | `notify.webhook_delivery_attempts` — create new attempt or fix URL and re-enqueue with `deliveryAttemptId` + `organizationPublicId` |
| `stripe-webhook-dlq`   | `billing.stripe_webhook_events` — fix root cause, then re-enqueue verified Stripe event payload or replay from Stripe Dashboard     |
| Other `*-dlq`          | Bull Board **Retry** on the DLQ job after fixing code/config                                                                        |

## Access (auth required)

- The route is protected by **JWT** and **global role** `super_admin` only (not `admin`).
- Send a valid JWT with that role in the `Authorization: Bearer <token>` header.

### Get a super_admin JWT

For local/dev, sign in as a super_admin with the script. It needs an account whose email is on `GLOBAL_ADMIN_EMAILS`; create one with `DEMO_EMAIL=<admin email> pnpm db:seed:demo-admin`. Then, with the server running:

```bash
pnpm tool:admin-token
```

The token belongs to a real session and lives `GLOBAL_ADMIN_ACCESS_TOKEN_EXPIRY_SECONDS` (default 5 minutes). Copy it, then either:

- **Browser**: Use an extension or devtools to add `Authorization: Bearer <your-token>` to requests to `http://localhost:3000/admin/queues`, or
- **curl**:

  ```bash
  export ADMIN_TOKEN="<paste-token-here>"
  curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3000/admin/queues
  ```

  (The UI is HTML/JS; for full UI open the URL in a browser and set the header via extension or proxy.)

## Audit logging

Successful **mutating** Bull Board HTTP calls (`POST`, `PUT`, `PATCH`, `DELETE`) under **`/admin/queues/api/...`** that return **2xx** are persisted to **`audit.logs`**:

- **actor**: resolved from the JWT subject (user public id → internal `actor_user_id`)
- **`resource_type`**: `queue`
- **`action`**: normalized verbs such as `queue.pause`, `queue.resume`, `queue.job.retry`, `queue.clean`, `queue.promote`, `queue.pause_all`, `queue.unknown`, etc. (see `parseQueueDashboardMutation` in `src/infrastructure/queue/queue-dashboard.ts`)
- **`metadata`**: includes `queue`, optional `jobId`, `method`, `url`, and extra fields when relevant (e.g. `queueStatus` for clean/retry-by-status)

**Not** recorded: read-only requests (e.g. `GET`), non-2xx responses, and failures while writing the audit row (logged server-side only; they do not fail the dashboard request).

## Queues shown

Source queues (Bull Board adapters) registered in [`src/infrastructure/queue/queue-dashboard.ts`](../../../src/infrastructure/queue/queue-dashboard.ts) → `SOURCE_QUEUE_NAMES`:

**Work queues:**

- `mail`
- `webhook-delivery`
- `notification`
- `stripe-webhook`

**Retention / cleanup queues:**

- `audit-retention`
- `session-cleanup`
- `webhook-tombstone-retention`
- `organization-notification-policy-tombstone-retention`
- `user-tombstone-retention`
- `organization-tombstone-retention`
- `membership-tombstone-retention`
- `member-role-tombstone-retention`
- `organization-api-key-tombstone-retention`
- `upload-tombstone-retention`

**Observability queues:**

- `idempotency-cardinality`
- `dlq-depth`

For each source queue, a **dead-letter** mirror named `<source-queue-name>-dlq` is also registered when the dashboard is enabled (except observability-only schedulers without DLQ consumers).

When adding a new BullMQ queue, append its constant to `SOURCE_QUEUE_NAMES` in `queue-dashboard.ts` (and update this list). See **[be-workers-events skill](../../../.cursor/skills/be-workers-events/SKILL.md)** for the full registration checklist.

## Production

Leave `ENABLE_QUEUE_DASHBOARD` unset or `false` in production unless you need the UI; see [production-go-live.md](../../deployment/runbooks/production-go-live.md).
