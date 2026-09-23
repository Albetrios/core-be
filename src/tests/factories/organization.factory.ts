import { faker } from '@faker-js/faker';
import { database } from '@/infrastructure/database/connection.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { getOperatorSql } from '@/tests/helpers/operator-database.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';

export interface CreateOrganizationOptions {
  name?: string;
  slug?: string;
  ownerUserId: number;
  /**
   * Organization type. Defaults to the column default `'TEAM'`. Pass `'PERSONAL'` to build the
   * organization shape that `assertTeamOrganization` rejects with 422 — the only way to drive the
   * team-only guard on billing / other team-scoped routes at the HTTP boundary rather than by
   * stubbing the organization service. A user may own only one PERSONAL organization
   * (`idx_organizations_personal_owner` is a partial unique index).
   */
  type?: 'PERSONAL' | 'TEAM';
}

/**
 * Maximum length of the database `slug` column (Drizzle schema:
 * `varchar('slug', { length: 50 })`).
 */
const ORGANIZATION_SLUG_MAX_LENGTH = 50;

/**
 * Length of the public-id suffix appended to every test slug. The public id
 * is a 21-char base32-style identifier; 10 chars is comfortably below birthday
 * collisions for the worst-case test fan-out and leaves room for a hyphen + a
 * meaningful slug prefix inside the 50-char column.
 */
const ORGANIZATION_SLUG_PUBLIC_ID_SUFFIX_LENGTH = 10;

/**
 * Create a test organization in the database.
 *
 * @remarks
 * Always suffixes the generated slug with the first 10 chars of the public id
 * so parallel test files using faker-generated names cannot collide on
 * `tenancy.idx_organizations_slug` (a unique index). faker's name pool is
 * finite — without the suffix, `Math.random` repeats inside the same Vitest
 * worker pool and inserts fail with 23505 (e.g. `mayert-llc` collided across
 * `organization-settings-resolvers.security.test.ts` and others). Explicit
 * `options.slug` is still accepted as-is so individual tests can pin a slug
 * for assertion purposes.
 */
export async function createTestOrganization(options: CreateOrganizationOptions) {
  const publicId = generatePublicId('organization');
  const name = options.name ?? faker.company.name();
  const slug = options.slug ?? buildCollisionResistantSlug(name, publicId);

  // `tenancy.organizations` is FORCE RLS; its WITH CHECK is satisfied by the owner's context,
  // which is exactly how `OrganizationService.create` inserts — pinned to
  // `PRINCIPAL_SCOPE.VERIFIED({ userPublicId: owner_user_public_id })`. Resolving the owner's
  // public id is a fixture concern (the lookup is itself RLS-gated and the caller only has an
  // internal id), so that one read uses the operator connection; the INSERT itself stays
  // on the production path rather than out-privileging the policy it is meant to respect.
  const [owner] = await getOperatorSql()<{ public_id: string }[]>`
    SELECT public_id FROM auth.users WHERE id = ${options.ownerUserId}
  `;
  if (!owner) {
    throw new Error(`createTestOrganization: no user with id ${options.ownerUserId}`);
  }

  const [organization] = await withAppDatabaseContext(
    PRINCIPAL_SCOPE.VERIFIED({ userPublicId: owner.public_id }),
    (databaseHandle) =>
      (databaseHandle ?? database)
        .insert(organizations)
        .values({
          public_id: publicId,
          name,
          slug,
          owner_user_id: options.ownerUserId,
          created_by_user_id: options.ownerUserId,
          ...(options.type !== undefined ? { type: options.type } : {}),
        })
        .returning(),
  );

  return organization!;
}

/**
 * Builds a `<slug-prefix>-<publicIdSuffix>` slug that fits the 50-char column
 * and is guaranteed unique per call (the public id supplies the entropy).
 */
function buildCollisionResistantSlug(name: string, publicId: string): string {
  // Slug column only allows [a-z0-9-]; skip the `org_` prefix and use the random core.
  const publicIdCore = publicId.slice(publicId.indexOf('_') + 1);
  const suffix = `-${publicIdCore.slice(0, ORGANIZATION_SLUG_PUBLIC_ID_SUFFIX_LENGTH)}`;
  const prefixBudget = ORGANIZATION_SLUG_MAX_LENGTH - suffix.length;
  const prefix = faker.helpers.slugify(name).toLowerCase().slice(0, prefixBudget);
  return `${prefix}${suffix}`;
}
