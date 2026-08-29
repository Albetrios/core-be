/**
 * Provisions the account-level PERSONAL organization for every existing active user that
 * lacks one. Run this once when turning PERSONAL_ORGANIZATION_ENABLED on for a deployment
 * that already has users (new signups self-provision; this catches the pre-existing rows).
 *
 * Idempotent: the `idx_org_one_personal_per_owner` partial unique index guarantees at most
 * one personal organization per owner, so re-running is safe (already-provisioned users are
 * skipped by the NOT EXISTS filter and any race is caught by the unique index).
 *
 * Usage:
 *   DATABASE_URL=postgresql://... pnpm tool:backfill-personal-organizations
 */
import 'dotenv/config';
import { sql, closeDatabase } from '@/infrastructure/database/connection.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { provisionPersonalOrganization } from '@/domains/tenancy/sub-domains/organization/organization-provisioning.js';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is required');
    process.exit(1);
  }

  // Active (not soft-deleted) users with no PERSONAL organization yet.
  const rows = await sql<{ id: number; public_id: string }[]>`
    SELECT u.id, u.public_id
    FROM auth.users u
    WHERE u.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM tenancy.organizations o
        WHERE o.owner_user_id = u.id AND o.type = 'PERSONAL'
      )
    ORDER BY u.id
  `;

  logger.info({ pending: rows.length }, 'backfill.personal_orgs.start');

  let provisioned = 0;
  let failed = 0;
  for (const user of rows) {
    try {
      await provisionPersonalOrganization(user.id);
      provisioned += 1;
    } catch (error) {
      failed += 1;
      logger.error({ err: error, userId: user.public_id }, 'backfill.personal_orgs.user_failed');
    }
  }

  logger.info({ provisioned, failed, total: rows.length }, 'backfill.personal_orgs.done');
  await closeDatabase();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  logger.error({ error }, 'backfill.personal_orgs.failed');
  process.exit(1);
});
