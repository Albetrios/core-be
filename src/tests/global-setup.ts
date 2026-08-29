/**
 * Runs once before all test files.
 * Ensures the test database has all migrations applied so tests (e.g. auth verification_tokens) do not fail.
 * Requires Postgres (e.g. docker compose up -d) and DATABASE_URL in .env.
 */
import '@/shared/config/load-env-files.js';
import { execSync } from 'node:child_process';
import postgres from 'postgres';
import { LOCAL_DATABASE_NAME } from '@/shared/constants/project-identity.constants.js';

const LOCAL_TEST_DATABASE_URL = `postgresql://${LOCAL_DATABASE_NAME}:${LOCAL_DATABASE_NAME}@localhost:5432/${LOCAL_DATABASE_NAME}`;

function isLocalDatabaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const { hostname } = new URL(value);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function forceLocalDatabaseForNonCiTestRun(): void {
  if (process.env.CI === 'true' || process.env.ALLOW_HOSTED_TEST_DATABASE === 'true') return;

  // Local↔live parity (must mirror src/tests/setup.ts): the local env file's
  // DATABASE_URL is the RLS-subject `core_be_app` login — the harness's DDL shims
  // and cross-tenant fixtures run as `core_be_operator` (owner-member, BYPASSRLS)
  // via DATABASE_OPERATOR_URL whenever it is provisioned.
  const operatorUrl = process.env.DATABASE_OPERATOR_URL;
  if (operatorUrl && isLocalDatabaseUrl(operatorUrl)) {
    process.env.DATABASE_URL = operatorUrl;
    process.env.DATABASE_MIGRATION_URL ??= LOCAL_TEST_DATABASE_URL;
    return;
  }

  if (isLocalDatabaseUrl(process.env.DATABASE_URL)) return;

  process.env.DATABASE_URL = LOCAL_TEST_DATABASE_URL;
  process.env.DATABASE_MIGRATION_URL = LOCAL_TEST_DATABASE_URL;
}

/**
 * Vitest global setup: applies migrations against the test database and
 * ensures a small set of fallback tables exist for older fixtures. Skipped
 * when contract / property / unit-only test slices set their respective
 * `*_TESTS_ONLY` / `VITEST_SKIP_DATABASE` env vars.
 */
