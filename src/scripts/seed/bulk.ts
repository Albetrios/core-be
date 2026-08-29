/**
 * Bulk seed orchestrator — the shared entry point that resolves a profile/scale config and
 * runs every domain's {@link DomainSeedModule} in dependency order (all `seedReference`,
 * then all `seedBulk`). Behind a production guard; reproducible via `SEED`.
 *
 * Usage: `pnpm db:seed:bulk` · `BULK_PROFILE=load SCALE=5 pnpm db:seed:bulk`
 */
import '@/shared/config/load-env-files.js';
import '@/scripts/seed/seed-runtime-url.js';
import { fileURLToPath } from 'node:url';
import { faker } from '@faker-js/faker';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { resolveCounts } from './bulk-config.js';
import { initFakerSeed } from './faker-data.js';
import { closeDatabase } from './helpers.js';
import { SEED_MODULES } from './modules.js';
import { assertBulkSeedAllowed } from './production-guard.js';
import { createSeedRegistry } from './seed-registry.js';
import { orderModules, type SeedContext } from './seed-contract.js';

/**
 * Runs the full bulk seed: guard, resolve config, seed reference data then bulk rows in
 * dependency order.
 *
 * @remarks
 * Failure modes: throws via {@link assertBulkSeedAllowed} on a hosted DB, or propagates any
 * domain seeder error. Side effects: writes rows across every registered domain.
 */
export async function runBulkSeed(environment: NodeJS.ProcessEnv): Promise<void> {
  assertBulkSeedAllowed(environment);
  const { profile, scale, counts } = resolveCounts(environment);

  initFakerSeed();
  const context: SeedContext = { counts, faker, registry: createSeedRegistry(), logger };
  logger.info({ profile, scale, counts }, 'seed.bulk: starting');

  const ordered = orderModules(SEED_MODULES);
  for (const module of ordered) {
    if (module.seedReference) await module.seedReference(context);
  }
  for (const module of ordered) {
    logger.info({ module: module.name }, 'seed.bulk: seeding domain');
    await module.seedBulk(context);
  }

  logger.info(
    {
      organizations: context.registry.organizations.length,
      users: context.registry.users.length,
    },
    'seed.bulk: done',
  );
}

/**
 * Auto-run only when executed directly (`tsx src/scripts/seed/bulk.ts`), never on import — so a
 * test can import {@link runBulkSeed} without triggering a seed. `closeDatabase` always runs so the
 * postgres.js pool drains before the process exits.
 */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runBulkSeed(process.env)
    .catch((error) => {
      logger.error({ error }, 'seed.bulk: failed');
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDatabase();
    });
}
