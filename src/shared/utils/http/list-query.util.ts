/**
 * Common building blocks for organization-scoped list endpoints that support opaque-cursor pagination
 * **plus** server-side search (`q`) and sort (`sort` / `order`). One mechanism shared by every list
 * (memberships, roles, api-keys, …) so the keyset + cursor + filter-binding subtleties live in a
 * single place instead of being hand-rolled per repository.
 *
 * @remarks
 * - **Algorithm**: `q` becomes a case-insensitive `ILIKE` over the configured columns; `sort`/`order`
 *   pick the matching keyset condition (`(created_at,id)` or `(text,id)`, asc/desc) from
 *   `pagination.util.ts`; the page fetches `limit + 1` rows to compute `has_more` without a count.
 * - **Filter binding (sec-U12)**: the minted cursor carries a SHA-256 fingerprint of `{q, sort,
 *   order}`. A cursor whose fingerprint no longer matches the current query is ignored (the page
 *   resets to the first page) so a cursor minted under one sort/filter can't yield wrong rows under
 *   another — never silently interleaving pages.
 * - **Side effects**: none (pure query construction); the caller owns the DB round-trip.
 * - **Notes**: columns may live on a joined table — the helper only needs the `AnyColumn`; the
 *   repository's query supplies the join and selects the sort value.
 */
import { createHash } from 'node:crypto';
import { type AnyColumn, asc, desc, ilike, type SQL, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  buildAscendingCreatedAtIdCursorCondition,
  buildAscendingTextIdCursorCondition,
  buildDescendingCreatedAtIdCursorCondition,
  buildDescendingTextIdCursorCondition,
  createOpaqueCursorFromRow,
  cursorPaginationSchema,
  type ParsedListCursor,
  parseListCursor,
} from './pagination.util.js';

/** Max length of a `q` search term (defensive; the `ILIKE` is escaped regardless). */
const SEARCH_TERM_MAX_LENGTH = 200;

/**
 * Builds a `.strict()` list-query schema: cursor pagination + optional `q`, `sort` (constrained to
 * `sortFields`), and `order` (`asc`/`desc`, default `asc`). Reuse per list endpoint DTO.
 */
export function listSearchSortSchema<const Fields extends readonly [string, ...string[]]>(
  sortFields: Fields,
) {
  return cursorPaginationSchema
    .extend({
      q: z.string().trim().min(1).max(SEARCH_TERM_MAX_LENGTH).optional(),
      sort: z.enum(sortFields).optional(),
      // Optional (not `.default`) so OpenAPI emits it as an optional query param — a defaulted
      // param serializes as `required`, a breaking contract change. Defaulted to
      // ascending inside resolveKeysetSort instead.
      order: z.enum(['asc', 'desc']).optional(),
    })
    .strict();
}

/** Escapes `ILIKE` wildcards so a user's `%`/`_`/`\` are matched literally (default `ESCAPE '\'`). */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Builds a contained `%term%` `ILIKE` pattern with the user's wildcards escaped. */
export function buildContainsLikePattern(term: string): string {
  return `%${escapeLikeTerm(term)}%`;
}

/**
 * Case-insensitive `ILIKE '%term%'` across `columns` (OR-combined). Returns `undefined` when `q` is
 * empty so callers can spread it into `and(...)` unconditionally.
 */
export function buildSearchCondition(
  columns: readonly AnyColumn[],
  q: string | undefined,
): SQL | undefined {
  if (!q || columns.length === 0) {
    return undefined;
  }
  const pattern = buildContainsLikePattern(q);
  const conditions = columns.map((column) => ilike(column, pattern));
  return conditions.length === 1 ? conditions[0] : or(...conditions);
}

