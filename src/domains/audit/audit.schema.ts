import { sql } from 'drizzle-orm';
import {
  bigserial,
  bigint,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
  check,
  pgPolicy,
} from 'drizzle-orm/pg-core';
import { auditSchema } from '@/infrastructure/database/pg-schemas.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { api_keys } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.schema.js';

/**
 * Drizzle definition for `audit.logs` — the append-only ledger of actor/resource
 * actions. RLS tenant-isolation policies scope access by operation type:
 * - **INSERT** (WITH CHECK): only normal tenant context (`app.current_organization_public_id`)
 *   may write rows. Neither `app.global_admin` nor `app.global_retention_cleanup`
 *   is permitted on INSERT — they are read/delete contexts only (sec-r4-D1).
 * - **SELECT** (USING): tenant context, `app.global_retention_cleanup`, and the
 *   cross-tenant admin escape hatch `app.global_admin` (used by admin audit-log
 *   listing via `withMaintenanceDatabaseContext`) are all permitted for reads.
 * - **DELETE** (USING): `app.global_retention_cleanup` only; admin is not on DELETE.
 *
 * Storage: the migrations create this as a plain table (`id bigserial PRIMARY KEY`). High-volume
 * hosted environments may RANGE-partition it by `created_at` out-of-band — that partitioning is
 * intentionally NOT in the repo migrations (it would require a composite `(id, created_at)` PK
 * plus partition management). App code and the FK migration `20260601120000` are written to work
 * with both shapes. See `docs/reference/security/audit-logs.md`.
 */
export const logs = auditSchema
  .table(
    'logs',
    {
      id: bigserial('id', { mode: 'number' }).primaryKey(),
      actor_user_id: bigint('actor_user_id', { mode: 'number' }).references(() => users.id, {
        onDelete: 'set null',
      }),
      // Set instead of actor_user_id when the action was performed by an organization API key
      // (which has no acting user). Nullable + ON DELETE SET NULL like actor_user_id; the app
      // guarantees at least one of the two actor columns is set at write time.
      actor_api_key_id: bigint('actor_api_key_id', { mode: 'number' }).references(
        () => api_keys.id,
        { onDelete: 'set null' },
      ),
      target_user_id: bigint('target_user_id', { mode: 'number' }).references(() => users.id, {
        onDelete: 'set null',
      }),
      organization_id: bigint('organization_id', { mode: 'number' }).references(
        () => organizations.id,
        { onDelete: 'set null' },
      ),
      action: varchar('action', { length: 100 }).notNull(),
      resource_type: varchar('resource_type', { length: 50 }).notNull(),
      resource_id: bigint('resource_id', { mode: 'number' }),
      ip_address: varchar('ip_address', { length: 45 }),
      user_agent: text('user_agent'),
      severity: varchar('severity', { length: 20 }).notNull().default('INFO'),
      metadata: jsonb('metadata').notNull().default({}),
      created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      index('idx_audit_logs_org_created').on(table.organization_id, table.created_at),
      index('idx_audit_logs_org_created_id').on(table.organization_id, table.created_at, table.id),
      index('idx_audit_logs_actor_created').on(table.actor_user_id, table.created_at),
      index('idx_audit_logs_actor_created_id').on(table.actor_user_id, table.created_at, table.id),
      index('idx_audit_logs_resource').on(table.resource_type, table.resource_id, table.created_at),
      index('idx_audit_logs_created_at').on(table.created_at),
      index('idx_audit_logs_created_id').on(table.created_at, table.id),
      index('idx_audit_logs_severity_created').on(table.severity, table.created_at),
      // sec-D3: partial index covers the FK from auth.users hard-delete; the
      // null subset is the bulk of rows so the index stays small.
      index('idx_audit_logs_target_user_id')
        .on(table.target_user_id)
        .where(sql`${table.target_user_id} IS NOT NULL`),
      // sec-D8: matching partial index for the api-key actor FK. API keys are
      // soft-deleted today so the FK cascade-scan does not fire, but "audit
      // by api-key" admin queries (and any future hard-delete path) need the
      // index to avoid a seq scan over the partitioned table. Trailing
      // `created_at` covers the "newest-first" pagination contract.
      index('idx_audit_logs_actor_api_key_id_created')
        .on(table.actor_api_key_id, table.created_at)
        .where(sql`${table.actor_api_key_id} IS NOT NULL`),
      index('idx_audit_logs_action_created').on(table.action, table.created_at),
      index('idx_audit_logs_action_created_id').on(table.action, table.created_at, table.id),
      check(
        'chk_audit_severity',
        sql`${table.severity} IN ('DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL')`,
      ),
      // sec-U3: audit.logs is append-only at the DB layer. The old `FOR ALL`
      // policy let any caller with `app.current_organization_public_id` UPDATE or
      // DELETE audit rows for their own organization. We split into FOR
      // SELECT + FOR INSERT + FOR DELETE so:
      //   - SELECT / INSERT predicates are byte-identical to the old USING
      //     (no read/write behaviour change for any context that ran today).
      //   - DELETE is narrowed to `app.global_retention_cleanup` only
      //     (admin is intentionally NOT on DELETE — it is a read escape
      //     hatch, never a delete one).
      //   - No `FOR UPDATE` policy → RLS structurally denies UPDATE; the
      //     migration also REVOKEs UPDATE from `core_be_app` so the grant
      //     layer surfaces tampering as `permission denied` before RLS runs.
      pgPolicy('audit_logs_tenant_isolation_select', {
        as: 'permissive',
        for: 'select',
        to: 'public',
        using: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )
          OR current_setting('app.global_retention_cleanup', true) = 'true'
          OR current_setting('app.global_admin', true) = 'true'`,
      }),
      pgPolicy('audit_logs_tenant_isolation_insert', {
        as: 'permissive',
        for: 'insert',
        to: 'public',
        // sec-r4-D1: removed `global_admin` and `global_retention_cleanup` escape
        // arms from the audit-INSERT WITH CHECK because neither has a
        // legitimate reason to write audit rows for an arbitrary tenant.
        //
        // sec-r5-async-queue-1: re-opened a NARROW system-audit arm gated by
        // `app.system_audit_insert='true'` AND `organization_id IS NULL`.
        // Because the arm requires `organization_id IS NULL`, a process that
        // flips this GUC cannot write to any tenant's audit log — only
        // tenantless rows. Used by `withMaintenanceDatabaseContext` for DLQ
        // replay and other system-level emitters that have no tenant.
        withCheck: sql`${table.organization_id} = (
            SELECT id FROM tenancy.organizations
            WHERE public_id = current_setting('app.current_organization_public_id', true)
          )
          OR (
            ${table.organization_id} IS NULL
            AND current_setting('app.system_audit_insert', true) = 'true'
          )`,
      }),
      pgPolicy('audit_logs_tenant_isolation_delete', {
        as: 'permissive',
        for: 'delete',
        to: 'public',
        using: sql`current_setting('app.global_retention_cleanup', true) = 'true'`,
      }),
      pgPolicy('audit_logs_user_export_select', {
        as: 'permissive',
        for: 'select',
        to: 'public',
        using: sql`${table.actor_user_id} = (
            SELECT id FROM auth.users
            WHERE public_id = current_setting('app.current_user_public_id', true)
              AND deleted_at IS NULL
          )`,
      }),
    ],
  )
  .enableRLS();

/** Drizzle-inferred insert row shape for {@link logs}. */
export type AuditLogInsert = typeof logs.$inferInsert;
