import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { databaseNowTimestamp } from '@/shared/utils/infrastructure/database-timestamp.util.js';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { memberships } from '@/domains/tenancy/sub-domains/membership/membership.schema.js';
import { users as authUsers } from '@/domains/user/user.schema.js';
import { BaseRepository } from '@/infrastructure/database/base-repository.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { runInsertWithPublicIdentifierRetry } from '@/shared/utils/infrastructure/postgres-error.util.js';
import {
  RESOURCE_QUOTA_LOCK_NAMESPACE,
  acquireResourceQuotaLock,
} from '@/infrastructure/database/resource-quota-lock.util.js';
import {
  buildAscendingCreatedAtIdCursorCondition,
  createOpaqueCursorFromRow,
  parseListCursor,
} from '@/shared/utils/http/pagination.util.js';
import type { Organization } from './organization.types.js';

/**
 * Normalizes a `db.execute()` result into rows across drivers (postgres-js returns an array,
 * node-postgres a `{ rows }` envelope) for the SECURITY DEFINER `auth.*` resolvers.
 */
function extractResolverRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

interface OrganizationListPagination {
  after?: string;
  limit: number;
}

/**
 * Drizzle data-access for the `tenancy.organizations` table. Honours
 * soft-delete (`deleted_at IS NULL`) on every read; supports cursor-based
 * listings (global and per-user via memberships join), slug + Stripe customer
 * lookups, owner transfer, and soft-delete. Insert paths use
 * {@link runInsertWithPublicIdentifierRetry} to recover from rare public-id
 * collisions.
 */
export class OrganizationRepository extends BaseRepository {
  /**
   * Resolve `auth.users.public_id` → internal id via the `auth.resolve_user_id_by_public_id`
   * SECURITY DEFINER resolver rather than a direct `auth.users` SELECT.
   *
   * @remarks
   * `auth.users` is FORCE RLS and its only policy is
   * `public_id = app.current_user_public_id OR app.global_admin`. Most callers here run inside
   * `withAppDatabaseContext`, which sets ONLY `app.current_organization_public_id` — so a
   * direct SELECT matched no row and returned `null`, silently nulling the
   * `created_by_user_id` / `updated_by_user_id` attribution it feeds. The resolver carries the
   * identical `deleted_at IS NULL` predicate, so behaviour is unchanged where RLS already
   * allowed the read.
   */
  async resolveUserIdByPublicId(public_id: string | undefined): Promise<number | null> {
    if (!public_id) return null;
    const result = await getRequestDatabase().execute<{ id: string | number | null }>(
      sql`SELECT auth.resolve_user_id_by_public_id(${public_id}) AS id`,
    );
    const rawId = extractResolverRows<{ id: string | number | null }>(result)[0]?.id ?? null;
    return rawId === null ? null : Number(rawId);
  }

  /**
   * Resolve an internal user id → `auth.users.public_id` via the `auth.resolve_user_by_internal_id`
   * SECURITY DEFINER resolver rather than a direct `auth.users` SELECT.
   *
   * @remarks
   * Same FORCE RLS rationale as {@link OrganizationRepository.resolveUserIdByPublicId}. This
   * direction is the more damaging one: `MembershipService.invalidatePermissionsForMembership`
   * guards on the result, so a `null` silently SKIPPED the permission-cache purge on role change,
   * member removal, and bulk suspend — leaving revoked permissions live for the remainder of the
   * cache TTL. The resolver carries the identical `deleted_at IS NULL` predicate.
   */
  async resolveUserPublicIdByInternalId(user_id: number): Promise<string | null> {
    const result = await getRequestDatabase().execute<{ public_id: string | null }>(
      sql`SELECT public_id FROM auth.resolve_user_by_internal_id(${user_id})`,
    );
    return extractResolverRows<{ public_id: string | null }>(result)[0]?.public_id ?? null;
  }

