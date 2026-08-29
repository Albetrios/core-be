import { sql } from 'drizzle-orm';
import {
  bigserial,
  bigint,
  check,
  index,
  jsonb,
  pgPolicy,
  smallint,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import { auditSchema } from '@/infrastructure/database/pg-schemas.js';

/**
 * Transactional outbox for {@link logs}. An audit row is staged here INSIDE the
 * caller's business transaction (so it commits atomically with the write being
 * audited) and the {@link auditOutboxDrainProcessor} drains pending rows into
 * `audit.logs` asynchronously.
 *
 * @remarks
 * Storage choice — we keep raw `public_id` columns instead of resolving to FKs
 * at insert time so:
 * 1. The hot-path insert is a single write with no `SELECT` lookups.
 * 2. The drain worker can mark a row `FAILED` (instead of silently dropping
 *    audit) when an actor or organization no longer resolves at drain time.
 * 3. We never block a business write on an audit-side row vanishing mid-request.
 *
 * Status transitions: `PENDING → PROCESSED` on successful drain;
 * `PENDING → FAILED` after `MAX_ATTEMPTS` drain retries (then operator triage).
 *
 * RLS — mirrors the {@link logs} INSERT/SELECT pattern. INSERT is permitted only
 * under the tenant context (`app.current_organization_public_id`) or the tenantless
 * system-audit arm (`app.system_audit_insert = 'true'` AND
 * `organization_public_id IS NULL`). SELECT/UPDATE/DELETE require the drain
 * context (`app.audit_outbox_drain = 'true'`) which is set only by the drain
 * worker — preventing any tenant from reading another tenant's pending rows.
 *
 * @see [logs] for the canonical audit ledger; [audit-outbox-drain.processor]
 *      for the drain worker.
 */
export const audit_outbox = auditSchema
  .table(
    'outbox',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      /** Lifecycle: `PENDING` → `PROCESSED` (drained) | `FAILED` (max retries). */
      status: varchar('status', { length: 20 }).notNull().default('PENDING'),
      /** Actor user public id (NanoID 21). One of actor_user_public_id / actor_api_key_public_id is required. */
      actor_user_public_id: varchar('actor_user_public_id', { length: 28 }),
      /** Actor organization API key public id (NanoID 21). Used for tenantless-actor (API key) writes. */
      actor_api_key_public_id: varchar('actor_api_key_public_id', { length: 28 }),
      /** Optional target user public id (NanoID 21). */
      target_user_public_id: varchar('target_user_public_id', { length: 28 }),
      /**
       * Organization public id (NanoID 21). `NULL` for tenantless system audits (DLQ replay etc.)
       * and gated by the RLS system-audit arm.
       */
      organization_public_id: varchar('organization_public_id', { length: 28 }),
      /** Audit action verb (e.g. `user.created`, `webhook.deleted`). */
      action: varchar('action', { length: 100 }).notNull(),
      /** Resource type (e.g. `user`, `webhook`). */
      resource_type: varchar('resource_type', { length: 50 }).notNull(),
      /** Internal id of the resource acted upon (already known in caller's transaction). */
      resource_id: bigint('resource_id', { mode: 'number' }),
      /** Request IP captured by the caller. */
      ip_address: varchar('ip_address', { length: 45 }),
      /** Request User-Agent captured by the caller. */
      user_agent: text('user_agent'),
      /** Severity (mirrors {@link logs.severity} CHECK). */
      severity: varchar('severity', { length: 20 }).notNull().default('INFO'),
      /** Free-form structured metadata copied verbatim into {@link logs.metadata}. */
      metadata: jsonb('metadata').notNull().default({}),
      /** Drain attempt counter — bounded by `AUDIT_OUTBOX_DRAIN_MAX_ATTEMPTS` env. */
      attempt_count: smallint('attempt_count').notNull().default(0),
      /** Last drain failure message; null until first failure. */
      last_error: text('last_error'),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
      /** Drain timestamp; set on `PENDING → PROCESSED` so retention can prune drained rows. */
      processed_at: timestamp('processed_at', { withTimezone: true }),
    },
    (table) => [
      /** Drain claim path: `WHERE status = 'PENDING' ORDER BY created_at`. */
      index('idx_audit_outbox_status_created_at').on(table.status, table.created_at),
      /** Per-organization operator triage: list FAILED rows for a single tenant. */
      index('idx_audit_outbox_org_status').on(table.organization_public_id, table.status),
      check('chk_audit_outbox_status', sql`${table.status} IN ('PENDING', 'PROCESSED', 'FAILED')`),
      check(
        'chk_audit_outbox_severity',
        sql`${table.severity} IN ('DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL')`,
      ),
      /**
       * Mirrors {@link logs} actor-required invariant: at least one of
       * actor_user_public_id / actor_api_key_public_id must be set so audit rows can
       * always be attributed. The drain worker re-checks this at drain time to
       * surface broken callers as FAILED rather than silently writing a bogus log.
       */
      check(
        'chk_audit_outbox_actor_present',
        sql`${table.actor_user_public_id} IS NOT NULL OR ${table.actor_api_key_public_id} IS NOT NULL`,
      ),
      check('chk_audit_outbox_attempt_count_nonneg', sql`${table.attempt_count} >= 0`),
      /**
       * INSERT — tenant context writes its own organization row, OR system-audit context
       * writes a tenantless (`organization_public_id IS NULL`) row. Identical
       * shape to the {@link logs} INSERT policy so callers that already work
       * under either context need no GUC changes.
       */
      pgPolicy('audit_outbox_tenant_isolation_insert', {
        as: 'permissive',
        for: 'insert',
        to: 'public',
        withCheck: sql`${table.organization_public_id} = current_setting('app.current_organization_public_id', true)
          OR (
            ${table.organization_public_id} IS NULL
            AND current_setting('app.system_audit_insert', true) = 'true'
          )`,
      }),
      /**
       * SELECT / UPDATE / DELETE — drain-worker-only via the dedicated
       * `app.audit_outbox_drain` GUC. Prevents any tenant from reading another
       * tenant's pending audit, and prevents accidental UPDATE/DELETE from a
       * request-scoped context.
       */
      pgPolicy('audit_outbox_drain_select', {
        as: 'permissive',
        for: 'select',
        to: 'public',
        using: sql`current_setting('app.audit_outbox_drain', true) = 'true'`,
      }),
      pgPolicy('audit_outbox_drain_update', {
        as: 'permissive',
        for: 'update',
        to: 'public',
        using: sql`current_setting('app.audit_outbox_drain', true) = 'true'`,
        withCheck: sql`current_setting('app.audit_outbox_drain', true) = 'true'`,
      }),
      pgPolicy('audit_outbox_drain_delete', {
        as: 'permissive',
        for: 'delete',
        to: 'public',
        using: sql`current_setting('app.audit_outbox_drain', true) = 'true'`,
      }),
    ],
  )
  .enableRLS();

/** Drizzle-inferred insert row shape for {@link audit_outbox}. */
export type AuditOutboxInsert = typeof audit_outbox.$inferInsert;
/** Drizzle-inferred row shape for reads (used by the drain worker). */
export type AuditOutboxRow = typeof audit_outbox.$inferSelect;
