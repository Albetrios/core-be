import {
  bigint,
  bigserial,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { notifySchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';

/**
 * Drizzle table for `notify.webhooks` — per-organization HTTPS endpoints with their encrypted
 * signing secret and the list of event types they subscribe to. Soft-deleted via `deleted_at`
 * (the tombstone-retention worker hard-deletes rows after `TOMBSTONE_RETENTION_DAYS`).
 * RLS pins reads to the current organization or the global retention scope.
 */
export const webhooks = notifySchema
  .table(
    'webhooks',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      public_id: varchar('public_id', { length: 28 }).notNull(),
      organization_id: bigint('organization_id', { mode: 'number' })
        .notNull()
        .references(() => organizations.id, { onDelete: 'cascade' }),
      url: text('url').notNull(),
      encrypted_secret: varchar('encrypted_secret', { length: 255 }).notNull(),
      // sec-N8: rotation overlap window. The PRIOR encrypted_secret survives
      // a rotation so the worker can dual-sign for an env-configurable
      // window (WEBHOOK_SECRET_ROTATION_OVERLAP_HOURS, default 24h) while
      // the customer rolls their verifier. After the window the worker stops
      // sending X-Webhook-Signature-Previous; the column itself is not
      // cleared (re-rotation overwrites it; no separate sweeper).
      encrypted_secret_previous: varchar('encrypted_secret_previous', { length: 255 }),
      secret_rotated_at: timestamp('secret_rotated_at', { withTimezone: true }),
      events: jsonb('events').notNull(),
      is_enabled: boolean('is_enabled').notNull().default(true),
      deleted_at: timestamp('deleted_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
      created_by_user_id: bigint('created_by_user_id', { mode: 'number' }).references(
        () => users.id,
      ),
      updated_by_user_id: bigint('updated_by_user_id', { mode: 'number' }).references(
        () => users.id,
      ),
    },
    (table) => [
      uniqueIndex('idx_webhooks_public_id').on(table.public_id),
      index('idx_webhooks_org_enabled').on(table.organization_id, table.is_enabled),
      index('idx_webhooks_org_created_id_active')
        .on(table.organization_id, table.created_at, table.id)
        .where(sql`${table.deleted_at} IS NULL`),
      // audit-#4 (verified non-issue): this is a FULL unique index on purpose.
      // WebhookRepository.create() upserts ON CONFLICT (organization_id, url) and
      // resurrects a soft-deleted row (sets deleted_at = NULL), so re-creating a
      // webhook at a previously deleted URL already works WITHOUT a unique
      // violation. A partial (deleted_at IS NULL) index would break that ON
      // CONFLICT inference (Postgres 42P10), so it is intentionally kept full.
      uniqueIndex('idx_webhooks_organization_id_url_unique').on(table.organization_id, table.url),
      check('chk_webhooks_url', sql`${table.url} ~ '^https://'`),
      check('chk_webhooks_updated', sql`${table.updated_at} >= ${table.created_at}`),
      // P0-#1 defense in depth: the worker fail-closes when the *decrypted* signing secret
      // is empty, but the ciphertext column itself must also never be empty. The DTO bound,
      // service guard, and worker check all prevent that today; this constraint blocks any
      // future code path (or direct DB write) from regressing the invariant.
      check('chk_webhooks_encrypted_secret_not_empty', sql`length(${table.encrypted_secret}) > 0`),
      pgPolicy('webhooks_tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )
          OR current_setting('app.global_retention_cleanup', true) = 'true'`,
        withCheck: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )`,
      }),
    ],
  )
  .enableRLS();

/**
 * Drizzle table for `notify.webhook_delivery_attempts` — the immutable audit trail of outbound
 * webhook deliveries. Status moves through `PENDING → SENDING → SENT|FAILED`, attempt count is
 * capped at 5 by check constraint, and a partial unique index on `(webhook_id, event_key)`
 * guards against duplicate pending deliveries for idempotent producer events.
 */
export const webhook_delivery_attempts = notifySchema
  .table(
    'webhook_delivery_attempts',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      // sec-new-B2: opaque public identifier used as the X-Webhook-Delivery-Id outbound
      // header value so receivers get a stable dedupe key without exposing the bigserial.
      public_id: varchar('public_id', { length: 28 }).notNull(),
      webhook_id: bigint('webhook_id', { mode: 'number' })
        .notNull()
        .references(() => webhooks.id, { onDelete: 'cascade' }),
      event_type: varchar('event_type', { length: 50 }).notNull(),
      event_key: varchar('event_key', { length: 255 }),
      payload: jsonb('payload').notNull(),
      status: varchar('status', { length: 20 }).notNull().default('PENDING'),
      http_status_code: integer('http_status_code'),
      response_body: text('response_body'),
      sent_at: timestamp('sent_at', { withTimezone: true }),
      attempt_count: integer('attempt_count').notNull().default(0),
      next_retry_at: timestamp('next_retry_at', { withTimezone: true }),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      index('idx_webhook_attempts_webhook').on(
        table.webhook_id,
        table.event_type,
        table.created_at,
      ),
      index('idx_webhook_attempts_webhook_created_id').on(
        table.webhook_id,
        table.created_at,
        table.id,
      ),
      index('idx_webhook_attempts_retry').on(table.status, table.next_retry_at),
      // audit-#3: supports the time-based retention sweep (DELETE WHERE created_at < cutoff).
      index('idx_webhook_attempts_created_at').on(table.created_at),
      uniqueIndex('idx_webhook_delivery_attempts_public_id').on(table.public_id),
      uniqueIndex('idx_webhook_delivery_attempts_pending_event_key')
        .on(table.webhook_id, table.event_key)
        .where(sql`${table.status} = 'PENDING' AND ${table.event_key} IS NOT NULL`),
      check(
        'chk_webhook_attempts_status',
        sql`${table.status} IN ('PENDING', 'SENDING', 'SENT', 'FAILED')`,
      ),
      check(
        'chk_webhook_attempts_count',
        sql`${table.attempt_count} >= 0 AND ${table.attempt_count} <= 5`,
      ),
      pgPolicy('webhook_delivery_attempts_tenant_isolation', {
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: sql`${table.webhook_id} IN (
            SELECT id FROM notify.webhooks
            WHERE organization_id = (
              SELECT id FROM tenancy.organizations
              WHERE public_id = current_setting('app.current_organization_public_id', true)
            )
          )
          OR current_setting('app.global_retention_cleanup', true) = 'true'`,
        withCheck: sql`${table.webhook_id} IN (
            SELECT id FROM notify.webhooks
            WHERE organization_id = (
              SELECT id FROM tenancy.organizations
              WHERE public_id = current_setting('app.current_organization_public_id', true)
            )
          )`,
      }),
    ],
  )
  .enableRLS();
