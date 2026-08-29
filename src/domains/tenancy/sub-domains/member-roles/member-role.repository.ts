import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { databaseNowTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { roles } from '@/domains/tenancy/sub-domains/member-roles/member-role.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { BaseRepository } from '@/infrastructure/database/base-repository.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import {
  RESOURCE_QUOTA_LOCK_NAMESPACE,
  acquireResourceQuotaLock,
} from '@/infrastructure/database/resource-quota-lock.util.js';
import {
  buildSearchCondition,
  finishKeysetPage,
  resolveKeysetSort,
} from '@/shared/utils/http/list-query.util.js';
import type { MemberRoleRow } from './member-role.types.js';

interface MemberRoleListPagination {
  after?: string;
  limit: number;
  q?: string;
  sort?: 'name' | 'created_at';
  order?: 'asc' | 'desc';
}

/**
 * Membership lifecycle statuses that count toward a role's `member_count`.
 *
 * ACTIVE + INVITED mirrors the organization seat count
 * ({@link MembershipRepository.countActiveByOrganization}) and the set the
 * members list surfaces per role, so the Roles panel's per-role count reconciles
 * with the Members list. SUSPENDED memberships are a per-organization ban and are
 * excluded (a suspended seat is not in use). This constant is the single lever
 * for the counted-status policy — change it here to change every `member_count`.
 */
const MEMBER_COUNT_STATUSES = ['ACTIVE', 'INVITED'] as const;

/**
 * Drizzle data access for `tenancy.roles`. Active rows are filtered via
 * `deleted_at IS NULL` (soft-delete semantics); listing uses a `(name, id)`
 * keyset cursor for stable alphabetical paging. Public ids are generated and
 * retried on collision via {@link runInsertWithPublicIdentifierRetry}.
 */
export class MemberRoleRepository extends BaseRepository {
  /**
   * Counts the active (not soft-deleted) custom roles for the given organization.
   *
   * @remarks
   * sec-r5-followup-ratelimit-dos-2: used by `MemberRoleService.create` to
   * enforce `MEMBER_ROLE_MAX_PER_ORG`. Same shape as
   * `webhook.repository.countActiveByOrganization`.
   */
  async countActiveByOrganization(organization_id: number): Promise<number> {
    const rows = await getRequestDatabase()
      .select({ value: sql<number>`count(*)::int` })
      .from(roles)
      .where(and(eq(roles.organization_id, organization_id), isNull(roles.deleted_at)));
    return rows[0]?.value ?? 0;
  }

  /**
   * audit-#8: transaction-scoped advisory lock serializing the per-organization custom-role creation quota
   * check + insert so concurrent creates cannot both pass the count and overshoot
   * `MEMBER_ROLE_MAX_PER_ORG`. Call inside the create transaction before
   * {@link countActiveByOrganization}.
   */
  async acquireCreationQuotaLock(organization_id: number): Promise<void> {
    await acquireResourceQuotaLock(RESOURCE_QUOTA_LOCK_NAMESPACE.MEMBER_ROLE, organization_id);
  }

  async findByOrganizationId(organization_id: number, pagination: MemberRoleListPagination) {
    const { after, limit, q, sort, order } = pagination;
    const { orderBy, cursorCondition, sortValueFor, filterFingerprint } =
      resolveKeysetSort<MemberRoleRow>({
        columns: {
          name: { column: roles.name, kind: 'text', getSortValue: (role) => role.name },
          created_at: { column: roles.created_at, kind: 'created_at' },
        },
        idColumn: roles.id,
        defaultSort: 'name',
        sort,
        order,
        q,
        after,
      });
    const where = and(
      eq(roles.organization_id, organization_id),
      isNull(roles.deleted_at),
      buildSearchCondition([roles.name], q),
      cursorCondition,
    );
    const rows = (await getRequestDatabase()
      .select()
      .from(roles)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit + 1)) as MemberRoleRow[];
    return finishKeysetPage(rows, { limit, sortValueFor, filterFingerprint });
  }

  /**
   * Counts the members assigned to each role in an organization, in ONE aggregate.
   *
   * @remarks
   * - **Algorithm:** a single `GROUP BY role_id` over `memberships`, filtered to
   *   {@link MEMBER_COUNT_STATUSES} (ACTIVE + INVITED) and `deleted_at IS NULL`.
   *   Returns a `Map` keyed by internal `role_id`; roles with no counted members
   *   are simply absent, so callers default to 0. One grouped scan bounded by the
   *   per-organization member cap — this is what keeps the roles-list `member_count`
   *   projection free of an N+1 (never call {@link countMembersForRole} per row).
   * - **Failure modes:** none beyond the underlying query; runs under the organization RLS
   *   context (`memberships` is organization-scoped), so the organization predicate is belt-and-suspenders.
   * - **Side effects:** none (read-only).
   */
  async countMembersByRoleForOrganization(organization_id: number): Promise<Map<number, number>> {
    const rows = await getRequestDatabase()
      .select({ role_id: memberships.role_id, member_count: sql<number>`count(*)::int` })
      .from(memberships)
      .where(
        and(
          eq(memberships.organization_id, organization_id),
          inArray(memberships.status, [...MEMBER_COUNT_STATUSES]),
          isNull(memberships.deleted_at),
        ),
      )
      .groupBy(memberships.role_id);
    return new Map(rows.map((row) => [row.role_id, row.member_count]));
  }

  /**
   * Counts the members assigned to a single role in an organization.
   *
   * @remarks
   * Same status filter as {@link countMembersByRoleForOrganization} (ACTIVE +
   * INVITED, not soft-deleted) — used by the single-role get / update paths where
   * grouping the whole organization would be wasteful. Distinct from
   * {@link MembershipRepository.countActiveByRoleId}, which counts EVERY
   * non-deleted membership (including SUSPENDED) for the delete guard's
   * "any member blocks delete" semantics.
   */
  async countMembersForRole(role_id: number, organization_id: number): Promise<number> {
    const rows = await getRequestDatabase()
      .select({ member_count: sql<number>`count(*)::int` })
      .from(memberships)
      .where(
        and(
          eq(memberships.role_id, role_id),
          eq(memberships.organization_id, organization_id),
          inArray(memberships.status, [...MEMBER_COUNT_STATUSES]),
          isNull(memberships.deleted_at),
        ),
      );
    return rows[0]?.member_count ?? 0;
  }

  async findByPublicId(public_id: string, organization_id: number): Promise<MemberRoleRow | null> {
    const rows = await getRequestDatabase()
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.public_id, public_id),
          eq(roles.organization_id, organization_id),
          isNull(roles.deleted_at),
        ),
      )
      .limit(1);
    return (rows[0] ?? null) as MemberRoleRow | null;
  }

  async findByInternalId(
    role_internal_id: number,
    organization_id: number,
  ): Promise<MemberRoleRow | null> {
    const rows = await getRequestDatabase()
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.id, role_internal_id),
          eq(roles.organization_id, organization_id),
          isNull(roles.deleted_at),
        ),
      )
      .limit(1);
    return (rows[0] ?? null) as MemberRoleRow | null;
  }

  async create(data: {
    organization_id: number;
    name: string;
    description?: string | null;
    is_system?: boolean;
    created_by_user_id?: number | null;
  }) {
    return runInsertWithPublicIdentifierRetry(async () => {
      const public_id = generatePublicId('memberRole');
      const row = {
        public_id,
        organization_id: data.organization_id,
        name: data.name,
        description: data.description ?? null,
        is_system: data.is_system ?? false,
        created_by_user_id: data.created_by_user_id ?? undefined,
        updated_by_user_id: data.created_by_user_id ?? undefined,
      };
      const rows = await getRequestDatabase().insert(roles).values(row).returning();
      return rows[0]! as MemberRoleRow;
    });
  }

  async update(
    public_id: string,
    organization_id: number,
    data: { name?: string; description?: string | null },
    updated_by_user_id: number | null,
  ): Promise<MemberRoleRow | null> {
    const rows = await getRequestDatabase()
      .update(roles)
      .set({
        ...data,
        updated_at: databaseNowTimestamp,
        updated_by_user_id: updated_by_user_id ?? undefined,
      })
      .where(
        and(
          eq(roles.public_id, public_id),
          eq(roles.organization_id, organization_id),
          isNull(roles.deleted_at),
        ),
      )
      .returning();
    return (rows[0] ?? null) as MemberRoleRow | null;
  }

  async softDelete(public_id: string, organization_id: number): Promise<MemberRoleRow | null> {
    const rows = await getRequestDatabase()
      .update(roles)
      .set({ deleted_at: databaseNowTimestamp, updated_at: databaseNowTimestamp })
      .where(
        and(
          eq(roles.public_id, public_id),
          eq(roles.organization_id, organization_id),
          isNull(roles.deleted_at),
        ),
      )
      .returning();
    return (rows[0] ?? null) as MemberRoleRow | null;
  }

  /**
   * Soft-deletes a role ONLY if it has no active (not soft-deleted) members, in ONE statement.
   *
   * @remarks
   * A `NOT EXISTS` over `memberships` is folded into the delete's WHERE so a concurrent
   * member-assignment cannot slip between a separate count and the delete and leave a member pointing
   * at a `deleted_at` role — which the permission-resolution join (`roles.deleted_at IS NULL`) would
   * then silently strip of all permissions (route-audit C2). Returns the deleted row, or `null` when
   * the role is missing/already-deleted OR still has active members; the caller distinguishes the
   * latter via a prior existence check.
   */
  async softDeleteIfNoActiveMembers(
    public_id: string,
    organization_id: number,
  ): Promise<MemberRoleRow | null> {
    const rows = await getRequestDatabase()
      .update(roles)
      .set({ deleted_at: databaseNowTimestamp, updated_at: databaseNowTimestamp })
      .where(
        and(
          eq(roles.public_id, public_id),
          eq(roles.organization_id, organization_id),
          isNull(roles.deleted_at),
          sql`NOT EXISTS (
            SELECT 1
            FROM ${memberships}
            WHERE ${memberships.role_id} = ${roles.id}
              AND ${memberships.organization_id} = ${organization_id}
              AND ${memberships.deleted_at} IS NULL
          )`,
        ),
      )
      .returning();
    return (rows[0] ?? null) as MemberRoleRow | null;
  }
}
