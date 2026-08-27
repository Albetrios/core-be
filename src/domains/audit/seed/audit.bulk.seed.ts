/**
 * Audit bulk seeder — for every organization in the registry, creates `auditPerOrgPerMonth`
 * rows for each of the last `auditMonths` months, with `created_at` spread across the month and
 * varied action / resource_type / severity. The acting user is the organization owner.
 *
 * Partitioning: `audit.logs` is RANGE-partitioned by `created_at` on hosted databases but a
 * plain table locally. Before inserting a month's rows the seeder detects whether the table is
 * partitioned (via `pg_class.relkind = 'p'`) and, only when it is, idempotently creates that
 * month's partition (`CREATE TABLE IF NOT EXISTS audit.logs_YYYY_MM PARTITION OF ...`). On a
 * plain table partition creation is skipped and rows are inserted directly.
 *
 * Idempotency: every bulk row carries a deterministic `metadata.seedBatch = 'YYYY-MM'` marker.
 * The seeder counts existing marker rows per org + month and only inserts the missing remainder,
 * so a re-run with the same counts is a no-op. Rows are inserted in chunks of {@link INSERT_BATCH_SIZE}.
 */
import { and, count, eq, sql } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { logs, type AuditLogInsert } from '@/domains/audit/audit.schema.js';
import type { SeedContext, SeededOrg } from '@/scripts/seed/seed-contract.js';
import { generateBulkAudit } from './audit.faker.js';

/** Number of audit rows inserted per batch (bounded so large months stay within statement limits). */
const INSERT_BATCH_SIZE = 500;
/** Metadata key carrying the per-month idempotency marker (`'YYYY-MM'`). */
const SEED_BATCH_KEY = 'seedBatch';

/** A month window: the first instant of the month and of the following month (both UTC). */
interface MonthWindow {
  /** `'YYYY-MM'` marker key for idempotency + partition naming. */
  key: string;
  /** First instant of the month (UTC). */
  start: Date;
  /** First instant of the next month (UTC) — exclusive upper bound. */
  next: Date;
}

/** Builds the window for the month that is `monthsAgo` months before the current month (UTC). */
function buildMonthWindow(monthsAgo: number): MonthWindow {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const key = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return { key, start, next };
}

/** Formats a Date as a `YYYY-MM-DD` literal for partition-bound DDL. */
function toDateLiteral(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Returns whether `audit.logs` is a partitioned table (`relkind = 'p'`). When true the seeder
 * must create a monthly partition before inserting; when false it inserts into the plain table.
 */
async function isAuditLogsPartitioned(): Promise<boolean> {
  const result = await getRequestDatabase().execute<{ is_partitioned: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'audit' AND c.relname = 'logs' AND c.relkind = 'p'
    ) AS is_partitioned
  `);
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: { is_partitioned: boolean }[] }).rows ?? []);
  return rows[0]?.is_partitioned === true;
}

/**
 * Idempotently creates the monthly RANGE partition for `audit.logs` covering `monthWindow`.
 *
 * @remarks
 * Boundaries are derived from controlled integer date math and embedded as `YYYY-MM-DD` literals
 * (Postgres requires literal partition bounds), so there is no injection surface. Uses
 * `IF NOT EXISTS` so concurrent/repeat runs are safe.
 */
async function ensureMonthlyPartition(monthWindow: MonthWindow): Promise<void> {
  const partitionName = `logs_${monthWindow.key.replace('-', '_')}`;
  const fromLiteral = toDateLiteral(monthWindow.start);
  const toLiteral = toDateLiteral(monthWindow.next);
  await getRequestDatabase().execute(sql`
    CREATE TABLE IF NOT EXISTS ${sql.raw(`audit.${partitionName}`)}
    PARTITION OF audit.logs
    FOR VALUES FROM (${fromLiteral}) TO (${toLiteral})
  `);
}

/** Counts existing bulk-seeded audit rows for an org + month (matched by the `seedBatch` marker). */
async function countSeededRows(organizationId: number, monthKey: string): Promise<number> {
  const rows = await getRequestDatabase()
    .select({ value: count() })
    .from(logs)
    .where(
      and(
        eq(logs.organization_id, organizationId),
        sql`${logs.metadata}->>${SEED_BATCH_KEY} = ${monthKey}`,
      ),
    );
  return rows[0]?.value ?? 0;
}

/** Inserts `values` into `audit.logs` in chunks of {@link INSERT_BATCH_SIZE}. */
async function insertInBatches(values: AuditLogInsert[]): Promise<void> {
  const database = getRequestDatabase();
  for (let offset = 0; offset < values.length; offset += INSERT_BATCH_SIZE) {
    const chunk = values.slice(offset, offset + INSERT_BATCH_SIZE);
    await database.insert(logs).values(chunk);
  }
}

/**
 * Seeds audit rows for every organization across the last `auditMonths` months.
 *
 * @remarks
 * Algorithm: detect partitioning once; for each month window ensure the partition exists (only
 * when partitioned), then for each org count existing marker rows and build only the missing
 * remainder with month-spread timestamps, inserting in batches. Side effects: optional partition
 * DDL + inserts into `audit.logs`. Failure modes: warns and returns early if the organization
 * registry is empty; otherwise propagates DB errors.
 */
export async function seedAuditLogsBulk(context: SeedContext): Promise<void> {
  const { auditMonths, auditPerOrgPerMonth } = context.counts;
  const organizations = context.registry.organizations;
  if (organizations.length === 0) {
    context.logger.warn(
      'seed.bulk.audit: empty organization registry; run the tenancy seeder first',
    );
    return;
  }

  const partitioned = await isAuditLogsPartitioned();
  let inserted = 0;

  for (let monthsAgo = 0; monthsAgo < auditMonths; monthsAgo += 1) {
    const monthWindow = buildMonthWindow(monthsAgo);
    if (partitioned) {
      await ensureMonthlyPartition(monthWindow);
    }

    for (const organization of organizations) {
      inserted += await seedOrganizationMonth({
        context,
        organization,
        monthWindow,
        target: auditPerOrgPerMonth,
      });
    }
  }

  context.logger.info(
    { organizations: organizations.length, months: auditMonths, partitioned, inserted },
    'seed.bulk.audit: audit logs seeded',
  );
}

/** Seeds the missing audit rows for one org in one month window; returns how many were inserted. */
async function seedOrganizationMonth(options: {
  context: SeedContext;
  organization: SeededOrg;
  monthWindow: MonthWindow;
  target: number;
}): Promise<number> {
  const { context, organization, monthWindow, target } = options;
  const existing = await countSeededRows(organization.id, monthWindow.key);
  const missing = target - existing;
  if (missing <= 0) return 0;

  const values: AuditLogInsert[] = [];
  for (let index = 0; index < missing; index += 1) {
    const profile = generateBulkAudit(context.faker, monthWindow.start, monthWindow.next);
    values.push({
      organization_id: organization.id,
      actor_user_id: organization.ownerUserId,
      action: profile.action,
      resource_type: profile.resource_type,
      severity: profile.severity,
      created_at: profile.created_at,
      metadata: { [SEED_BATCH_KEY]: monthWindow.key },
    });
  }

  await insertInBatches(values);
  return values.length;
}