  /**
   * Batch-resolve internal user ids → public ids in ONE statement.
   *
   * @remarks
   * Same FORCE RLS rationale as {@link OrganizationRepository.resolveUserPublicIdByInternalId},
   * which this replaces wherever a caller holds a whole set of ids. The single-id version is
   * still correct for a single id; the problem is calling it in a loop, which
   * `MembershipService` did once per suspended member while fitting an organization to a
   * downgraded seat ceiling — an unbounded count, one round trip each.
   *
   * `auth.resolve_user_public_ids_by_ids` is the batch sibling and carries the identical
   * `deleted_at IS NULL` predicate, so an id with no active user is simply absent from the
   * map — the same signal `null` gave. `audit.repository.ts` resolves audit-row actors the
   * same way. Empty input returns an empty map without a round trip.
   */
  async resolveUserPublicIdsByInternalIds(
    user_ids: readonly number[],
  ): Promise<Map<number, string>> {
    if (user_ids.length === 0) return new Map();
    const userIdValues = sql.join(
      user_ids.map((user_id) => sql`${user_id}`),
      sql`, `,
    );
    const result = await getRequestDatabase().execute(
      sql`SELECT id, public_id FROM auth.resolve_user_public_ids_by_ids(ARRAY[${userIdValues}]::bigint[])`,
    );
    const rows = extractResolverRows<{ id: number | string; public_id: string }>(result);
    return new Map(rows.map((row) => [Number(row.id), row.public_id]));
  }

