/**
 * Cursor pagination conventions for OpenAPI generation and completeness tests.
 *
 * @see docs/reference/api/api-versioning.md — Cursor list pagination
 */
import { PAGINATION } from '@/shared/constants/index.js';

/** Appended to list-operation descriptions in route metadata. */
export const CURSOR_PAGINATION_DESCRIPTION_SUFFIX = ` Uses cursor pagination: pass \`limit\` (default ${PAGINATION.DEFAULT_LIMIT}, max ${PAGINATION.MAX_LIMIT}) and optional \`after\` (opaque cursor from the previous response \`meta.pagination.next\`). The legacy \`page\` query parameter is no longer supported and returns HTTP 400.`;

/**
 * GET list routes that use cursor pagination (`cursorPaginationSchema` or extensions).
 * Keys: "METHOD /openapi/path" (with `{param}` placeholders).
 */
export const CURSOR_PAGINATED_LIST_ROUTE_KEYS = [
  'GET /api/v1/audit/logs',
  'GET /api/v1/users',
  'GET /api/v1/users/me/organizations',
  'GET /api/v1/tenancy/organization/audit-logs',
  'GET /api/v1/tenancy/organization/api-keys',
  'GET /api/v1/tenancy/organization/memberships',
  'GET /api/v1/tenancy/organization/roles',
  'GET /api/v1/notify/notifications',
] as const;

export type CursorPaginatedListRouteKey = (typeof CURSOR_PAGINATED_LIST_ROUTE_KEYS)[number];
