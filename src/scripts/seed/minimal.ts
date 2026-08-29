/**
 * Minimal seed — creates the bare minimum data needed for the app to start:
 * - System permissions (tenancy)
 * - Default plans (billing)
 *
 * Usage: pnpm db:seed
 */
import '@/shared/config/load-env-files.js';
import '@/scripts/seed/seed-runtime-url.js';
import { closeDatabase } from './helpers.js';
import { seedPermissions } from '@/domains/tenancy/sub-domains/permission/seed/permission.reference.seed.js';
import { seedPlans } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

async function main() {
  logger.info('seed.minimal: starting');

  await seedPermissions();
  logger.info('seed.minimal: permissions seeded');

  await seedPlans();
  logger.info('seed.minimal: plans seeded');

  logger.info('seed.minimal: done');
}

/**
 * `closeDatabase` always runs (success or failure). Without it, a thrown error here
 * would `process.exit(1)` before the postgres.js pool finishes draining and leave
 * aborted connections behind in Postgres.
 */
main()
  .catch((error) => {
    logger.error({ error }, 'seed.minimal: failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