  async findById(identifier: number): Promise<Organization | null> {
    const rows = await getRequestDatabase()
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, identifier), isNull(organizations.deleted_at)))
      .limit(1);
    return (rows[0] ?? null) as Organization | null;
  }

  async findByPublicId(public_id: string): Promise<Organization | null> {
    const rows = await getRequestDatabase()
      .select()
      .from(organizations)
      .where(and(eq(organizations.public_id, public_id), isNull(organizations.deleted_at)))
      .limit(1);
    return (rows[0] ?? null) as Organization | null;
  }

  async findBySlug(slug: string): Promise<Organization | null> {
    const rows = await getRequestDatabase()
      .select()
      .from(organizations)
      .where(and(eq(organizations.slug, slug), isNull(organizations.deleted_at)))
      .limit(1);
    return (rows[0] ?? null) as Organization | null;
  }

  async findAllForUser(user_public_id: string, pagination: OrganizationListPagination) {
    const { after, limit } = pagination;
    // The caller's internal id, resolved INSIDE this query rather than by a preceding round trip.
    // `auth.resolve_user_id_by_public_id` is STABLE, so Postgres evaluates it once per statement;
    // an unknown or soft-deleted user resolves to NULL, both comparisons below fail, and the page
    // comes back empty — the same answer the separate lookup produced with an early return.
    const userId = sql<number>`auth.resolve_user_id_by_public_id(${user_public_id})`;
    const cursorCondition = buildAscendingCreatedAtIdCursorCondition(
      organizations.created_at,
      organizations.id,
      parseListCursor(after),
    );
    // Perf: push the membership predicate into a subquery rather than a LEFT JOIN so the access
    // filter references only `organizations`. That lets the partial keyset index
    // `idx_organizations_created_id_active (created_at, id) WHERE deleted_at IS NULL` drive an
    // index-ordered scan — a join-side predicate in the OR branch forced a join + sort over the
    // whole organization table per page, so latency grew with total tenant count, not the user's organization count.
    // The subquery reads `memberships` with the identical predicate, so the result set is unchanged.
    const accessWhere = and(
      isNull(organizations.deleted_at),
      cursorCondition,
      or(
        eq(organizations.owner_user_id, userId),
        inArray(
          organizations.id,
          getRequestDatabase()
            .select({ organizationId: memberships.organization_id })
            .from(memberships)
            .where(
              and(
                eq(memberships.user_id, userId),
                eq(memberships.status, 'ACTIVE'),
                isNull(memberships.deleted_at),
              ),
            ),
        ),
      ),
    );
    const rows = await getRequestDatabase()
      .select()
      .from(organizations)
      .where(accessWhere)
      .orderBy(asc(organizations.created_at), asc(organizations.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const organizationsOnly = hasMore ? rows.slice(0, limit) : rows;
    const lastItem = organizationsOnly.at(-1);
    return {
      items: organizationsOnly,
      total: null,
      limit,
      has_more: hasMore,
      next_cursor: hasMore && lastItem !== undefined ? createOpaqueCursorFromRow(lastItem) : null,
    };
  }

  /**
   * The organization, if this user may see it — otherwise `null`.
   *
   * @remarks
   * Returns the ROW rather than a boolean because every caller needed it next and
   * fetched it again: `getByPublicId` ran `findByPublicId` here and then a second,
   * identical `findByPublicId` immediately after, so the normal team-member path
   * cost four queries to read one row. Handing the row back removes that entirely.
   */
  async userCanAccessOrganization(
    user_public_id: string,
    organization_public_id: string,
  ): Promise<Organization | null> {
    const organization = await this.findByPublicId(organization_public_id);
    if (!organization) {
      return null;
    }
    const canAccess = await this.userCanAccessLoadedOrganization(user_public_id, organization);
    return canAccess ? organization : null;
  }

  /**
   * The same access rule against an organization the caller already holds.
   *
   * @remarks
   * For a caller that reached the row another way — `getBySlug` looks it up by slug —
   * the public-id variant above would re-read the identical row. This is the shared
   * half of that check, so neither path pays for a lookup it has already done.
   */
  async userCanAccessLoadedOrganization(
    user_public_id: string,
    organization: Organization,
  ): Promise<boolean> {
    const userId = await this.resolveUserIdByPublicId(user_public_id);
    if (userId !== null && organization.owner_user_id === userId) {
      return true;
    }
    return this.userHasActiveMembership(user_public_id, organization.public_id);
  }

  async userHasActiveMembership(
    user_public_id: string,
    organization_public_id: string,
  ): Promise<boolean> {
    const rows = await getRequestDatabase()
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(authUsers, eq(memberships.user_id, authUsers.id))
      .innerJoin(organizations, eq(memberships.organization_id, organizations.id))
      .where(
        and(
          eq(authUsers.public_id, user_public_id),
          eq(organizations.public_id, organization_public_id),
          eq(memberships.status, 'ACTIVE'),
          isNull(memberships.deleted_at),
          isNull(organizations.deleted_at),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Resolve the login-default organization `public_id` for a user: the PERSONAL organization
   * first (when {@link includePersonalOrganizations}), otherwise the most-recently-joined ACTIVE
   * TEAM membership. Returns `null` when the user has no eligible active membership. One indexed
   * memberships → organizations join, ordered personal-first then most-recent join.
   */
  async findDefaultActiveOrganizationPublicId(
    user_id: number,
    includePersonalOrganizations: boolean,
  ): Promise<string | null> {
    const rows = await getRequestDatabase()
      .select({ public_id: organizations.public_id })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organization_id))
      .where(
        and(
          eq(memberships.user_id, user_id),
          eq(memberships.status, 'ACTIVE'),
          isNull(organizations.deleted_at),
          eq(organizations.status, 'ACTIVE'),
          includePersonalOrganizations ? undefined : sql`${organizations.type} <> 'PERSONAL'`,
        ),
      )
      .orderBy(desc(sql`(${organizations.type} = 'PERSONAL')`), desc(memberships.joined_at))
      .limit(1);
    return rows[0]?.public_id ?? null;
  }

  /**
   * Confirm the user holds an ACTIVE membership in the given (active, non-deleted) organization and
   * return its `public_id`, or `null` when the membership does not exist — the gate for
   * `switch-to-organization`. Constrained to the caller's own `user_id`.
   */
  async findActiveMembershipOrganizationPublicId(
    user_id: number,
    organization_public_id: string,
  ): Promise<string | null> {
    const rows = await getRequestDatabase()
      .select({ public_id: organizations.public_id })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organization_id))
      .where(
        and(
          eq(memberships.user_id, user_id),
          eq(memberships.status, 'ACTIVE'),
          eq(organizations.public_id, organization_public_id),
          isNull(organizations.deleted_at),
          eq(organizations.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    return rows[0]?.public_id ?? null;
  }

  /**
   * Resolve the user's own PERSONAL organization `public_id` — the `switch-to-personal` target —
   * or `null` when the user has no personal organization. Constrained to `owner_user_id`.
   */
  async findPersonalOrganizationPublicId(owner_user_id: number): Promise<string | null> {
    const rows = await getRequestDatabase()
      .select({ public_id: organizations.public_id })
      .from(organizations)
      .where(
        and(
          eq(organizations.owner_user_id, owner_user_id),
          eq(organizations.type, 'PERSONAL'),
          isNull(organizations.deleted_at),
        ),
      )
      .limit(1);
    return rows[0]?.public_id ?? null;
  }

  /**
   * Confirm the user holds an ACTIVE membership in the given (active, non-deleted) organization
   * and return both its internal `id` and `public_id`, or `null` when no such active membership
   * exists. Used when the caller needs the internal id (e.g. persisting it on the session row at
   * switch time — audit-#3). Constrained to the caller's own `user_id`.
   */
  async findActiveMembershipOrganizationByPublicId(
    user_id: number,
    organization_public_id: string,
  ): Promise<{ id: number; public_id: string } | null> {
    const rows = await getRequestDatabase()
      .select({ id: organizations.id, public_id: organizations.public_id })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organization_id))
      .where(
        and(
          eq(memberships.user_id, user_id),
          eq(memberships.status, 'ACTIVE'),
          eq(organizations.public_id, organization_public_id),
          isNull(organizations.deleted_at),
          eq(organizations.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Confirm the user holds an ACTIVE membership in the organization identified by its internal
   * `id` and return the org's `public_id`, or `null` — refresh-time revalidation of the organization
   * persisted on a session (audit-#3). Constrained to the caller's own `user_id`.
   */
  async findActiveMembershipOrganizationPublicIdByInternalId(
    user_id: number,
    organization_id: number,
  ): Promise<string | null> {
    const rows = await getRequestDatabase()
      .select({ public_id: organizations.public_id })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.organization_id))
      .where(
        and(
          eq(memberships.user_id, user_id),
          eq(memberships.status, 'ACTIVE'),
          eq(organizations.id, organization_id),
          isNull(organizations.deleted_at),
          eq(organizations.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    return rows[0]?.public_id ?? null;
  }

  /**
   * Resolve the user's own PERSONAL organization `id` and `public_id` — the `switch-to-personal`
   * target — or `null` when the user has no personal organization. Returns both identifiers so
   * callers that need to persist the internal id on the session row (audit-#3) avoid a second
   * query. Constrained to `owner_user_id`.
   */
  async findPersonalOrganization(
    owner_user_id: number,
  ): Promise<{ id: number; public_id: string } | null> {
    const rows = await getRequestDatabase()
      .select({ id: organizations.id, public_id: organizations.public_id })
      .from(organizations)
      .where(
        and(
          eq(organizations.owner_user_id, owner_user_id),
          eq(organizations.type, 'PERSONAL'),
          isNull(organizations.deleted_at),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async create(data: {
    name: string;
    /** Null for a personal organization (no human handle); kebab string for a team. */
    slug: string | null;
    /** `PERSONAL` or `TEAM` (defaults to `TEAM` for the public create endpoint). */
    type?: string;
    owner_user_id: number;
    created_by_user_id: number | null;
  }) {
    return runInsertWithPublicIdentifierRetry(async () => {
      const public_id = generatePublicId('organization');
      const row = {
        public_id,
        name: data.name,
        slug: data.slug,
        type: data.type ?? 'TEAM',
        owner_user_id: data.owner_user_id,
        created_by_user_id: data.created_by_user_id ?? undefined,
        updated_by_user_id: data.created_by_user_id ?? undefined,
      };
      const rows = await getRequestDatabase().insert(organizations).values(row).returning();
      return rows[0]! as Organization;
    });
  }

  async update(
    public_id: string,
    data: { name?: string; slug?: string; status?: string; logo_url?: string | null },
    updated_by_user_id: number | null,
  ): Promise<Organization | null> {
    const rows = await getRequestDatabase()
      .update(organizations)
      .set({
        ...data,
        updated_at: databaseNowTimestamp,
        updated_by_user_id: updated_by_user_id ?? undefined,
      })
      .where(and(eq(organizations.public_id, public_id), isNull(organizations.deleted_at)))
      .returning();
    return (rows[0] ?? null) as Organization | null;
  }

  async updateOwner(public_id: string, owner_user_id: number): Promise<Organization | null> {
    const rows = await getRequestDatabase()
      .update(organizations)
      .set({
        owner_user_id,
        updated_at: databaseNowTimestamp,
      })
      .where(
        and(
          eq(organizations.public_id, public_id),
          isNull(organizations.deleted_at),
          // Atomic guard against the transfer-ownership TOCTOU: only hand ownership to a user who
          // is STILL an active member at write time. If a concurrent request suspends or removes
          // the prospective owner between the caller's status pre-check and this update, the EXISTS
          // fails, the UPDATE matches zero rows, and the caller surfaces a clean conflict — so the
          // organization can never end up owned by a suspended/removed member.
          sql`EXISTS (
            SELECT 1 FROM ${memberships}
            WHERE ${memberships.user_id} = ${owner_user_id}
              AND ${memberships.organization_id} = ${organizations.id}
              AND ${memberships.status} = 'ACTIVE'
              AND ${memberships.deleted_at} IS NULL
          )`,
        ),
      )
      .returning();
    return (rows[0] ?? null) as Organization | null;
  }

  /**
   * Counts the active (not soft-deleted) **TEAM** organizations owned by a user
   * (route-audit-#2 follow-up). Used to block deleting a user who still owns team
   * organizations (require ownership transfer first).
   *
   * @remarks PERSONAL organizations are excluded: every user owns exactly one, and it
   * cascade-deletes with the account — counting it would make account deletion impossible.
   */
  async countActiveOwnedByUser(owner_user_id: number): Promise<number> {
    const rows = await getRequestDatabase()
      .select({ value: sql<number>`count(*)::int` })
      .from(organizations)
      .where(
        and(
          eq(organizations.owner_user_id, owner_user_id),
          eq(organizations.type, 'TEAM'),
          isNull(organizations.deleted_at),
        ),
      );
    return rows[0]?.value ?? 0;
  }

  /**
   * audit-#8: transaction-scoped advisory lock serializing the owned-TEAM-organization creation
   * quota check + insert for one owner, so concurrent creates cannot both pass the count and
   * overshoot `MAX_TEAM_ORGANIZATIONS_PER_OWNER`. Keyed by the owner user id; call inside the
   * create transaction before {@link countActiveOwnedByUser}.
   */
  async acquireOwnedOrganizationQuotaLock(owner_user_id: number): Promise<void> {
    await acquireResourceQuotaLock(RESOURCE_QUOTA_LOCK_NAMESPACE.OWNED_ORGANIZATION, owner_user_id);
  }

  async updateStripeCustomerId(
    organization_id: number,
    stripe_customer_id: string,
  ): Promise<Organization | null> {
    // sec-new-D1: include isNull(deleted_at) so a soft-deleted organization's
    // stripe_customer_id cannot be clobbered by a Stripe webhook that still
    // references the old customer id (returns null → caller treats it as a no-op).
    const rows = await getRequestDatabase()
      .update(organizations)
      .set({
        stripe_customer_id,
        updated_at: databaseNowTimestamp,
      })
      .where(and(eq(organizations.id, organization_id), isNull(organizations.deleted_at)))
      .returning();
    return (rows[0] ?? null) as Organization | null;
  }

  async findByStripeCustomerId(stripe_customer_id: string): Promise<Organization | null> {
    const rows = await getRequestDatabase()
      .select()
      .from(organizations)
      .where(
        and(
          eq(organizations.stripe_customer_id, stripe_customer_id),
          isNull(organizations.deleted_at),
        ),
      )
      .limit(1);
    return (rows[0] ?? null) as Organization | null;
  }

  async markDeletionStarted(public_id: string): Promise<Organization | null> {
    const rows = await getRequestDatabase()
      .update(organizations)
      .set({ deletion_started_at: databaseNowTimestamp, updated_at: databaseNowTimestamp })
      .where(and(eq(organizations.public_id, public_id), isNull(organizations.deleted_at)))
      .returning();
    return (rows[0] ?? null) as Organization | null;
  }

  async softDelete(public_id: string): Promise<Organization | null> {
    const rows = await getRequestDatabase()
      .update(organizations)
      .set({ deleted_at: databaseNowTimestamp, updated_at: databaseNowTimestamp })
      .where(
        and(
          eq(organizations.public_id, public_id),
          isNull(organizations.deleted_at),
          isNotNull(organizations.deletion_started_at),
        ),
      )
      .returning();
    return (rows[0] ?? null) as Organization | null;
  }
}
