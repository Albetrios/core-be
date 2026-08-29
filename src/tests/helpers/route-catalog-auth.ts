import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type RouteCatalogAccess = 'AUTH' | 'ROLE' | 'PERM' | 'TOKEN';

export type ProtectedRouteFromCatalog = {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  access: RouteCatalogAccess;
};

const ROUTE_CATALOG_PATH = join(process.cwd(), 'docs', 'routes.txt');

// Path, then the optional columnar S/I/O block (success status · idempotency ·
// organization scope), then the access token. The middle block is optional so this
// matches both the legacy `PATH ACCESS` and the columnar `PATH S I O ACCESS`
// catalog formats.
const ROUTE_LINE_PATTERN =
  /^\s+(GET|POST|PATCH|PUT|DELETE)\s+(\S+)\s+(?:(?:\d{3}|\?\?\?)\s+(?:req|-)\s+(?:both|team)\s+)?(PUBLIC|AUTH|ROLE:|PERM:|TOKEN:)/;

/** Placeholder for path params (21-char public_id style). */
const PATH_PARAM_PLACEHOLDER = '000000000000000000000';

/**
 * Replaces OpenAPI-style path params with a stable placeholder for smoke requests.
 */
export function materializeRouteCatalogPath(path: string): string {
  return path.replace(/:[a-zA-Z_]+/g, PATH_PARAM_PLACEHOLDER).replace(/\/+$/, '') || '/';
}

/**
 * Parses docs/routes.txt for routes that require authentication (AUTH, ROLE, or PERM).
 */
export function loadProtectedRoutesFromCatalog(
  catalogPath: string = ROUTE_CATALOG_PATH,
): ProtectedRouteFromCatalog[] {
  const content = readFileSync(catalogPath, 'utf-8');
  const routes: ProtectedRouteFromCatalog[] = [];
  const seen = new Set<string>();

  for (const line of content.split('\n')) {
    const match = ROUTE_LINE_PATTERN.exec(line);
    if (!match) continue;

    const methodRaw = match[1];
    const rawPath = match[2];
    const accessToken = match[3];
    if (!(methodRaw && rawPath && accessToken)) continue;
    if (accessToken === 'PUBLIC') continue;

    const method = methodRaw.toLowerCase() as ProtectedRouteFromCatalog['method'];
    const access: RouteCatalogAccess =
      accessToken === 'AUTH'
        ? 'AUTH'
        : accessToken.startsWith('ROLE')
          ? 'ROLE'
          : accessToken.startsWith('TOKEN')
            ? 'TOKEN'
            : 'PERM';

    const path = materializeRouteCatalogPath(rawPath);
    const key = `${method}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    routes.push({ method, path, access });
  }

  return routes;
}
