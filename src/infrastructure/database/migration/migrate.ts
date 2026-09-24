import '@/shared/config/load-env-files.js';
import postgres from 'postgres';
import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { describeMigrationConnectionError } from '@/infrastructure/database/migration/migration-error-hint.js';
import { parseMigrationExecutionMode } from '@/infrastructure/database/migration/migration-execution-mode.js';
import { isNeonPoolerConnection } from '@/infrastructure/database/utils/connection-url.util.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

/**
 * Uses DATABASE_MIGRATION_URL if available (elevated-privilege user),
 * otherwise falls back to DATABASE_URL.
 */
const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;

if (!migrationUrl) {
  throw new Error('DATABASE_URL or DATABASE_MIGRATION_URL must be set for migrations');
}

/**
 * Migrations MUST run against a direct (non-pooler) endpoint. Through a transaction-mode
 * PgBouncer/Neon pooler the session-level `pg_advisory_lock` acquired below is not pinned
 * to a single backend across statements, so the serialization that prevents two concurrent
 * deploys from double-applying a migration silently becomes a no-op. Fail fast instead of
 * running with broken mutual exclusion. Set `DATABASE_MIGRATION_URL` to the direct host
 * (no `-pooler` segment, no `pgbouncer=true`).
 */
if (isNeonPoolerConnection(migrationUrl)) {
  throw new Error(
    'Migrations must use a direct (non-pooler) DATABASE_MIGRATION_URL: the migration advisory ' +
      'lock relies on a session pinned to one Postgres backend, which a transaction-mode pooler ' +
      '(-pooler host or ?pgbouncer=true) does not provide. Point DATABASE_MIGRATION_URL at the ' +
      'direct database host. See .env.example and docs/reference/data/migrations.md.',
  );
}

/**
 * Fail fast on a malformed URL (surrounding quotes, a trailing newline, or whitespace pasted into the
 * secret) with a clear, secret-free message instead of a raw `TypeError: Invalid URL` from deep inside
 * postgres.js.
 */
try {
  new URL(migrationUrl);
} catch {
  throw new Error(
    'DATABASE_MIGRATION_URL is not a valid URL. Common causes: surrounding quotes, a trailing ' +
      'newline, or whitespace in the secret. Set it as the RAW connection string (no wrapping ' +
      'quotes), e.g. postgresql://user:password@host:5432/db?sslmode=require.',
  );
}

/**
 * `connect_timeout` (seconds): fail fast when the host is unreachable — a wrong/internal host, a
 * firewall, or an IP allowlist that silently drops packets — instead of hanging until the CI job's
 * timeout (a ~30-minute silent stall). `max: 1` keeps every statement on the one backend that holds
 * the migration advisory lock.
 */
const sql = postgres(migrationUrl, { max: 1, connect_timeout: 15 });

/**
 * Postgres 17+ is required project-wide (docker-compose, CI services,
 * testcontainers, and managed providers like Neon are all pinned to 17).
 * Refuse to apply migrations against older servers so test infra drift
 * (e.g. someone pointing DATABASE_MIGRATION_URL at a local 15/16 cluster)
 * is caught before it can produce a partially-applied schema.
 */
const MINIMUM_POSTGRES_SERVER_VERSION_NUM = 170000;
const INIT_MIGRATION_FILENAME = '00000000000000_init.sql';

/**
 * Fixed 64-bit key for the session-level advisory lock that serializes the
 * entire migration run.
 *
 * Without it, two deploy jobs or app instances starting migrations
 * concurrently can both begin applying the same file: the `schema_migrations`
 * primary key prevents a duplicate row, but non-idempotent or long-running DDL
 * can still race, producing failed deploys or partially-applied state. Each
 * runner calls `pg_advisory_lock(<this key>)` up front, so the second runner
 * blocks until the first finishes and releases. Session-level advisory locks
 * are NOT auto-released on COMMIT/ROLLBACK, so we always release explicitly in
 * a `finally`. The value is an arbitrary but stable constant (well within the
 * 53-bit safe-integer range and cast to `bigint` in SQL) — only its
 * uniqueness within this application matters.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 4_017_309_021;

const isDryRun = process.argv.includes('--dry-run');

/**
 * Acquires the migration advisory lock on the shared `sql` session. The pool
 * is created with `max: 1`, so every statement in this process runs on the
 * same Postgres backend/session that holds the lock.
 */
async function acquireMigrationAdvisoryLock(): Promise<void> {
  await sql`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY}::bigint)`;
  logger.info({ lockKey: MIGRATION_ADVISORY_LOCK_KEY }, 'Acquired migration advisory lock');
}

