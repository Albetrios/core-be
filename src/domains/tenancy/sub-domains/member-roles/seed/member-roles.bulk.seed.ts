/**
 * Member-roles bulk seeder — creates `counts.customRolesPerOrg` non-system (custom) roles per
 * organization in the registry, each with a varied permission subset granted through
 * `tenancy.role_permissions` (the member-role-permission nested resource). Reuses the shared
 * `seedRole` / `seedRolePermissions` entity creators.
 *
 * Idempotency: count-and-resume per organization keyed by a deterministic role `name`
 * (`Bulk Role <index>`) under the partial-unique `(organization_id, name)` index; only indices
 * beyond those already present are created, and `seedRolePermissions` uses
 * `ON CONFLICT DO NOTHING`, so a re-run with the same counts is a no-op.
 */
import { and, eq, like, isNull } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { SYSTEM_PERMISSIONS } from '@/domains/tenancy/sub-domains/permission/seed/permission.reference.seed.js';
import { seedRole, seedRolePermissions } from '@/domains/tenancy/seed/tenancy.seed.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import { generateBulkRolePermissionCodes } from './member-roles.faker.js';

const BULK_ROLE_NAME_PREFIX = 'Bulk Role ';
const BULK_ROLE_NAME_PATTERN = `${BULK_ROLE_NAME_PREFIX}%`;
const GRANTABLE_PERMISSION_CODES = SYSTEM_PERMISSIONS.map((permission) => permission.code);

/**
 * Seeds custom roles + permission grants per registry organization, topping up to
 * `counts.customRolesPerOrg`.
 *
 * @remarks
 * Algorithm: per organization, count existing active `Bulk Role %` roles and create only the
 * missing higher indices, granting each a faker-chosen permission subset via
 * `seedRolePermissions`. Side effects: inserts into `tenancy.roles` and
 * `tenancy.role_permissions`. Failure modes: warns and returns early when no organizations exist
 * or the configured count is zero; otherwise propagates DB errors.
 */
export async function seedMemberRolesBulk(context: SeedContext): Promise<void> {
  const organizations = context.registry.organizations;
  const target = context.counts.customRolesPerOrg;
  if (organizations.length === 0) {
    context.logger.warn(
      'seed.bulk.member-roles: empty organization pool; run the tenancy seeder first',
    );
    return;
  }
  if (target <= 0) {
    context.logger.info('seed.bulk.member-roles: customRolesPerOrg is 0; nothing to seed');
    return;
  }

  const database = getRequestDatabase();
  let createdRoles = 0;
  for (const organization of organizations) {
    const existing = await database
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          eq(roles.organization_id, organization.id),
          like(roles.name, BULK_ROLE_NAME_PATTERN),
          isNull(roles.deleted_at),
        ),
      );

    for (let index = existing.length; index < target; index += 1) {
      const role = await seedRole({
        organization_id: organization.id,
        name: `${BULK_ROLE_NAME_PREFIX}${index}`,
        is_system: false,
        created_by_user_id: organization.ownerUserId,
      });
      if (!role) continue;
      const codes = generateBulkRolePermissionCodes(context.faker, GRANTABLE_PERMISSION_CODES);
      await seedRolePermissions(role.id, codes, organization.ownerUserId);
      createdRoles += 1;
    }
  }
  context.logger.info(
    { organizations: organizations.length, createdRoles },
    'seed.bulk.member-roles: custom roles seeded',
  );
}
