import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { countWithCap } from '@/infrastructure/database/utils/capped-count.util.js';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { logs } from '@/domains/audit/audit.schema.js';
import { api_keys } from '@/domains/tenancy/sub-domains/organization/organization-api-key/organization-api-key.schema.js';
import { organizations } from '@/domains/tenancy/sub-domains/organization/organization.schema.js';
import { ValidationError } from '@/shared/errors/index.js';
import {
  buildDescendingCreatedAtIdCursorCondition,
  createOpaqueCursorFromRow,
  parseListCursor,
} from '@/shared/utils/http/pagination.util.js';
import type { AuditLogFilters, NewAuditLog } from './audit.types.js';

/**
 * sec-U12: derives a stable SHA-256 (hex) of the filter set so the opaque
 * cursor can be bound to the request that minted it. Normalization is
 * intentional: sorted keys + canonical primitive serialization so callers that
 * pass `undefined` vs `null` vs omit the key all produce the same fingerprint.
 * The `limit` and `include_total` knobs are EXCLUDED — they don't change the
 * underlying result set ordering, only the page size and the count opt-in, so
 * a request that bumps `limit` after the first page must remain a valid
 * continuation (UX: "see more" toggles).
 */
function computeAuditFilterFingerprint(filters: AuditLogFilters): string {
  const normalized = {
    organization_id: filters.organization_id ?? null,
    actor_user_id: filters.actor_user_id ?? null,
    resource_type: filters.resource_type ?? null,
    action: filters.action ?? null,
    from: filters.from ?? null,
    to: filters.to ?? null,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function buildAuditFilterConditions(filters: AuditLogFilters): SQL[] {
  const conditions: SQL[] = [];
  const { organization_id, actor_user_id, resource_type, action, from, to } = filters;
  if (organization_id !== undefined && organization_id !== null) {
    conditions.push(eq(logs.organization_id, organization_id));
  }
  if (actor_user_id !== undefined && actor_user_id !== null) {
    conditions.push(eq(logs.actor_user_id, actor_user_id));
  }
  if (resource_type !== undefined && resource_type !== null) {
    conditions.push(eq(logs.resource_type, resource_type));
  }
  if (action !== undefined && action !== null) {
    conditions.push(eq(logs.action, action));
  }
  if (from !== undefined && from !== null) {
    conditions.push(gte(logs.created_at, new Date(from)));
  }
  if (to !== undefined && to !== null) {
    conditions.push(lte(logs.created_at, new Date(to)));
  }
  return conditions;
}

/**
 * Data-access layer for `audit.logs`. Append-only writes via {@link AuditRepository.insert};
 * reads expose cursor-paginated filtering on organization, actor, resource, action, and
 * time window, with an optional capped `count(*)` opt-in (bounded by
 * `LIST_TOTAL_COUNT_CAP`) for callers that need an approximate total.
 */
export class AuditRepository {
  async insert(entry: NewAuditLog): Promise<void> {
    await getRequestDatabase().insert(logs).values(entry);
  }

  /**
   * Resolves an organization API key's internal id from its public id under the active
   * organization RLS context (`tenancy.api_keys` is tenant-isolated). Returns `null` for an
   * unknown key so the caller skips writing an unattributable audit row. Soft-deleted keys are
   * intentionally still resolvable so actions remain attributable after the key is later revoked.
   */
  async resolveActorApiKeyId(apiKeyPublicId: string): Promise<number | null> {
    const rows = await getRequestDatabase()
      .select({ id: api_keys.id })
      .from(api_keys)
      .where(eq(api_keys.public_id, apiKeyPublicId))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async findWithFilters(filters: AuditLogFilters) {
    const { after, limit } = filters;
    const includeTotal = filters.include_total === true;
    const filterConditions = buildAuditFilterConditions(filters);
    const countWhere = filterConditions.length > 0 ? and(...filterConditions) : undefined;

    const filterFingerprint = computeAuditFilterFingerprint(filters);
    const parsedCursor = parseListCursor(after);
    /**
     * sec-U12: bind the cursor to its minting filter set. An admin paginating
     * `?actor_user_id=A&after=<cursor>` cannot replay the cursor against
     * `?actor_user_id=B` — the SHA-256 fingerprint baked into the cursor at
     * mint time must match the current request, or the cursor is refused.
     * The first page (no cursor) and legacy unbound cursors (no fingerprint —
     * none exist today, but the field is optional so the schema is
     * forward-compatible for any other repo that hasn't opted in) both
     * bypass the check.
     */
    if (
      parsedCursor?.filter_fingerprint !== undefined &&
      parsedCursor.filter_fingerprint !== filterFingerprint
    ) {
      throw new ValidationError('errors:validation.invalidPagination');
    }

    const conditions = [...filterConditions];
    const cursorCondition = buildDescendingCreatedAtIdCursorCondition(
      logs.created_at,
      logs.id,
      parsedCursor,
    );
    if (cursorCondition !== undefined) conditions.push(cursorCondition);
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Fetch one extra row so has_more is accurate without depending on count(*).
    const rowsPromise = getRequestDatabase()
      .select()
      .from(logs)
      .where(where)
      .orderBy(desc(logs.created_at), desc(logs.id))
      .limit(limit + 1);

    const countPromise = includeTotal
      ? countWithCap({ database: getRequestDatabase(), table: logs, where: countWhere })
      : Promise.resolve(null);

    const [fetchedRows, total] = await Promise.all([rowsPromise, countPromise]);
    const hasMore = fetchedRows.length > limit;
    const items = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
    const lastItem = items.at(-1);
    const nextCursor =
      hasMore && lastItem !== undefined
        ? createOpaqueCursorFromRow({ ...lastItem, filter_fingerprint: filterFingerprint })
        : null;
    return { items, total, hasMore, nextCursor };
  }

  async findRecent(limit: number) {
    return getRequestDatabase()
      .select()
      .from(logs)
      .orderBy(desc(logs.created_at), desc(logs.id))
      .limit(limit);
  }

  /** Lists audit activity rows authored by the user for a GDPR data-export bundle. */
  async listActivityForUserDataExport(
    actor_user_id: number,
    limit: number,
  ): Promise<{ action: string; resource_type: string; created_at: Date }[]> {
    return getRequestDatabase()
      .select({
        action: logs.action,
        resource_type: logs.resource_type,
        created_at: logs.created_at,
      })
      .from(logs)
      .where(eq(logs.actor_user_id, actor_user_id))
      .orderBy(desc(logs.created_at))
      .limit(limit);
  }

  /**
   * Batch-resolves the internal user ids carried on a page of audit rows to their public ids
   * via the `auth.resolve_user_public_ids_by_ids` SECURITY DEFINER function. auth.users is
   * FORCE RLS — a plain join from the audit query context returns zero rows even under
   * `app.global_admin`, so we go through the same resolver `MembershipRepository` uses.
   * Empty input returns an empty map without a round-trip.
   */
  async resolveUserPublicIdsByInternalIds(
    userInternalIds: readonly number[],
  ): Promise<Map<number, string>> {
    if (userInternalIds.length === 0) return new Map();
    const userIdValues = sql.join(
      userInternalIds.map((userInternalId) => sql`${userInternalId}`),
      sql`, `,
    );
    const result = await getRequestDatabase().execute(
      sql`SELECT id, public_id FROM auth.resolve_user_public_ids_by_ids(ARRAY[${userIdValues}]::bigint[])`,
    );
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as { id: number | string; public_id: string }[];
    return new Map(rows.map((row) => [Number(row.id), row.public_id]));
  }

  /**
   * Batch-resolves the internal organization ids carried on a page of audit rows to their
   * public ids. `tenancy.organizations` is not FORCE RLS for the admin / org-audit contexts
   * the audit list runs under, so a plain SELECT works (no resolver needed).
   *
   * sec-r4-D2: filter on `deleted_at IS NULL` so soft-deleted organization public ids do
   * not leak into the serialized audit-log response. Audit rows themselves are retained
   * (regulatory retention) but the audit list surface should still respect the org's
   * soft-deleted tombstone — a deleted org's public id should not be discoverable via the
   * audit-list response. Rows whose organization is soft-deleted simply omit the public id
   * (the serializer treats a missing map entry as "no public id available").
   */
  async resolveOrganizationPublicIdsByInternalIds(
    organizationInternalIds: readonly number[],
  ): Promise<Map<number, string>> {
    if (organizationInternalIds.length === 0) return new Map();
    const rows = await getRequestDatabase()
      .select({ id: organizations.id, public_id: organizations.public_id })
      .from(organizations)
      .where(
        and(
          inArray(organizations.id, [...organizationInternalIds]),
          isNull(organizations.deleted_at),
        ),
      );
    return new Map(rows.map((row) => [Number(row.id), row.public_id]));
  }
}