/**
 * Releases the migration advisory lock. Safe to call even if the lock was not
 * held (`pg_advisory_unlock` simply returns false); never throws so it can run
 * in a `finally` without masking the original error.
 */
async function releaseMigrationAdvisoryLock(): Promise<void> {
  try {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY}::bigint)`;
    logger.info({ lockKey: MIGRATION_ADVISORY_LOCK_KEY }, 'Released migration advisory lock');
  } catch (unlockError) {
    logger.error({ error: unlockError }, 'Failed to release migration advisory lock');
  }
}

async function assertPostgresMajorVersionAtLeast17(): Promise<void> {
  const [row] = await sql<
    { server_version_num: string; server_version: string }[]
  >`SELECT current_setting('server_version_num') AS server_version_num, current_setting('server_version') AS server_version`;
  const serverVersionNum = Number(row?.server_version_num ?? '0');
  if (
    !Number.isFinite(serverVersionNum) ||
    serverVersionNum < MINIMUM_POSTGRES_SERVER_VERSION_NUM
  ) {
    throw new Error(
      `Refusing to run migrations against Postgres ${row?.server_version ?? 'unknown'} (server_version_num=${row?.server_version_num ?? 'unknown'}). Postgres 17+ is required project-wide. See .cursor/skills/be-db-migration-maintainer/SKILL.md and docker-compose.yml.`,
    );
  }
}

interface BaselineExistingInitialMigrationInput {
  appliedSet: Set<string>;
  sqlFiles: string[];
}

async function baselineExistingInitialMigrationIfNeeded({
  appliedSet,
  sqlFiles,
}: BaselineExistingInitialMigrationInput): Promise<void> {
  if (appliedSet.size > 0 || !sqlFiles.includes(INIT_MIGRATION_FILENAME)) {
    return;
  }

  const [row] = await sql<
    {
      audit_logs_exists: boolean;
      auth_users_exists: boolean;
      billing_plans_exists: boolean;
      notify_notifications_exists: boolean;
      tenancy_organizations_exists: boolean;
      upload_uploads_exists: boolean;
    }[]
  >`
    SELECT
      to_regclass('audit.logs') IS NOT NULL AS audit_logs_exists,
      to_regclass('auth.users') IS NOT NULL AS auth_users_exists,
      to_regclass('billing.plans') IS NOT NULL AS billing_plans_exists,
      to_regclass('notify.notifications') IS NOT NULL AS notify_notifications_exists,
      to_regclass('tenancy.organizations') IS NOT NULL AS tenancy_organizations_exists,
      to_regclass('upload.uploads') IS NOT NULL AS upload_uploads_exists
  `;

  const hasExistingInitialSchema =
    row?.audit_logs_exists === true &&
    row.auth_users_exists === true &&
    row.billing_plans_exists === true &&
    row.notify_notifications_exists === true &&
    row.tenancy_organizations_exists === true &&
    row.upload_uploads_exists === true;

  if (!hasExistingInitialSchema) {
    return;
  }

  if (isDryRun) {
    logger.warn(
      { filename: INIT_MIGRATION_FILENAME },
      'Dry run: would baseline migration metadata for existing initialized database',
    );
    appliedSet.add(INIT_MIGRATION_FILENAME);
    return;
  }

  await sql`
    INSERT INTO public.schema_migrations (filename)
    VALUES (${INIT_MIGRATION_FILENAME})
    ON CONFLICT (filename) DO NOTHING
  `;
  appliedSet.add(INIT_MIGRATION_FILENAME);
  logger.warn(
    { filename: INIT_MIGRATION_FILENAME },
    'Baseline migration metadata for existing initialized database',
  );
}

/** Minimal shape shared by the top-level `sql` tag and a `sql.begin` transaction. */
interface MigrationStatementExecutor {
  unsafe: (query: string) => PromiseLike<unknown>;
}

interface RunMigrationStatementsInput {
  filename: string;
  statements: string[];
  executor: MigrationStatementExecutor;
}

/**
 * Executes the ordered statements of one migration against the provided
 * executor (a transaction in the default lane, the connection itself in the
 * non-transactional lane), logging the offending statement on failure.
 */
async function runMigrationStatements({
  filename,
  statements,
  executor,
}: RunMigrationStatementsInput): Promise<void> {
  let statementIndex = 0;
  for (const statement of statements) {
    statementIndex += 1;
    try {
      await executor.unsafe(statement);
    } catch (statementError) {
      logger.error(
        {
          filename,
          statementIndex,
          statementHead: statement.slice(0, 200),
          error: statementError,
        },
        'Migration statement failed',
      );
      throw statementError;
    }
  }
}

/**
 * Fails the migration when any INVALID/UNREADY index exists, which is the
 * signature of a `CREATE INDEX CONCURRENTLY` that aborted mid-build. Only used
 * by the non-transactional lane (the sole place concurrent indexes are built).
 */
async function assertNoInvalidIndexes({ filename }: { filename: string }): Promise<void> {
  const invalidIndexes = await sql<{ schema_name: string; index_name: string }[]>`
    SELECT n.nspname AS schema_name, c.relname AS index_name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE (NOT i.indisvalid OR NOT i.indisready)
      AND n.nspname NOT IN ('pg_catalog', 'pg_toast', 'information_schema')
    ORDER BY n.nspname, c.relname
  `;

  if (invalidIndexes.length === 0) return;

  const indexNames = invalidIndexes.map((row) => `${row.schema_name}.${row.index_name}`).join(', ');
  throw new Error(
    `Non-transactional migration ${filename} left INVALID/UNREADY index(es): ${indexNames}. ` +
      'A CREATE INDEX CONCURRENTLY likely failed mid-build. Drop the invalid index ' +
      '(DROP INDEX CONCURRENTLY IF EXISTS <schema>.<name>) and re-run pnpm db:migrate.',
  );
}

async function main() {
  const migrationsFolder = resolve(process.cwd(), 'migrations');
  logger.info({ migrationsFolder, dryRun: isDryRun }, 'Running migrations');

  await assertPostgresMajorVersionAtLeast17();

  /**
   * Serialize the whole run behind a session-level advisory lock so concurrent
   * deploy jobs/instances cannot apply the same migration at the same time.
   * The lock wraps BOTH the transactional and non-transactional
   * (`CREATE INDEX CONCURRENTLY`) lanes and is released even on error.
   */
  await acquireMigrationAdvisoryLock();
  try {
    await sql`
      create table if not exists public.schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `;

    const applied = await sql<{ filename: string }[]>`
      select filename from public.schema_migrations order by filename asc
    `;
    const appliedSet = new Set(applied.map((row) => row.filename));

    const allFiles = await readdir(migrationsFolder);
    const sqlFiles = allFiles
      .filter((file) => file.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    await baselineExistingInitialMigrationIfNeeded({ appliedSet, sqlFiles });

    for (const filename of sqlFiles) {
      if (appliedSet.has(filename)) continue;

      const fullPath = resolve(migrationsFolder, filename);
      const contents = await readFile(fullPath, 'utf8');

      const { transactional, headerErrors } = parseMigrationExecutionMode(contents);
      if (headerErrors.length > 0) {
        throw new Error(
          `Invalid migration-transaction header in ${filename}: ${headerErrors.join('; ')}`,
        );
      }

      logger.info({ filename, transactional, dryRun: isDryRun }, 'Applying migration');
      /**
       * Drizzle-style splitter: SQL files use `--> statement-breakpoint` between
       * statements so that each statement is sent independently. This prevents
       * issues with the postgres simple-query protocol mis-reporting errors when
       * a single batch contains many statements with DO blocks, dollar-quoting,
       * and DDL that depend on prior statements in the same batch.
       */
      const statements = contents
        .split(/\n--> statement-breakpoint\s*\n?/g)
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);

      if (transactional) {
        await sql.begin(async (transaction) => {
          await runMigrationStatements({ filename, statements, executor: transaction });
          if (!isDryRun) {
            await transaction.unsafe(
              'insert into public.schema_migrations (filename) values ($1)',
              [filename],
            );
          }
        });
        continue;
      }

      /**
       * Non-transactional lane: each statement runs in its own implicit
       * transaction (autocommit) so `CREATE INDEX CONCURRENTLY` is legal. Because
       * there is no enclosing transaction to roll back, statements must be
       * idempotent (`IF NOT EXISTS`). A concurrent index build that fails leaves
       * an INVALID index behind, so we check for that before recording success —
       * an operator must `DROP INDEX CONCURRENTLY` the invalid index and re-run.
       */
      await runMigrationStatements({ filename, statements, executor: sql });
      await assertNoInvalidIndexes({ filename });
      if (!isDryRun) {
        await sql.unsafe('insert into public.schema_migrations (filename) values ($1)', [filename]);
      }
    }

    logger.info({ dryRun: isDryRun }, 'Migrations complete');
  } finally {
    await releaseMigrationAdvisoryLock();
  }
}

main()
  .then(async () => {
    await sql.end({ timeout: 5_000 });
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error({ error }, 'Migrations failed');
    const hint = describeMigrationConnectionError(error);
    if (hint) {
      logger.error({ hint }, 'Migration connection hint');
    }
    try {
      await sql.end({ timeout: 5_000 });
    } catch {
      // ignore
    }
    process.exit(1);
  });