/** SHA-256 fingerprint of the sort/filter set a cursor was minted under (stable key order). */
export function computeListFilterFingerprint(parts: {
  q: string | undefined;
  sort: string;
  order: 'asc' | 'desc';
}): string {
  const normalized = { q: parts.q ?? '', sort: parts.sort, order: parts.order };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** A sortable column plus how to read its cursor `sort_value` from a result row (text sorts only). */
export interface KeysetSortColumn<Row> {
  column: AnyColumn;
  kind: 'text' | 'created_at';
  /** Extract the sort value for the opaque cursor (required for `kind: 'text'`). */
  getSortValue?: (row: Row) => string;
}

/**
 * Resolves a validated `(sort, order)` into the Drizzle `ORDER BY`, the matching keyset `WHERE`
 * condition, and a `sort_value` extractor — reusing the `pagination.util.ts` keyset builders. A
 * cursor whose `filter_fingerprint` doesn't match the current query is treated as absent (resets to
 * the first page). `idColumn` always tie-breaks ascending (matching the keyset builders).
 */
export function resolveKeysetSort<Row>(args: {
  columns: Record<string, KeysetSortColumn<Row>>;
  idColumn: AnyColumn;
  defaultSort: string;
  sort: string | undefined;
  order?: 'asc' | 'desc' | undefined;
  q?: string | undefined;
  after: string | undefined;
}): {
  sortField: string;
  orderBy: SQL[];
  cursorCondition: SQL | undefined;
  sortValueFor: (row: Row) => string | undefined;
  filterFingerprint: string;
} {
  const sortField = args.sort ?? args.defaultSort;
  const spec = args.columns[sortField] ?? args.columns[args.defaultSort];
  if (!spec) {
    throw new Error(
      `No keyset sort column configured for "${sortField}" or default "${args.defaultSort}"`,
    );
  }
  // `order` is optional at the boundary (so OpenAPI emits an optional param); default to ascending.
  const effectiveOrder = args.order ?? 'asc';
  const filterFingerprint = computeListFilterFingerprint({
    q: args.q,
    sort: sortField,
    order: effectiveOrder,
  });

  // Ignore a cursor minted under a different sort/filter — restart rather than interleave pages.
  let cursor: ParsedListCursor | null = parseListCursor(args.after);
  if (cursor?.filter_fingerprint !== undefined && cursor.filter_fingerprint !== filterFingerprint) {
    cursor = null;
  }

  const { column, kind } = spec;
  const idAsc = asc(args.idColumn);
  const sortValueFor: (row: Row) => string | undefined =
    kind === 'text' && spec.getSortValue ? spec.getSortValue : () => undefined;

  if (kind === 'created_at') {
    return effectiveOrder === 'desc'
      ? {
          sortField,
          orderBy: [desc(column), desc(args.idColumn)],
          cursorCondition: buildDescendingCreatedAtIdCursorCondition(column, args.idColumn, cursor),
          sortValueFor,
          filterFingerprint,
        }
      : {
          sortField,
          orderBy: [asc(column), idAsc],
          cursorCondition: buildAscendingCreatedAtIdCursorCondition(column, args.idColumn, cursor),
          sortValueFor,
          filterFingerprint,
        };
  }

  // text keyset — id tie-break stays ascending in both directions (matches the text keyset builders)
  return effectiveOrder === 'desc'
    ? {
        sortField,
        orderBy: [desc(column), idAsc],
        cursorCondition: buildDescendingTextIdCursorCondition(column, args.idColumn, cursor),
        sortValueFor,
        filterFingerprint,
      }
    : {
        sortField,
        orderBy: [asc(column), idAsc],
        cursorCondition: buildAscendingTextIdCursorCondition(column, args.idColumn, cursor),
        sortValueFor,
        filterFingerprint,
      };
}

/**
 * Turns a `limit + 1` fetch into a page result: slices to `limit`, computes `has_more`, and mints
 * the next opaque cursor (embedding `sort_value` + `filter_fingerprint`). Rows must expose
 * `created_at` + `id` for the cursor.
 */
export function finishKeysetPage<Row extends { created_at: Date; id: number; public_id?: string }>(
  rows: Row[],
  args: {
    limit: number;
    sortValueFor: (row: Row) => string | undefined;
    filterFingerprint: string;
  },
): { items: Row[]; total: null; limit: number; has_more: boolean; next_cursor: string | null } {
  const hasMore = rows.length > args.limit;
  const items = hasMore ? rows.slice(0, args.limit) : rows;
  const last = items.at(-1);
  let next_cursor: string | null = null;
  if (hasMore && last !== undefined) {
    const sortValue = args.sortValueFor(last);
    // exactOptionalPropertyTypes: omit undefined-valued optional keys rather than pass `undefined`.
    next_cursor = createOpaqueCursorFromRow({
      created_at: last.created_at,
      id: last.id,
      ...(last.public_id !== undefined ? { public_id: last.public_id } : {}),
      ...(sortValue !== undefined ? { sort_value: sortValue } : {}),
      filter_fingerprint: args.filterFingerprint,
    });
  }
  return { items, total: null, limit: args.limit, has_more: hasMore, next_cursor };
}
