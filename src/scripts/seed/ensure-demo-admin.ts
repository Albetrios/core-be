/**
 * Ensure the dashboards demo super_admin exists — the user the local dashboards auth proxy
 * (`tooling/dev/dashboards/proxy.mjs`) logs in as to mint the Bull Board super_admin JWT.
 *
 * Without this user, `GET /admin/queues` 401s and the control-room Queues tile shows
 * "Queue data unavailable" (a 502 through the proxy). `pnpm dashboards:up` runs this after
 * `db:migrate` so a fresh DB — or one left with only faker users by `db:seed:bulk` — still
 * lets Bull Board authenticate.
 *
 * Credentials come from `DEMO_EMAIL` / `DEMO_PASSWORD` — the SAME env vars and defaults the
 * proxy reads (`demo@example.com` / `DemoPassword123!`) — so the seeded password always
 * matches what the proxy submits. Keep the defaults here in sync with `proxy.mjs`. The email
 * must also be in `GLOBAL_ADMIN_EMAILS` for the minted token to be super_admin.
 *
 * Idempotent and safe to re-run: every seed primitive upserts, and `seedDemoUser` resets the
 * password on conflict, so this repairs a demo user that was seeded with a stale/random one.
 * Creates the demo org + Admin role + membership too, because login resolves an active
 * organization for the token (a bare user row cannot sign in). Mirrors the demo-admin core of
 * `full.ts`; `db:seed:sync-demo` assumes exactly the rows this script guarantees.
 *
 * Usage: pnpm db:seed:demo-admin   (or DEMO_EMAIL=… DEMO_PASSWORD=… pnpm db:seed:demo-admin)
 */
import '@/shared/config/load-env-files.js';
import '@/scripts/seed/seed-runtime-url.js';
import { closeDatabase } from './helpers.js';
import {
  seedPermissions,
  SYSTEM_PERMISSIONS,
} from '@/domains/tenancy/sub-domains/permission/seed/permission.reference.seed.js';
import { seedDemoUser } from '@/domains/user/seed/user.seed.js';
import {
  seedOrganization,
  seedRole,
  seedRolePermissions,
  seedMembership,
} from '@/domains/tenancy/seed/tenancy.seed.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@example.com';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DemoPassword123!';

/**
 * Create-or-repair the demo super_admin plus the demo organization, Admin role, system
 * permissions, and an active membership so the user can complete a password login. All calls
 * are idempotent upserts; running twice changes nothing beyond resetting the demo password.
 */
export async function ensureDemoAdmin(): Promise<void> {
  await seedPermissions();

  const demoUser = await seedDemoUser(DEMO_EMAIL, DEMO_PASSWORD);
  if (!demoUser) throw new Error('ensure-demo-admin: failed to upsert demo user');

  const demoOrganization = await seedOrganization({
    name: 'Demo Organization',
    slug: 'demo-org',
    owner_user_id: demoUser.id,
  });
  if (!demoOrganization) throw new Error('ensure-demo-admin: failed to upsert demo organization');

  const adminRole = await seedRole({
    organization_id: demoOrganization.id,
    name: 'Admin',
    is_system: true,
    created_by_user_id: demoUser.id,
  });
  if (!adminRole) throw new Error('ensure-demo-admin: failed to upsert admin role');

  await seedRolePermissions(
    adminRole.id,
    SYSTEM_PERMISSIONS.map((permission) => permission.code),
    demoUser.id,
  );

  await seedMembership({
    user_id: demoUser.id,
    organization_id: demoOrganization.id,
    role_id: adminRole.id,
    status: 'ACTIVE',
    created_by_user_id: demoUser.id,
  });

  logger.info(
    { email: DEMO_EMAIL, user_public_id: demoUser.public_id },
    'ensure-demo-admin: demo super_admin ready',
  );
}

/**
 * `closeDatabase` always runs (success or failure). Without it, a thrown error here
 * would `process.exit(1)` before the postgres.js pool finishes draining and leave
 * aborted connections behind in Postgres.
 */
ensureDemoAdmin()
  .catch((error) => {
    logger.error({ error }, 'ensure-demo-admin: failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
