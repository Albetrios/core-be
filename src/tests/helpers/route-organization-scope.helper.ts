import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Organization scope of a route: `both` (works for any organization) or `team` (422 on a personal organization). */
export type OrgScope = 'both' | 'team';

/** Map of `"METHOD /full/path"` catalog keys to the route's organization scope. */
export type RouteOrgScopeMap = Record<string, OrgScope>;

/** Org-scope values a route may declare; anything else fails `pnpm validate:route-organization-scope`. */
export const ALLOWED_ORG_SCOPES: ReadonlySet<OrgScope> = new Set<OrgScope>(['both', 'team']);

const ROUTE_ORG_SCOPE_PATH = join(
  process.cwd(),
  'tooling',
  'openapi',
  'route-catalog',
  'route-organization-scope.json',
);

/**
 * Builds the canonical lookup key for a catalog route (`"METHOD /full/path"`),
 * matching the key format of `route-organization-scope.json` and `route-success-statuses.json`.
 */
export function routeOrgScopeKey(options: { method: string; path: string }): string {
  return `${options.method.toUpperCase()} ${options.path}`;
}

/**
 * Loads the committed per-route organization-scope map
 * (`tooling/openapi/route-catalog/route-organization-scope.json`).
 *
 * The map is the source of truth for the catalog's `O` column; the
 * `pnpm validate:route-organization-scope` gate keeps it in exact sync with
 * `docs/routes.txt`.
 */
export function loadRouteOrgScopeMap(mapPath: string = ROUTE_ORG_SCOPE_PATH): RouteOrgScopeMap {
  return JSON.parse(readFileSync(mapPath, 'utf-8')) as RouteOrgScopeMap;
}
