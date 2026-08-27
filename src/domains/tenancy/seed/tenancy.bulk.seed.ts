/**
 * Tenancy bulk seeder — creates organizations (deterministic slugs `bulk-org-<index>`), each
 * with an Admin role + full permission grant and a faker-sized set of ACTIVE memberships drawn
 * from the user pool in the registry. Created organizations are appended to the registry for
 * downstream domains (billing, notify, upload, audit).
 *
 * Idempotency: only organization indices beyond those already present are created, so a re-run
 * with the same counts is a no-op.
 */
import { like } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { SYSTEM_PERMISSIONS } from '@/domains/tenancy/sub-domains/permission/seed/permission.reference.seed.js';
import type { SeedContext, SeededUser } from '@/scripts/seed/seed-contract.js';
import { generateBulkOrganizationName } from './tenancy.faker.js';
import { seedMembership, seedOrganization, seedRole, seedRolePermissions } from './tenancy.seed.js';

const BULK_SLUG_PREFIX = 'bulk-org-';
const BULK_SLUG_PATTERN = `${BULK_SLUG_PREFIX}%`;
const ADMIN_PERMISSION_CODES = SYSTEM_PERMISSIONS.map((permission) => permission.code);

/**
 * Seeds organizations + roles + memberships and appends each org to `context.registry`.
 *
 * @remarks
 * Algorithm: count existing bulk orgs, create only the missing higher indices (each with an
 * Admin role, full grant, owner membership, and additional members), then re-select all bulk
 * orgs into the registry. Side effects: inserts into organizations / roles / role_permissions /
 * memberships. Failure modes: warns and returns early if the user pool is empty; otherwise
 * propagates DB errors.
 */
export async function seedOrganizationsBulk(context: SeedContext): Promise<void> {
  const database = getRequestDatabase();
  const { organizations: targetCount, usersPerOrg } = context.counts;
  const pool = context.registry.users;
  if (pool.length === 0) {
    context.logger.warn('seed.bulk.tenancy: empty user pool; run the user seeder first');
    return;
  }

  let cursor = 0;
  const nextUser = (): SeededUser => pool[cursor++ % pool.length] as SeededUser;

  const existing = await database
    .select({ id: organizations.id })
    .from(organizations)
    .where(like(organizations.slug, BULK_SLUG_PATTERN));

  for (let index = existing.length; index < targetCount; index += 1) {
    const owner = nextUser();
    const organization = await seedOrganization({
      name: generateBulkOrganizationName(context.faker),
      slug: `${BULK_SLUG_PREFIX}${index}`,
      owner_user_id: owner.id,
    });
    if (!organization) continue;

    const adminRole = await seedRole({
      organization_id: organization.id,
      name: 'Admin',
      is_system: true,
      created_by_user_id: owner.id,
    });
    if (!adminRole) continue;
    await seedRolePermissions(adminRole.id, ADMIN_PERMISSION_CODES, owner.id);

    const memberIds = new Set<number>();
    const memberCount = Math.max(1, context.faker.number.int(usersPerOrg));
    for (let slot = 0; slot < memberCount; slot += 1) {
      const member = slot === 0 ? owner : nextUser();
      if (memberIds.has(member.id)) continue;
      memberIds.add(member.id);
      await seedMembership({
        user_id: member.id,
        organization_id: organization.id,
        role_id: adminRole.id,
        status: 'ACTIVE',
        created_by_user_id: owner.id,
      });
    }
  }

  const rows = await database
    .select({
      id: organizations.id,
      public_id: organizations.public_id,
      owner_user_id: organizations.owner_user_id,
    })
    .from(organizations)
    .where(like(organizations.slug, BULK_SLUG_PATTERN));
  for (const row of rows) {
    context.registry.addOrganization({
      id: row.id,
      public_id: row.public_id,
      ownerUserId: row.owner_user_id,
    });
  }
  context.logger.info({ organizations: rows.length }, 'seed.bulk.tenancy: organizations seeded');
}
