/**
 * Full seed — runs minimal seed + demo data + common flows (add user to organization, invite).
 * Orchestration only; entity logic lives in domain seeds.
 *
 * Usage: pnpm db:seed:full
 */
import '@/shared/config/load-env-files.js';
import '@/scripts/seed/seed-runtime-url.js';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { closeDatabase } from './helpers.js';
import {
  seedPermissions,
  SYSTEM_PERMISSIONS,
} from '@/domains/tenancy/sub-domains/permission/seed/permission.reference.seed.js';
import { seedPlans } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { seedDemoUser, seedUser } from '@/domains/user/seed/user.seed.js';
import {
  seedOrganization,
  seedRole,
  seedMembership,
  seedRolePermissions,
  seedMemberInvitation,
} from '@/domains/tenancy/seed/tenancy.seed.js';
import {
  initFakerSeed,
  generateUserPayload,
  generateOrganizationPayload,
  generateInviteeEmail,
} from './faker-data.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';

const DEMO_EMAIL = 'demo@example.com';

function getDemoPassword(): string {
  const fromEnv = process.env.DEMO_PASSWORD;
  if (fromEnv && fromEnv.length >= 8) return fromEnv;
  const random = randomBytes(16).toString('base64url');
  const generated = `Demo${random}!`;
  logger.info(
    'seed.full: using generated demo password — set DEMO_PASSWORD in .env for a fixed password',
  );
  return generated;
}
const ADMIN_PERMISSION_CODES = SYSTEM_PERMISSIONS.map((permission) => permission.code);

/**
 * Orchestrator for the full demo seed: applies the minimal seed (permissions,
 * plans, demo user) and then layers on faker-generated organizations,
 * memberships, invitations, and role wiring. Idempotent — re-running upserts
 * existing rows. Does not manage the DB connection; the CLI entrypoint below
 * drains the pool after it resolves, so a test may call it directly.
 */
export async function runFullSeed(): Promise<void> {
  logger.info('seed.full: starting');
  initFakerSeed();

  await seedPermissions();
  logger.info({ count: SYSTEM_PERMISSIONS.length }, 'seed.full: permissions seeded');

  await seedPlans();
  logger.info('seed.full: plans seeded');

  const demoPassword = getDemoPassword();
  const demoUser = await seedDemoUser(DEMO_EMAIL, demoPassword);
  if (!demoUser) throw new Error('seed.full: failed to create demo user');
  logger.info({ userId: demoUser.public_id }, 'seed.full: demo user created');

  const demoOrganization = await seedOrganization({
    name: 'Demo Organization',
    slug: 'demo-org',
    owner_user_id: demoUser.id,
  });
  if (!demoOrganization) throw new Error('seed.full: failed to create demo org');
  logger.info(
    { organizationId: demoOrganization.public_id },
    'seed.full: demo organization created',
  );

  const adminRole = await seedRole({
    organization_id: demoOrganization.id,
    name: 'Admin',
    is_system: true,
    created_by_user_id: demoUser.id,
  });
  if (!adminRole) throw new Error('seed.full: failed to create admin role');

  await seedRolePermissions(adminRole.id, ADMIN_PERMISSION_CODES, demoUser.id);
  logger.info('seed.full: admin role permissions assigned');

  await seedMembership({
    user_id: demoUser.id,
    organization_id: demoOrganization.id,
    role_id: adminRole.id,
    status: 'ACTIVE',
    created_by_user_id: demoUser.id,
  });
  logger.info('seed.full: demo membership created');

  const extraUserPayload = generateUserPayload();
  const extraUser = await seedUser(extraUserPayload);
  if (extraUser) {
    const extraOrgPayload = generateOrganizationPayload();
    const extraOrg = await seedOrganization({
      ...extraOrgPayload,
      owner_user_id: demoUser.id,
    });
    if (extraOrg) {
      const memberRole = await seedRole({
        organization_id: extraOrg.id,
        name: 'Member',
        is_system: false,
        created_by_user_id: demoUser.id,
      });
      if (memberRole) {
        await seedMembership({
          user_id: extraUser.id,
          organization_id: extraOrg.id,
          role_id: memberRole.id,
          status: 'ACTIVE',
          created_by_user_id: demoUser.id,
        });
        logger.info('seed.full: extra user added to extra organization (common flow)');
      }
    }
  }

  const inviteeEmail = generateInviteeEmail();
  const inviteeUser = await seedUser({
    email: inviteeEmail,
    first_name: 'Invitee',
    last_name: 'User',
  });
  if (inviteeUser) {
    const invitedMembership = await seedMembership({
      user_id: inviteeUser.id,
      organization_id: demoOrganization.id,
      role_id: adminRole.id,
      status: 'INVITED',
      created_by_user_id: demoUser.id,
    });
    if (invitedMembership) {
      const tokenHash = createHash('sha256')
        .update(`invite-${inviteeEmail}-${Date.now()}`)
        .digest('hex');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      await seedMemberInvitation({
        membership_id: invitedMembership.id,
        email: inviteeEmail,
        token_hash: tokenHash,
        invited_by_user_id: demoUser.id,
        expires_at: expiresAt,
        created_by_user_id: demoUser.id,
      });
      logger.info({ email: inviteeEmail }, 'seed.full: invite created (common flow)');
    }
  }

  logger.info('seed.full: done');
}

/**
 * Auto-run only when executed directly (`tsx src/scripts/seed/full.ts`), never on import — so a
 * test can import {@link runFullSeed} without triggering a seed or tearing down the shared pool.
 * `closeDatabase` always runs (success or failure) so the postgres.js pool drains before exit;
 * without it a thrown error would `process.exit(1)` and leave aborted connections behind in Postgres.
 */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runFullSeed()
    .catch((error) => {
      logger.error({ error }, 'seed.full: failed');
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDatabase();
    });
}