export default async function globalSetup(): Promise<void> {
  process.env.NODE_ENV ??= 'development';
  forceLocalDatabaseForNonCiTestRun();

  /** Contract tests mock outbound HTTP — skip Postgres churn (offline CI slice). See `pnpm test:contract`. */
  if (process.env.CONTRACT_TESTS_ENABLED === 'true') {
    return;
  }

  /** fast-check property slice — pure validators, no DB. See `pnpm test:property`. */
  if (process.env.PROPERTY_TESTS_ENABLED === 'true') {
    return;
  }

  /** PR unit lane — unit + global policy scans without Postgres. See reusable-vitest-unit-only.yml. */
  if (process.env.VITEST_SKIP_DATABASE === 'true') {
    return;
  }

  process.env.DATABASE_URL ??= LOCAL_TEST_DATABASE_URL;
  const migrationUrl = process.env.DATABASE_URL;
  if (!migrationUrl) {
    throw new Error('DATABASE_URL must be set for test global setup');
  }
  const sql = postgres(migrationUrl, { max: 1 });

  try {
    await sql`SELECT 1`;
  } catch (connectionError) {
    if (process.env.CI === 'true') {
      throw connectionError;
    }
    console.warn(
      'Test database unavailable — skipping global setup. Start Docker: docker compose up -d',
    );
    await sql.end({ timeout: 5_000 }).catch(() => {});
    return;
  }

  try {
    try {
      execSync('pnpm db:migrate', {
        stdio: 'pipe',
        encoding: 'utf-8',
        env: process.env,
        cwd: process.cwd(),
      });
    } catch (migrateError) {
      if (process.env.CI === 'true') {
        throw migrateError;
      }
      console.warn(
        'pnpm db:migrate failed during test global setup — continuing with legacy bootstrap',
      );
    }

    // Ensure auth.verification_tokens exists (required by auth tests)
    const hasTable = await sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'auth' AND table_name = 'verification_tokens'
    `;
    const hasMailOutbox = await sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'auth' AND table_name = 'mail_outbox'
    `;
    if (hasMailOutbox.length === 0) {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS auth.mail_outbox (
          id BIGSERIAL PRIMARY KEY,
          to_addresses JSONB NOT NULL,
          subject VARCHAR(500) NOT NULL,
          html TEXT NOT NULL,
          text_body TEXT,
          reply_to VARCHAR(320),
          tags JSONB,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          resend_message_id VARCHAR(255),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          sent_at TIMESTAMPTZ,
          CONSTRAINT mail_outbox_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed'))
        );
      `);
      await sql.unsafe(
        'CREATE INDEX IF NOT EXISTS idx_mail_outbox_status_created_at ON auth.mail_outbox (status, created_at);',
      );
    } else {
      /** Older fixtures may have created the table without updated_at or with a narrower status check. */
      await sql.unsafe(
        'ALTER TABLE auth.mail_outbox ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();',
      );
      await sql.unsafe(
        'ALTER TABLE auth.mail_outbox DROP CONSTRAINT IF EXISTS mail_outbox_status_check;',
      );
      await sql.unsafe(
        "ALTER TABLE auth.mail_outbox ADD CONSTRAINT mail_outbox_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed'));",
      );
    }

    const hasUserDataExports = await sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'auth' AND table_name = 'user_data_exports'
    `;
    if (hasUserDataExports.length === 0) {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS auth.user_data_exports (
          id BIGSERIAL PRIMARY KEY,
          public_id VARCHAR(21) NOT NULL,
          user_id BIGINT NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          s3_key VARCHAR(512),
          expires_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          failed_at TIMESTAMPTZ,
          error_code VARCHAR(64),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT user_data_exports_public_id_unique UNIQUE (public_id),
          CONSTRAINT user_data_exports_status_check CHECK (
            status IN ('pending', 'processing', 'completed', 'failed')
          )
        );
      `);
      await sql.unsafe(
        'CREATE INDEX IF NOT EXISTS idx_user_data_exports_user_id ON auth.user_data_exports (user_id);',
      );
    }

    const hasUploadUploads = await sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'upload' AND table_name = 'uploads'
    `;
    if (hasUploadUploads.length === 0) {
      await sql.unsafe('CREATE SCHEMA IF NOT EXISTS upload;');
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS upload.uploads (
          id bigserial primary key,
          public_id varchar(21) not null,
          user_id bigint not null references auth.users (id),
          organization_id bigint references tenancy.organizations (id),
          file_name varchar(255) not null,
          file_key varchar(512) not null,
          mime_type varchar(100) not null,
          file_size integer not null,
          storage_provider varchar(20) not null default 's3',
          bucket varchar(100) not null,
          status varchar(20) not null default 'PENDING',
          metadata jsonb not null default '{}'::jsonb,
          uploaded_at timestamptz,
          deleted_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          created_by_user_id bigint references auth.users (id),
          constraint chk_uploads_file_size check (file_size >= 0),
          constraint chk_uploads_status check (status in ('PENDING', 'UPLOADED', 'FAILED'))
        );
      `);
      await sql.unsafe(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_uploads_public_id ON upload.uploads (public_id);',
      );
      await sql.unsafe(
        'CREATE INDEX IF NOT EXISTS idx_uploads_user_id ON upload.uploads (user_id);',
      );
      await sql.unsafe(
        'CREATE INDEX IF NOT EXISTS idx_uploads_organization_id ON upload.uploads (organization_id) WHERE organization_id IS NOT NULL;',
      );
    }

    if (hasTable.length === 0) {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS auth.verification_tokens (
          id            BIGSERIAL PRIMARY KEY,
          token_type    VARCHAR(30)   NOT NULL,
          token_hash    VARCHAR(64)   NOT NULL UNIQUE,
          user_id       BIGINT        NOT NULL REFERENCES auth.users(id),
          email         VARCHAR(255)  NOT NULL,
          expires_at    TIMESTAMPTZ   NOT NULL,
          used_at       TIMESTAMPTZ,
          created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
        );
      `);
      await sql.unsafe(
        'CREATE INDEX IF NOT EXISTS idx_verification_tokens_token_hash ON auth.verification_tokens(token_hash);',
      );
      await sql.unsafe(
        'CREATE INDEX IF NOT EXISTS idx_verification_tokens_user_type ON auth.verification_tokens(user_id, token_type);',
      );
      await sql
        .unsafe('ALTER TABLE auth.verification_tokens ENABLE ROW LEVEL SECURITY')
        .catch(() => {});
    }
  } finally {
    await sql.end({ timeout: 5_000 });
  }
}
