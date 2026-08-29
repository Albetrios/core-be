/**
 * Sync demo organization admin role with current SYSTEM_PERMISSIONS (idempotent).
 * Use after permission seed changes or when routes return 403 for demo user.
 *
 * Usage: pnpm db:seed:sync-demo
 */
import '@/shared/config/load-env-files.js';
import { and, desc, eq } from 'drizzle-orm';
import { closeDatabase } from './helpers.js';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { users } from '@/domains/user/user.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import {
  seedPermissions,
  SYSTEM_PERMISSIONS,
} from '@/domains/tenancy/sub-domains/permission/seed/permission.reference.seed.js';
import { seedRolePermissions } from '@/domains/tenancy/seed/tenancy.seed.js';
import { invalidateOrganizationPermissions } from '@/domains/tenancy/sub-domains/permission/permission-cache.service.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

const DEMO_EMAIL = 'demo@example.com';
const DEMO_ORGANIZATION_SLUG = 'demo-org';
const ADMIN_ROLE_NAME = 'Admin';

async function main(): Promise<void> {
  logger.info('seed.sync-demo: starting');

  await seedPermissions();
  logger.info({ count: SYSTEM_PERMISSIONS.length }, 'seed.sync-demo: permissions upserted');

  const [demoUser] = await getRequestDatabase()
    .select()
    .from(users)
    .where(eq(users.email, DEMO_EMAIL))
    .limit(1);

  if (!demoUser) {
    throw new Error('Demo user not found — run pnpm db:seed:full first');
  }

  const [demoOrganization] = await getRequestDatabase()
    .select()
    .from(organizations)
    .where(eq(organizations.slug, DEMO_ORGANIZATION_SLUG))
    .orderBy(desc(organizations.created_at))
    .limit(1);

  if (!demoOrganization) {
    throw new Error('Demo organization not found — run pnpm db:seed:full first');
  }

  const [adminRole] = await getRequestDatabase()
    .select()
    .from(roles)
    .where(and(eq(roles.organization_id, demoOrganization.id), eq(roles.name, ADMIN_ROLE_NAME)))
    .orderBy(desc(roles.created_at))
    .limit(1);

  if (!adminRole) {
    throw new Error('Admin role not found on demo organization');
  }

  const permissionCodes = SYSTEM_PERMISSIONS.map((permission) => permission.code);
  await seedRolePermissions(adminRole.id, permissionCodes, demoUser.id);
  await invalidateOrganizationPermissions(demoOrganization.public_id);

  logger.info(
    {
      userPublicId: demoUser.public_id,
      organizationPublicId: demoOrganization.public_id,
      permissionCount: permissionCodes.length,
    },
    'seed.sync-demo: admin role permissions synced and cache cleared',
  );
}

/**
 * `closeDatabase` always runs (success or failure). Without it, a thrown error here
 * would `process.exit(1)` before the postgres.js pool finishes draining and leave
 * aborted connections behind in Postgres.
 */
main()
  .catch((error) => {
    logger.error({ error }, 'seed.sync-demo: failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
